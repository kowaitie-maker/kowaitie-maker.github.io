import { CHROME_UA, CookieJar, ensureOk, parseJson, request } from '../net.js';
import { FetchError, asFetchError, combineErrors } from '../errors.js';
import { findKey, firstStr, num, scriptJson, str } from '../util.js';

const WEB = 'https://www.tiktok.com';
const WEEK = 7 * 86_400_000;
/** Refresh profile details (avatar, followers) from the profile page at most this often. */
const PROFILE_TTL = 24 * 3600_000;

/** TikTok ids carry the upload time in their upper 32 bits. */
export function tiktokIdToMs(id) {
  try {
    const s = Number(BigInt(String(id)) >> 32n);
    return s > 1_400_000_000 && s < 4_000_000_000 ? s * 1000 : null;
  } catch {
    return null;
  }
}

export function postUrl(username, id, kind) {
  return `${WEB}/@${username}/${kind === 'photo' ? 'photo' : 'video'}/${id}`;
}

/** Official TikTok embed player (developers.tiktok.com/doc/embed-player). */
export function embedUrl(postId, kind) {
  if (kind === 'photo') return `https://www.tiktok.com/embed/v2/${postId}`;
  return `https://www.tiktok.com/player/v1/${postId}?autoplay=1&loop=1&music_info=1&description=1&rel=0&native_context_menu=1`;
}

/** Normalise one web "item" (item_list API, profile page, embed page) to our post shape. */
export function parseItem(item, username) {
  if (!item || typeof item !== 'object') return null;
  const id = str(item.id) || (num(item.id) ? String(item.id) : null);
  if (!id || !/^\d{5,25}$/.test(id)) return null;
  const isPhoto = !!item.imagePost;
  const video = item.video || {};
  const stats = item.stats || {};
  const stats2 = item.statsV2 || {};
  const stat = (k) => num(stats[k]) ?? num(stats2[k]) ?? num(item[k]);
  const created = num(item.createTime);
  const photoCover = isPhoto
    ? firstStr(item.imagePost?.cover?.imageURL?.urlList, item.imagePost?.images?.[0]?.imageURL?.urlList)
    : null;
  return {
    postId: id,
    url: postUrl(username, id, isPhoto ? 'photo' : 'video'),
    createdAt: created ? created * 1000 : tiktokIdToMs(id),
    caption: str(item.desc) || '',
    kind: isPhoto ? 'photo' : 'video',
    coverUrl: firstStr(photoCover, video.cover, video.originCover, item.cover, item.coverUrl, item.originCover, video.dynamicCover),
    duration: num(video.duration) || num(item.duration) || null,
    stats: {
      views: stat('playCount'),
      likes: stat('diggCount'),
      comments: stat('commentCount'),
      shares: stat('shareCount'),
    },
    pinned: !!item.isPinned,
  };
}

function profileFromUserInfo(userInfo) {
  const u = userInfo?.user || userInfo || {};
  const st = userInfo?.stats || userInfo?.statsV2 || u.stats || {};
  return {
    displayName: str(u.nickname),
    avatarUrl: firstStr(u.avatarLarger, u.avatarMedium, u.avatarThumb, u.avatarThumbUrl, u.avatarUrl),
    followers: num(st.followerCount) ?? num(u.followerCount),
    postsCount: num(st.videoCount) ?? num(u.videoCount),
    bio: str(u.signature) || '',
    verified: !!u.verified,
    meta: { secUid: str(u.secUid), userId: str(u.id) },
  };
}

function profileFromItems(rawItems) {
  const item = rawItems.find((i) => i?.author && typeof i.author === 'object');
  if (!item) return null;
  const p = profileFromUserInfo({ user: item.author, stats: item.authorStats || item.authorStatsV2 });
  return p.displayName || p.avatarUrl ? p : null;
}

/** Random throwaway headers — the same trick yt-dlp uses to dodge naive 403 fingerprinting. */
function noiseHeaders() {
  const letters = 'bcdfghjklmnpqrstvwxz';
  const word = (a, b) => Array.from({ length: a + Math.floor(Math.random() * (b - a + 1)) }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  const out = {};
  for (let i = 0, n = 2 + Math.floor(Math.random() * 4); i < n; i++) out[word(8, 16)] = word(16, 28);
  return out;
}

function randomDeviceId() {
  const lo = 7250000000000000000n;
  const span = 75099899999994577n;
  const r = BigInt(Math.floor(Math.random() * 2 ** 52)) * span / BigInt(2 ** 52);
  return String(lo + r);
}

/** Profile page → profile info + secUid (and occasionally a few items). */
export async function fetchProfilePage(username, ctx, jar) {
  const S = 'profile';
  let lastError = null;
  for (const ua of [CHROME_UA, 'Mozilla/5.0']) {
    const res = await request(`${ctx.origins.tiktok}/@${username}?lang=en`, {
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...noiseHeaders() },
      jar,
      strategy: S,
    });
    if (/^\/login/.test(new URL(res.url).pathname)) throw new FetchError('login', 'redirected to login', S);
    if (res.status === 404) throw new FetchError('not_found', 'HTTP 404', S);
    ensureOk(res, S);
    const scope = scriptJson(res.text, '__UNIVERSAL_DATA_FOR_REHYDRATION__')?.__DEFAULT_SCOPE__;
    const detail = scope?.['webapp.user-detail'];
    if (detail) {
      const code = num(detail.statusCode) ?? 0;
      const userInfo = detail.userInfo;
      if ([10202, 10221].includes(code)) throw new FetchError('not_found', `statusCode ${code}`, S);
      if (!userInfo?.user) {
        if (code === 10222) throw new FetchError('private', 'statusCode 10222', S);
        throw new FetchError('blocked', `no userInfo (statusCode ${code})`, S);
      }
      const profile = profileFromUserInfo(userInfo);
      if (code === 10222 && !profile.postsCount) throw new FetchError('private', 'private account', S);
      const posts = (userInfo.itemList || []).map((i) => parseItem(i, username)).filter(Boolean);
      return { profile, posts };
    }
    const sigi = scriptJson(res.text, 'SIGI_STATE') || scriptJson(res.text, 'sigi-persisted-data');
    const sigiUser = sigi?.UserModule?.users && Object.values(sigi.UserModule.users)[0];
    if (sigiUser) {
      const stats = sigi.UserModule.stats?.[sigiUser.uniqueId];
      return { profile: profileFromUserInfo({ user: sigiUser, stats }), posts: [] };
    }
    lastError = new FetchError('blocked', `no profile data in page (${res.text.length} bytes)`, S);
  }
  throw lastError;
}

/**
 * The creator item_list web API (same endpoint yt-dlp uses). Returns newest first.
 * Pages back until posts are older than `since`.
 */
export async function fetchItemList(username, secUid, ctx, jar, { needLatest = false } = {}) {
  const S = 'api';
  const deviceId = randomDeviceId();
  const raw = [];
  const seen = new Set();
  let cursor = ctx.now();
  let emptyPages = 0;
  for (let page = 0; page < 8; page++) {
    const q = new URLSearchParams({
      aid: '1988', app_language: 'en', app_name: 'tiktok_web', browser_language: 'en-US', browser_name: 'Mozilla',
      browser_online: 'true', browser_platform: 'Win32', browser_version: '5.0 (Windows)', channel: 'tiktok_web',
      cookie_enabled: 'true', count: '15', cursor: String(cursor), device_id: deviceId, device_platform: 'web_pc',
      focus_state: 'true', from_page: 'user', history_len: '2', is_fullscreen: 'false', is_page_visible: 'true',
      language: 'en', os: 'windows', priority_region: '', referer: '', region: 'US', screen_height: '1080',
      screen_width: '1920', secUid, type: '1', tz_name: 'UTC',
      verifyFp: `verify_${Math.random().toString(16).slice(2, 9)}`, webcast_language: 'en',
    });
    const res = await request(`${ctx.origins.tiktok}/api/creator/item_list/?${q}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json, text/plain, */*', Referer: `${WEB}/@${username}` },
      jar,
      strategy: S,
    });
    ensureOk(res, S);
    const json = parseJson(res, S);
    const code = num(json.statusCode);
    if (code === null && !Array.isArray(json.itemList)) throw new FetchError('blocked', 'unexpected response shape', S);
    if (code) throw new FetchError(code === 10222 ? 'private' : 'blocked', `statusCode ${code} ${json.statusMsg || ''}`.trim(), S);

    const items = (json.itemList || []).filter((i) => i?.id && !seen.has(String(i.id)));
    if (json.itemList?.length && !items.length) break; // API repeated the same page
    for (const i of items) seen.add(String(i.id));
    raw.push(...items);

    const lastMs = items.length ? (num(items.at(-1).createTime) ?? 0) * 1000 || tiktokIdToMs(items.at(-1).id) : null;
    if (!json.hasMorePrevious) break;
    if (lastMs) {
      if (lastMs < ctx.since) break; // everything older is before the follow date
      cursor = lastMs < cursor ? lastMs : cursor - WEEK;
    } else {
      // Nothing in this ~1 week window; step back a week.
      emptyPages++;
      cursor -= WEEK;
      const stillUseful = cursor > ctx.since || (needLatest && !raw.length && emptyPages < 4);
      if (!stillUseful) break;
    }
  }
  return { posts: raw.map((i) => parseItem(i, username)).filter(Boolean), profile: profileFromItems(raw) };
}

/** Creator embed page (tiktok.com/embed/@user): lists the latest videos without signatures. */
export async function fetchEmbedPage(username, ctx) {
  const S = 'embed';
  const res = await request(`${ctx.origins.tiktok}/embed/@${username}`, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,*/*;q=0.8' },
    strategy: S,
  });
  if (res.status === 404) throw new FetchError('not_found', 'HTTP 404', S);
  ensureOk(res, S);
  const state = scriptJson(res.text, '__FRONTITY_CONNECT_STATE__');
  const data = state?.source?.data && Object.values(state.source.data).find((d) => d && Array.isArray(d.videoList));
  if (!data) throw new FetchError('blocked', 'no videoList in embed page (private or embedding disabled)', S);
  const userInfo = data.userInfo || data.user || findKey(state, 'userInfo', (v) => v && typeof v === 'object') || {};
  const profile = profileFromUserInfo(userInfo.user ? userInfo : { user: userInfo, stats: userInfo.stats });
  profile.meta.secUid ||= findKey(state, 'secUid', (v) => typeof v === 'string' && v.startsWith('MS4w')) || null;
  const posts = data.videoList.map((v) => parseItem(v, username)).filter(Boolean);
  return { profile, posts };
}

/** yt-dlp `-J --flat-playlist` output → posts. */
export function parseYtdlpPlaylist(json, username) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const posts = entries
    .map((e) => {
      const id = str(e?.id);
      if (!id || !/^\d{5,25}$/.test(id)) return null;
      const thumbs = Array.isArray(e.thumbnails) ? [...e.thumbnails].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0)) : [];
      const isPhoto = /\/photo\//.test(e.url || e.webpage_url || '');
      return {
        postId: id,
        url: postUrl(username, id, isPhoto ? 'photo' : 'video'),
        createdAt: num(e.timestamp) ? num(e.timestamp) * 1000 : tiktokIdToMs(id),
        caption: str(e.description) || str(e.title) || '',
        kind: isPhoto ? 'photo' : 'video',
        coverUrl: firstStr(e.thumbnail, thumbs.map((t) => t.url)),
        duration: num(e.duration),
        stats: { views: num(e.view_count), likes: num(e.like_count), comments: num(e.comment_count), shares: num(e.repost_count) },
        pinned: false,
      };
    })
    .filter(Boolean);
  const first = entries.find((e) => e?.channel);
  const profile = {
    displayName: str(first?.channel) || null,
    avatarUrl: null,
    followers: null,
    postsCount: null,
    bio: '',
    verified: false,
    meta: { secUid: str(json?.id)?.startsWith('MS4w') ? json.id : str(first?.channel_id), userId: str(first?.uploader_id) },
  };
  return { profile, posts };
}

/**
 * Fetch an account's recent TikTok posts, trying several strategies in turn.
 * @returns {Promise<{profile, posts, strategy, profileRefreshed:boolean}>}
 */
export async function fetchTikTok(account, ctx) {
  const username = account.username;
  const errors = [];
  const jar = new CookieJar();
  let profile = null;
  let profileRefreshed = false;
  let secUid = account.meta?.secUid || null;

  const profileStale = !secUid || !account.profileAt || ctx.now() - account.profileAt > PROFILE_TTL;
  if (profileStale) {
    try {
      const r = await fetchProfilePage(username, ctx, jar);
      profile = r.profile;
      profileRefreshed = true;
      secUid = r.profile.meta.secUid || secUid;
      if (r.profile.postsCount === 0) return { profile, posts: [], strategy: 'profile', profileRefreshed };
    } catch (err) {
      const e = asFetchError(err, 'profile');
      if (e.kind === 'not_found' || e.kind === 'private') throw e;
      errors.push(e);
    }
  }

  const attempts = [];
  if (secUid) attempts.push(['api', () => fetchItemList(username, secUid, ctx, jar, { needLatest: !account.latestPostAt })]);
  attempts.push(['embed', () => fetchEmbedPage(username, ctx)]);
  if (ctx.ytdlp) {
    attempts.push(['yt-dlp', async () => parseYtdlpPlaylist(await ctx.ytdlp.playlist(`${WEB}/@${username}`, 20), username)]);
  }
  if (ctx.browser) attempts.push(['browser', () => viaBrowser(username, ctx)]);

  for (const [name, run] of attempts) {
    try {
      const r = await run();
      const merged = mergeProfile(profile, r.profile);
      if (secUid && merged) merged.meta.secUid ||= secUid;
      return { profile: merged, posts: r.posts, strategy: name, profileRefreshed: profileRefreshed || name === 'browser' };
    } catch (err) {
      errors.push(asFetchError(err, name));
    }
  }
  throw combineErrors(errors);
}

async function viaBrowser(username, ctx) {
  const S = 'browser';
  const { jsons, html } = await ctx.browser.capture(`${WEB}/@${username}`, {
    match: (u) => /\/api\/(post|creator)\/item_list/.test(u),
  });
  const raw = jsons.flatMap((j) => (Array.isArray(j?.itemList) ? j.itemList : []));
  const detail = scriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  const profile = detail?.userInfo?.user ? profileFromUserInfo(detail.userInfo) : profileFromItems(raw);
  raw.push(...(detail?.userInfo?.itemList || []));
  if (!raw.length) {
    if (profile?.postsCount === 0) return { profile, posts: [] };
    if (num(detail?.statusCode) === 10222) throw new FetchError('private', 'private account', S);
    throw new FetchError('blocked', 'browser saw no videos (captcha or login wall?)', S);
  }
  return { profile, posts: raw.map((i) => parseItem(i, username)).filter(Boolean) };
}

/** Prefer fields from `a`, fill gaps from `b`. */
export function mergeProfile(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...b, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
  out.meta = { ...(b.meta || {}), ...Object.fromEntries(Object.entries(a.meta || {}).filter(([, v]) => v)) };
  return out;
}
