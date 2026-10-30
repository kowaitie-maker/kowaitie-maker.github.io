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
  const { jsons } = await ctx.browser.capture(`https://www.instagram.com/${username}/`, {
    match: (u) => /web_profile_info|\/graphql\/query|\/api\/graphql/.test(u),
    cookies,
  });
  let profile = null;
  const posts = new Map();
  for (const j of jsons) {
    const r = postsFromAnyJson(j);
    profile = mergeProfile(profile, r.profile);
    for (const p of r.posts) posts.set(p.postId, p);
  }
  if (!posts.size && !profile) throw new FetchError('blocked', 'browser saw no posts (login wall?)', S);
  return { profile, posts: [...posts.values()] };
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
  ];
  if (ctx.settings?.igSessionId) attempts.push(['feed', () => fetchUserFeed(username, ctx)]);
  if (ctx.browser) attempts.push(['browser', () => viaBrowser(username, ctx)]);

  for (const [name, run] of attempts) {
    try {
      const r = await run();
      return { profile: r.profile, posts: r.posts, strategy: name, profileRefreshed: true };
    } catch (err) {
      const e = asFetchError(err, name);
      errors.push(e);
      if (e.kind === 'private') break;
    }
  }
  throw combineErrors(errors);
}
