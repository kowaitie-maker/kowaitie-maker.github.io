import fs from 'node:fs';
import path from 'node:path';
import { CHROME_UA, ensureOk, parseJson, request } from '../net.js';
import { FetchError, asFetchError, combineErrors } from '../errors.js';
import { findKey, firstStr, num, str } from '../util.js';
import { mergeProfile } from './tiktok.js';

const WEB_APP_ID = '936619743392459';
const ANDROID_APP_ID = '567067343352427';
const ANDROID_UA =
  'Instagram 361.0.0.46.88 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_US; 674675155)';

export function postUrl(code, kind) {
  return `https://www.instagram.com/${kind === 'reel' ? 'reel' : 'p'}/${code}/`;
}

export function embedUrl(code) {
  return `https://www.instagram.com/p/${code}/embed/`;
}

/** Post node from the web GraphQL shape (web_profile_info). */
export function parseGraphNode(node) {
  const code = str(node?.shortcode);
  if (!code) return null;
  const ts = num(node.taken_at_timestamp) ?? num(node.taken_at);
  const kind = node.product_type === 'clips'
    ? 'reel'
    : node.is_video || node.__typename === 'GraphVideo'
      ? 'video'
      : node.__typename === 'GraphSidecar'
        ? 'carousel'
        : 'image';
  return {
    postId: code,
    url: postUrl(code, kind),
    createdAt: ts ? ts * 1000 : null,
    caption: str(node.edge_media_to_caption?.edges?.[0]?.node?.text) || '',
    kind,
    coverUrl: firstStr(node.display_url, node.thumbnail_src, node.thumbnail_resources?.at?.(-1)?.src),
    duration: num(node.video_duration),
    stats: {
      views: num(node.video_view_count) ?? num(node.video_play_count),
      likes: num(node.edge_liked_by?.count) ?? num(node.edge_media_preview_like?.count),
      comments: num(node.edge_media_to_comment?.count),
      shares: null,
    },
    pinned: Array.isArray(node.pinned_for_users) && node.pinned_for_users.length > 0,
  };
}

/** Post item from the private/mobile API shape (feed/user, xdt_api timeline). */
export function parseV1Item(item) {
  const code = str(item?.code);
  if (!code) return null;
  const mediaType = num(item.media_type);
  const kind = item.product_type === 'clips' ? 'reel' : mediaType === 2 ? 'video' : mediaType === 8 ? 'carousel' : 'image';
  const ts = num(item.taken_at);
  return {
    postId: code,
    url: postUrl(code, kind),
    createdAt: ts ? ts * 1000 : null,
    caption: str(item.caption?.text) || '',
    kind,
    coverUrl: firstStr(
      item.image_versions2?.candidates?.[0]?.url,
      item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url,
      item.display_uri,
      item.thumbnail_url,
    ),
    duration: num(item.video_duration),
    stats: {
      views: num(item.play_count) ?? num(item.ig_play_count) ?? num(item.view_count),
      likes: num(item.like_count),
      comments: num(item.comment_count),
      shares: null,
    },
    pinned: Array.isArray(item.timeline_pinned_user_ids) && item.timeline_pinned_user_ids.length > 0,
  };
}

function profileFromUser(user) {
  if (!user) return null;
  return {
    displayName: str(user.full_name) || str(user.username),
    avatarUrl: firstStr(user.profile_pic_url_hd, user.hd_profile_pic_url_info?.url, user.profile_pic_url),
    followers: num(user.edge_followed_by?.count) ?? num(user.follower_count),
    postsCount: num(user.edge_owner_to_timeline_media?.count) ?? num(user.media_count),
    bio: str(user.biography) || '',
    verified: !!user.is_verified,
    hasStory: typeof user.has_public_story === 'boolean' ? user.has_public_story : null,
    meta: { userId: str(user.id) || (num(user.pk) ? String(user.pk) : str(user.pk)) },
  };
}

/** web_profile_info `data.user` → { profile, posts, isPrivate }. */
export function parseProfileUser(user) {
  const posts = (user?.edge_owner_to_timeline_media?.edges || []).map((e) => parseGraphNode(e?.node)).filter(Boolean);
  return { profile: profileFromUser(user), posts, isPrivate: !!user?.is_private };
}

function webHeaders(username, settings) {
  const h = {
    'User-Agent': CHROME_UA,
    'X-IG-App-ID': WEB_APP_ID,
    'X-ASBD-ID': '359341',
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    Referer: `https://www.instagram.com/${username}/`,
  };
  if (settings?.igSessionId) h.Cookie = `sessionid=${settings.igSessionId}`;
  return h;
}

function checkIgResponse(res, S) {
  if (res.status >= 300 && res.status < 400) {
    const to = res.location || '';
    throw new FetchError(/login|challenge/i.test(to) || to === '/' ? 'login' : 'blocked', `redirect to ${to.slice(0, 60)}`, S);
  }
  if (res.status === 404) throw new FetchError('not_found', 'HTTP 404', S);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const wait = /wait a few minutes|try again later/i.test(res.text || '');
    throw new FetchError(wait ? 'rate_limited' : 'login', `HTTP ${res.status}`, S);
  }
  ensureOk(res, S);
  const json = parseJson(res, S);
  if (json.require_login || json.message === 'login_required') throw new FetchError('login', 'login required', S);
  if (json.status === 'fail') {
    const kind = /wait|try again/i.test(json.message || '') ? 'rate_limited' : 'blocked';
    throw new FetchError(kind, String(json.message || 'status fail').slice(0, 120), S);
  }
  return json;
}

/** Public profile endpoint (works without login, rate limited per IP). */
export async function fetchWebProfileInfo(username, ctx, variant = 'www') {
  const S = variant === 'www' ? 'web' : 'mobile';
  const base = variant === 'www' ? ctx.origins.instagram : ctx.origins.instagramApi;
  const headers = variant === 'www'
    ? webHeaders(username, ctx.settings)
    : { 'User-Agent': ANDROID_UA, 'X-IG-App-ID': ANDROID_APP_ID, Accept: '*/*', ...(ctx.settings?.igSessionId ? { Cookie: `sessionid=${ctx.settings.igSessionId}` } : {}) };
  const res = await request(`${base}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
    headers,
    redirect: 'manual',
    strategy: S,
  });
  const json = checkIgResponse(res, S);
  if (json.data && json.data.user === null) throw new FetchError('not_found', 'user is null', S);
  const user = json.data?.user || json.user;
  if (!user) throw new FetchError('parse', 'no user in response', S);
  const r = parseProfileUser(user);
  if (r.isPrivate && !r.posts.length) throw new FetchError('private', 'private account', S);
  return r;
}

/** Logged-in feed endpoint (needs the user's own sessionid cookie). */
export async function fetchUserFeed(username, ctx) {
  const S = 'feed';
  const res = await request(`${ctx.origins.instagram}/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`, {
    headers: webHeaders(username, ctx.settings),
    redirect: 'manual',
    strategy: S,
  });
  const json = checkIgResponse(res, S);
  if (!Array.isArray(json.items)) throw new FetchError('parse', 'no items in feed response', S);
  const posts = json.items.map(parseV1Item).filter(Boolean);
  return { profile: profileFromUser(json.user || json.items[0]?.user), posts };
}

/** Pull posts out of any JSON Instagram's own web app loads. */
export function postsFromAnyJson(json) {
  const out = { profile: null, posts: [] };
  const user = findKey(json, 'user', (u) => u && typeof u === 'object' && u.edge_owner_to_timeline_media);
  if (user) {
    const r = parseProfileUser(user);
    out.profile = r.profile;
    out.posts.push(...r.posts);
  }
  // Profile embed (instagram.com/<user>/embed/): context.graphql_media[].shortcode_media
  const embedCtx = Array.isArray(json?.graphql_media) ? json : findKey(json, 'context', (c) => c && Array.isArray(c.graphql_media));
  if (embedCtx) {
    out.posts.push(...embedCtx.graphql_media.map((m) => parseGraphNode(m?.shortcode_media || m?.node || m)).filter(Boolean));
    out.profile ||= {
      displayName: str(embedCtx.full_name) || str(embedCtx.username),
      avatarUrl: str(embedCtx.profile_pic_url),
      followers: num(embedCtx.followers_count),
      postsCount: num(embedCtx.posts_count),
      bio: '',
      verified: !!(embedCtx.is_verified || embedCtx.verified),
      // Instagram tells logged-out visitors whether a story is up (not its content).
      hasStory: typeof embedCtx.has_public_story === 'boolean' ? embedCtx.has_public_story : null,
      meta: {
        userId: str(embedCtx.owner_id) || (num(embedCtx.owner_id) ? String(embedCtx.owner_id) : null)
          || str(embedCtx.graphql_media?.[0]?.shortcode_media?.owner?.id),
      },
    };
  }
  const conn = findKey(json, 'xdt_api__v1__feed__user_timeline_graphql_connection', (c) => c && Array.isArray(c.edges));
  if (conn) {
    out.posts.push(...conn.edges.map((e) => parseV1Item(e?.node)).filter(Boolean));
    out.profile ||= profileFromUser(conn.edges.find((e) => e?.node?.user)?.node?.user);
  }
  return out;
}

async function viaBrowser(username, ctx) {
  const S = 'browser';
  const cookies = ctx.settings?.igSessionId
    ? [{ name: 'sessionid', value: ctx.settings.igSessionId, domain: '.instagram.com', path: '/', secure: true, httpOnly: true }]
    : [];
  const match = (u) => /web_profile_info|\/graphql\/query|\/api\/graphql|\/api\/v1\/feed\//.test(u);
  const waitFor = 'a[href*="/p/"], a[href*="/reel/"]';
  let profile = null;
  const posts = new Map();
  const absorb = (r) => {
    profile = mergeProfile(profile, r.profile);
    for (const p of r.posts) if (p.createdAt) posts.set(p.postId, p);
  };
  // The embed page is made for other websites and renders its grid without a login.
  const embed = await ctx.browser.capture(`https://www.instagram.com/${username}/embed/`, { match, cookies, waitFor });
  debugDump(`instagram-embed-rendered-${username}.html`, embed.html);
  for (const j of embed.jsons) absorb(postsFromAnyJson(j));
  absorb(parseProfileEmbed(embed.html, username));
  if (!posts.size) {
    const page = await ctx.browser.capture(`https://www.instagram.com/${username}/`, { match, cookies, waitFor });
    debugDump(`instagram-profile-rendered-${username}.html`, page.html);
    for (const j of page.jsons) absorb(postsFromAnyJson(j));
    absorb(parseProfileEmbed(page.html, username));
  }
  if (!posts.size) throw new FetchError('blocked', 'browser saw no posts (login wall?)', S);
  return { profile, posts: [...posts.values()] };
}

/** Saves raw pages for troubleshooting when RADAR_DEBUG_DIR is set. */
function debugDump(name, text) {
  const dir = process.env.RADAR_DEBUG_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), String(text || '').slice(0, 3_000_000));
  } catch {
    /* debugging only */
  }
}

const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_EPOCH_MS = 1314220021721;

/** Instagram media ids carry their creation time (ms since Instagram's epoch) in the upper bits. */
export function shortcodeToMs(code) {
  let id = 0n;
  for (const ch of String(code).slice(0, 11)) {
    const i = SHORTCODE_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  const ms = Number(id >> 23n) + IG_EPOCH_MS;
  return ms > 1_300_000_000_000 && ms < 4_000_000_000_000 ? ms : null;
}

const decodeEntities = (s) => s
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** Parse the public profile embed page (instagram.com/<user>/embed/), made for other websites. */
export function parseProfileEmbed(html, username) {
  // Embedded JSON first: it may carry the full timeline.
  let fromJson = { profile: null, posts: [] };
  const blobs = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)) blobs.push(m[1]);
  for (const m of html.matchAll(/"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* ignore */
    }
  }
  for (const b of blobs) {
    try {
      const r = postsFromAnyJson(JSON.parse(b));
      fromJson = { profile: fromJson.profile || r.profile, posts: [...fromJson.posts, ...r.posts] };
    } catch {
      /* not JSON */
    }
  }
  if (fromJson.posts.length) return fromJson;

  // Otherwise read the post links and their thumbnails from the markup.
  const posts = new Map();
  const re = /href=["'](?:https?:\/\/(?:www\.)?instagram\.com)?\/(?:[\w.]+\/)?(p|reel|tv)\/([A-Za-z0-9_-]{6,})\/?[^"']*["']/g;
  for (const m of html.matchAll(re)) {
    const code = m[2];
    if (posts.has(code)) continue;
    const after = html.slice(m.index, m.index + 2500);
    const img = after.match(/<img[^>]+src=["']([^"']+)["']/);
    const alt = after.match(/<img[^>]+alt=["']([^"']*)["']/);
    const caption = alt && !/^(photo|video|image) (by|shared by|of)\b/i.test(decodeEntities(alt[1])) ? decodeEntities(alt[1]) : '';
    const kind = m[1] === 'reel' ? 'reel' : 'post';
    posts.set(code, {
      postId: code,
      url: postUrl(code, kind),
      createdAt: shortcodeToMs(code),
      caption,
      kind,
      coverUrl: img ? decodeEntities(img[1]) : null,
      duration: null,
      stats: { views: null, likes: null, comments: null, shares: null },
      pinned: false,
    });
  }
  let avatarUrl = null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/Avatar|ProfilePic|profile picture/i.test(m[0])) continue;
    const src = m[0].match(/\bsrc=["']([^"']+)["']/);
    if (src) {
      avatarUrl = decodeEntities(src[1]);
      break;
    }
  }
  const fullName = html.match(/class=["'][^"']*FullName[^"']*["'][^>]*>([^<]+)</i);
  const profile = {
    displayName: fullName ? decodeEntities(fullName[1]).trim() : null,
    avatarUrl,
    followers: null,
    postsCount: null,
    bio: '',
    verified: false,
    meta: {},
  };
  return { profile: profile.displayName || profile.avatarUrl ? profile : null, posts: [...posts.values()].filter((p) => p.createdAt) };
}

export async function fetchProfileEmbed(username, ctx) {
  const S = 'embed';
  const res = await request(`${ctx.origins.instagram}/${encodeURIComponent(username)}/embed/`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: 'https://www.google.com/' },
    redirect: 'manual',
    strategy: S,
  });
  if (res.status >= 300 && res.status < 400) throw new FetchError('login', `redirect to ${(res.location || '').slice(0, 60)}`, S);
  // A 404 here can mean "profile embeds unavailable", so it never decides that the account doesn't exist.
  if (res.status === 404) throw new FetchError('blocked', 'HTTP 404 from profile embed', S);
  if (res.status === 429) throw new FetchError('rate_limited', 'HTTP 429', S);
  ensureOk(res, S);
  debugDump(`instagram-embed-${username}.html`, res.text);
  const r = parseProfileEmbed(res.text, username);
  if (!r.posts.length) {
    const title = (res.text.match(/<title[^>]*>([^<]*)</i) || [])[1] || '';
    throw new FetchError('blocked', `no posts in embed page (${res.text.length} bytes, title "${title.trim().slice(0, 60)}")`, S);
  }
  return r;
}

/** One story item from feed/reels_media. Picks mid-size renditions to keep files small. */
export function parseStoryItem(item) {
  const id = str(item?.pk) || (num(item?.pk) ? String(item.pk) : null) || str(item?.id)?.split('_')[0];
  if (!id) return null;
  const takenAt = num(item.taken_at) ? item.taken_at * 1000 : null;
  const expiresAt = num(item.expiring_at) ? item.expiring_at * 1000 : takenAt ? takenAt + 86_400_000 : null;
  const near = (target) => (a, b) => Math.abs((a.width || target) - target) - Math.abs((b.width || target) - target);
  const videos = (Array.isArray(item.video_versions) ? item.video_versions : []).filter((v) => str(v?.url));
  const images = (item.image_versions2?.candidates || []).filter((c) => str(c?.url));
  const videoUrl = videos.length ? [...videos].sort(near(720))[0].url : null;
  const imageUrl = images.length ? [...images].sort(near(1080))[0].url : null;
  if (!videoUrl && !imageUrl) return null;
  return { storyId: id, takenAt, expiresAt, kind: videoUrl ? 'video' : 'image', imageUrl, videoUrl, duration: num(item.video_duration) };
}

/** Read a reels_media answer (JSON text) into story items, or explain why it failed. */
export function readStoriesAnswer(status, text, userId, S = 'stories') {
  const body = String(text || '').trim();
  if (body.startsWith('<')) {
    const title = ((body.match(/<title[^>]*>([^<]*)</i) || [])[1] || '').trim().slice(0, 60);
    throw new FetchError('login', `login not accepted (HTTP ${status}, web page "${title}")`, S);
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new FetchError('parse', `invalid answer (HTTP ${status})`, S);
  }
  const msg = String(json.message || '');
  if (/checkpoint/i.test(msg) || json.checkpoint_url) throw new FetchError('login', 'checkpoint_required: Instagram wants the owner to confirm this login', S);
  if (json.require_login || /login_required/i.test(msg) || status === 401) throw new FetchError('login', 'login_required: the session is expired or logged out', S);
  if (status === 429 || /wait a few minutes/i.test(msg)) throw new FetchError('rate_limited', `HTTP ${status} ${msg}`.trim(), S);
  if (status >= 400) throw new FetchError('blocked', `HTTP ${status} ${msg}`.trim(), S);
  const reel = json.reels?.[userId] || (Array.isArray(json.reels_media) ? json.reels_media[0] : null);
  return (Array.isArray(reel?.items) ? reel.items : []).map(parseStoryItem).filter(Boolean);
}

/**
 * The account's current stories. Needs the owner's Instagram login (IG_SESSIONID).
 * Tries a plain request, then a real browser (Instagram often refuses logged-in
 * requests that don't come from a browser).
 */
export async function fetchStories(account, ctx) {
  const S = 'stories';
  const userId = account.meta?.userId;
  if (!userId) throw new FetchError('parse', 'unknown Instagram user id', S);
  try {
    return await fetchStoriesDirect(account, userId, ctx);
  } catch (err) {
    if (!ctx.browser || !(err instanceof FetchError) || !['login', 'blocked'].includes(err.kind)) throw err;
  }
  const cookies = [{ name: 'sessionid', value: ctx.settings.igSessionId, domain: '.instagram.com', path: '/', secure: true, httpOnly: true }];
  // Instagram's own stories page loads the story data by itself (we never press "view").
  let pageError;
  try {
    return await fetchStoriesViaPage(account, userId, ctx, cookies);
  } catch (err) {
    pageError = err;
  }
  const answer = await ctx.browser.evaluate('https://www.instagram.com/', {
    cookies,
    arg: userId,
    // Same headers Instagram's own web app sends.
    fn: async (id) => {
      const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
      let claim = '0';
      try {
        claim = sessionStorage.getItem('www-claim-v2') || '0';
      } catch {
        /* ignore */
      }
      const r = await fetch(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(id)}`, {
        headers: { 'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '359341', 'X-IG-WWW-Claim': claim, 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' },
        credentials: 'include',
      });
      return { status: r.status, text: (await r.text()).slice(0, 3_000_000), loggedIn: /(?:^|; )ds_user_id=/.test(document.cookie), hasCsrf: !!csrf };
    },
  });
  try {
    return readStoriesAnswer(answer.status, answer.text, userId, 'stories-browser');
  } catch (err) {
    if (err instanceof FetchError && pageError) err.detail = `${err.detail}; page: ${pageError.detail || pageError.message}`;
    // Say whether Instagram treated the browser as logged in (no secret values involved).
    if (err instanceof FetchError) {
      if (!answer.loggedIn && err.kind !== 'login') throw new FetchError('login', `login_required: session not accepted in the browser (${err.detail})`, 'stories-browser');
      err.detail = `${err.detail} [browser logged in: ${answer.loggedIn ? 'yes' : 'no'}, csrf: ${answer.hasCsrf ? 'yes' : 'no'}]`;
      err.message = `[${err.strategy}] ${err.kind}: ${err.detail}`;
    }
    throw err;
  }
}

/** Story items found anywhere in a JSON answer (REST or GraphQL "xdt" shapes). */
export function storyItemsFromJson(json, userId) {
  const found = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 14) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
    if (o.image_versions2 && o.taken_at && ('expiring_at' in o || 'story_cta' in o || o.product_type === 'story' || 'reel_mentions' in o || 'story_feed_media' in o || 'viewers' in o)) {
      const owner = String(o.user?.pk ?? o.user?.id ?? o.owner?.pk ?? o.owner?.id ?? '');
      if (!owner || owner === String(userId)) found.push(o);
      return;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(json, 0);
  const items = new Map();
  for (const it of found.map(parseStoryItem).filter(Boolean)) items.set(it.storyId, it);
  return [...items.values()];
}

async function fetchStoriesViaPage(account, userId, ctx, cookies) {
  const S = 'stories-page';
  const match = (u) => /\/graphql\/query|\/api\/graphql|\/api\/v1\/feed\/(reels_media|user\/\d+\/story|reels_tray)/.test(u);
  const until = (jsons) => jsons.some((j) => storyItemsFromJson(j, userId).length);
  // Never tell Instagram the story was watched: drop the "seen" requests the page sends.
  const block = (req) => {
    if (req.method() !== 'POST') return false;
    const name = req.headers()['x-fb-friendly-name'] || '';
    const body = req.postData() || '';
    return /seen/i.test(req.url()) || /seen/i.test(name) || /fb_api_req_friendly_name=[^&]*seen/i.test(body);
  };
  const { jsons, html, blocked, clicked, trace = [] } = await ctx.browser.capture(`https://www.instagram.com/stories/${encodeURIComponent(account.username)}/`, {
    match, cookies, until, block, clickButton: /^view story$/i, waitMs: 14000,
  });
  if (blocked) ctx.log?.(`stories ${account.username}: blocked ${blocked} "seen" request(s)`);
  const items = new Map();
  for (const j of jsons) for (const it of storyItemsFromJson(j, userId)) items.set(it.storyId, it);
  if (items.size) return [...items.values()];
  // Explain what the page did, without copying any of its content.
  const keys = [...new Set(jsons.flatMap((j) => Object.keys(j?.data || j || {})))].slice(0, 6).join(',');
  const gate = /view story|view as/i.test(html || '') ? ', still asks to confirm viewing' : '';
  const steps = [...new Set(trace)].filter((t) => !/logging|falco|bz|ajax\/bootloader/i.test(t)).slice(0, 14).join('; ');
  throw new FetchError('blocked', `no story data on the stories page (${jsons.length} answers${keys ? `: ${keys}` : ''}; pressed view: ${clicked ? 'yes' : 'no'}; blocked seen: ${blocked}${gate}) requests: ${steps}`, S);
}

async function fetchStoriesDirect(account, userId, ctx) {
  const S = 'stories';
  const res = await request(`${ctx.origins.instagram}/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`, {
    headers: { ...webHeaders(account.username, ctx.settings), Origin: 'https://www.instagram.com' },
    redirect: 'manual',
    strategy: S,
  });
  if (res.status >= 300 && res.status < 400) throw new FetchError('login', `redirect to ${(res.location || '').slice(0, 60)}`, S);
  return readStoriesAnswer(res.status, res.text, userId, S);
}

/**
 * Fetch an account's recent Instagram posts, trying several strategies in turn.
 * @returns {Promise<{profile, posts, strategy, profileRefreshed:boolean}>}
 */
export async function fetchInstagram(account, ctx) {
  const username = account.username;
  const errors = [];
  const attempts = [
    ['web', () => fetchWebProfileInfo(username, ctx, 'www')],
    ['mobile', () => fetchWebProfileInfo(username, ctx, 'mobile')],
    ['embed', () => fetchProfileEmbed(username, ctx)],
  ];
  if (ctx.settings?.igSessionId) attempts.push(['feed', () => fetchUserFeed(username, ctx)]);
  if (ctx.browser) attempts.push(['browser', () => viaBrowser(username, ctx)]);

  for (const [name, run] of attempts) {
    try {
      const r = await run();
      // Which earlier routes failed, kept for troubleshooting (no secrets in these).
      const fallbacks = errors.map((e) => `${e.strategy}: ${e.kind} (${String(e.detail).slice(0, 80)})`);
      return { profile: r.profile, posts: r.posts, strategy: name, profileRefreshed: true, fallbacks };
    } catch (err) {
      const e = asFetchError(err, name);
      errors.push(e);
      if (e.kind === 'private') break;
    }
  }
  throw combineErrors(errors);
}
