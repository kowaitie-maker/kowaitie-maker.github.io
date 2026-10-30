// A fake TikTok + Instagram + image CDN that answers with the same JSON/HTML
// shapes the real sites use. Used by unit tests, the browser E2E and demo screenshots.
import http from 'node:http';
import { placeholderPng } from './png.js';

const PALETTES = [
  ['#ff7a59', '#ff2d6f'], ['#6c47ff', '#20c3ff'], ['#0fbf8f', '#2a6cff'], ['#ffb340', '#ff4d6d'],
  ['#8a2be2', '#ff6ec7'], ['#1e3c72', '#2ad0ca'], ['#f857a6', '#ff5858'], ['#43cea2', '#185a9d'],
];

/** TikTok-style id that encodes the creation time (seconds) in its upper 32 bits. */
export function tiktokId(sec, salt = 1) {
  return String((BigInt(sec) << 32n) | BigInt(salt));
}

export function createMockUpstream(config) {
  const state = structuredClone(config);
  state.tiktok ||= [];
  state.instagram ||= [];
  const modes = { tiktokApi: 'ok', tiktokProfile: 'ok', tiktokEmbed: 'ok', igWeb: 'ok', igMobile: 'ok' };
  const hits = [];
  let base = '';
  let saltCounter = 100;

  const img = (name) => `${base}/img/${name}.png`;
  const findTT = (u) => state.tiktok.find((a) => a.username === u);
  const findIG = (u) => state.instagram.find((a) => a.username === u);

  function ttItem(acc, p) {
    return {
      id: p.id,
      desc: p.desc,
      createTime: p.createTime,
      video: { id: p.id, duration: p.duration ?? 21, cover: img(`tt-${p.id}`), originCover: img(`tt-${p.id}`), playAddr: 'https://v16-webapp.tiktok.com/x' },
      author: { id: acc.userId, uniqueId: acc.username, nickname: acc.nickname, avatarLarger: img(`av-${acc.username}`), secUid: acc.secUid, verified: !!acc.verified },
      authorStats: { followerCount: acc.followers, videoCount: acc.posts.length },
      stats: { playCount: p.views ?? 1000, diggCount: p.likes ?? 100, commentCount: p.comments ?? 10, shareCount: 3 },
      statsV2: { playCount: String(p.views ?? 1000), diggCount: String(p.likes ?? 100), commentCount: String(p.comments ?? 10), shareCount: '3' },
      isPinned: !!p.pinned,
    };
  }

  function profileHtml(acc) {
    const scope = {
      __DEFAULT_SCOPE__: {
        'webapp.app-context': { language: 'en' },
        'webapp.user-detail': acc
          ? {
            statusCode: 0,
            userInfo: {
              user: { id: acc.userId, uniqueId: acc.username, nickname: acc.nickname, avatarLarger: img(`av-${acc.username}`), signature: acc.bio || '', verified: !!acc.verified, secUid: acc.secUid, privateAccount: false },
              stats: { followerCount: acc.followers, followingCount: 12, heartCount: 99999, videoCount: acc.posts.length },
              itemList: [],
            },
          }
          : { statusCode: 10221, statusMsg: 'user not exist' },
      },
    };
    return `<!DOCTYPE html><html><head><title>TikTok</title></head><body><div id="app"></div><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(scope)}</script></body></html>`;
  }

  function igUser(acc) {
    return {
      id: acc.userId,
      username: acc.username,
      full_name: acc.fullName,
      biography: acc.bio || '',
      is_private: !!acc.private,
      is_verified: !!acc.verified,
      profile_pic_url: img(`av-${acc.username}`),
      profile_pic_url_hd: img(`av-${acc.username}`),
      edge_followed_by: { count: acc.followers },
      edge_follow: { count: 300 },
      edge_owner_to_timeline_media: {
        count: acc.posts.length,
        page_info: { has_next_page: false, end_cursor: null },
        edges: [...acc.posts].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.taken_at - a.taken_at).slice(0, 12).map((p) => ({
          node: {
            __typename: p.type === 'video' || p.type === 'reel' ? 'GraphVideo' : p.type === 'carousel' ? 'GraphSidecar' : 'GraphImage',
            id: p.id || p.shortcode,
            shortcode: p.shortcode,
            taken_at_timestamp: p.taken_at,
            display_url: img(`ig-${p.shortcode}`),
            thumbnail_src: img(`ig-${p.shortcode}`),
            is_video: p.type === 'video' || p.type === 'reel',
            product_type: p.type === 'reel' ? 'clips' : 'feed',
            video_view_count: p.views ?? null,
            video_duration: p.duration ?? null,
            edge_media_to_caption: { edges: p.caption ? [{ node: { text: p.caption } }] : [] },
            edge_liked_by: { count: p.likes ?? 50 },
            edge_media_preview_like: { count: p.likes ?? 50 },
            edge_media_to_comment: { count: p.comments ?? 5 },
            pinned_for_users: p.pinned ? [{ id: acc.userId }] : [],
          },
        })),
      },
    };
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push(`${req.method} ${url.pathname}`);
    const p = url.pathname;

    if (req.method === 'POST' && p === '/__add') {
      let body = '';
      for await (const c of req) body += c;
      const { platform, username, ...post } = JSON.parse(body || '{}');
      const now = Math.floor(Date.now() / 1000);
      if (platform === 'tiktok') {
        const acc = findTT(username);
        acc.posts.unshift({ id: tiktokId(now, saltCounter++), createTime: now, desc: post.desc || 'منشور جديد', views: 12, likes: 3, comments: 0, ...post });
      } else {
        const acc = findIG(username);
        acc.posts.unshift({ shortcode: `NEW${saltCounter++}`, taken_at: now, caption: post.caption || 'منشور جديد', type: 'reel', likes: 4, ...post });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/__mode') {
      let body = '';
      for await (const c of req) body += c;
      Object.assign(modes, JSON.parse(body || '{}'));
      return json(res, 200, modes);
    }

    if (p.startsWith('/img/')) {
      const name = p.slice(5).replace(/\.png$/, '');
      let h = 0;
      for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const [from, to] = PALETTES[h % PALETTES.length];
      const isAvatar = name.startsWith('av-');
      const buf = placeholderPng(isAvatar ? 96 : 216, isAvatar ? 96 : 384, from, to, h % 97);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      return res.end(buf);
    }

    // ——— TikTok ———
    let m = p.match(/^\/@([\w.]+)$/);
    if (m) {
      if (modes.tiktokProfile === 'blocked') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Please wait...</body></html>');
      }
      const acc = findTT(m[1]);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(profileHtml(acc));
    }
    if (p === '/api/creator/item_list/') {
      if (modes.tiktokApi === 'blocked') return json(res, 200, '');
      const acc = state.tiktok.find((a) => a.secUid === url.searchParams.get('secUid'));
      if (!acc) return json(res, 200, { statusCode: 10201, statusMsg: 'invalid secUid' });
      const cursor = Number(url.searchParams.get('cursor'));
      const count = Number(url.searchParams.get('count') || 15);
      const older = acc.posts.filter((x) => x.createTime * 1000 < cursor).sort((a, b) => b.createTime - a.createTime);
      // Mimic TikTok's ~1 week lookback window per page.
      const windowed = older.filter((x) => x.createTime * 1000 >= cursor - 7 * 86400000);
      const page = windowed.slice(0, count);
      return json(res, 200, { statusCode: 0, itemList: page.map((x) => ttItem(acc, x)), hasMorePrevious: older.length > page.length, hasMoreLatest: false, cursor: String(cursor) });
    }
    m = p.match(/^\/embed\/@([\w.]+)$/);
    if (m) {
      const acc = findTT(m[1]);
      if (!acc || modes.tiktokEmbed === 'blocked') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>unavailable</body></html>');
      }
      const state2 = {
        source: {
          data: {
            [`/embed/@${acc.username}`]: {
              userInfo: { uniqueId: acc.username, nickname: acc.nickname, avatarThumbUrl: img(`av-${acc.username}`), followerCount: acc.followers, videoCount: acc.posts.length, secUid: acc.secUid },
              videoList: acc.posts.slice(0, 10).map((x) => ({ id: x.id, desc: x.desc, coverUrl: img(`tt-${x.id}`), playCount: x.views })),
            },
          },
        },
      };
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<html><body><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state2)}</script></body></html>`);
    }

    // ——— Instagram ———
    if (p === '/api/v1/users/web_profile_info/') {
      const isMobile = /Instagram \d/.test(req.headers['user-agent'] || '');
      const mode = isMobile ? modes.igMobile : modes.igWeb;
      if (mode === 'login') {
        res.writeHead(302, { Location: '/accounts/login/' });
        return res.end();
      }
      if (mode === 'ratelimit') return json(res, 401, { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' });
      if (req.headers['x-ig-app-id'] == null) return json(res, 400, { message: 'useragent mismatch', status: 'fail' });
      const acc = findIG(url.searchParams.get('username'));
      if (!acc) return json(res, 404, { data: { user: null }, status: 'ok' });
      return json(res, 200, { data: { user: igUser(acc) }, status: 'ok' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return {
    server,
    hits,
    modes,
    state,
    async listen(port = 0) {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    get base() {
      return base;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Demo data: fictional creators, timestamps relative to `now`. */
export function demoConfig(now = Date.now()) {
  const s = (minsAgo) => Math.floor((now - minsAgo * 60_000) / 1000);
  const tt = (minsAgo, salt, extra) => ({ id: tiktokId(s(minsAgo), salt), createTime: s(minsAgo), ...extra });
  return {
    tiktok: [
      {
        username: 'demo.kitchen',
        nickname: 'مطبخ أبو فهد',
        userId: '6800000000000000001',
        secUid: 'MS4wLjABAAAAdemo_kitchen_secuid_0000000000000000000000000000000000001',
        followers: 284000,
        verified: true,
        bio: 'وصفات سريعة كل يوم 🍳 (حساب تجريبي)',
        posts: [
          tt(18, 1, { desc: 'كبسة دجاج بخطوات سهلة 🍗🔥 جربوها وقولوا لي رأيكم #كبسة #طبخ #وصفات', views: 48200, likes: 5100, comments: 312, duration: 47 }),
          tt(60 * 5, 2, { desc: 'حلى البسكويت بالكراميل بدون فرن 😍 #حلويات', views: 132000, likes: 15400, comments: 870, duration: 32 }),
          tt(60 * 26, 3, { desc: 'سر الأرز المفلفل اللي سألتوني عنه كثير 👌', views: 201000, likes: 22000, comments: 1400, duration: 58 }),
          tt(60 * 24 * 9, 4, { desc: 'منشور قديم قبل تاريخ المتابعة', views: 9000, likes: 800, comments: 20 }),
        ],
      },
    ],
    instagram: [
      {
        username: 'demo.travel',
        fullName: 'رحلات نورة',
        userId: '4100000001',
        followers: 96300,
        bio: 'أجمل الأماكن حول العالم ✈️ (حساب تجريبي)',
        posts: [
          { shortcode: 'DEMOreel01', taken_at: s(70), type: 'reel', caption: 'غروب الشمس من أعلى جبل في العُلا 🌄 #السعودية #سفر', views: 31000, likes: 2900, comments: 140, duration: 24 },
          { shortcode: 'DEMOcar002', taken_at: s(60 * 30), type: 'carousel', caption: '٥ أماكن لازم تزورها في إسطنبول 🇹🇷 احفظ المنشور لرحلتك الجاية', likes: 7400, comments: 410 },
          { shortcode: 'DEMOold003', taken_at: s(60 * 24 * 20), type: 'image', caption: 'منشور مثبت قديم', pinned: true, likes: 12000, comments: 600 },
        ],
      },
    ],
  };
}
