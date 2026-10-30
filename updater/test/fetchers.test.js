import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockUpstream, demoConfig, tiktokId } from './support/mock-upstream.js';
import { fetchTikTok, parseItem, parseYtdlpPlaylist, tiktokIdToMs } from '../lib/fetchers/tiktok.js';
import { fetchInstagram, parseGraphNode, parseV1Item, postsFromAnyJson } from '../lib/fetchers/instagram.js';
import { newAccount } from '../lib/radar.js';

const NOW = Date.now();
let mock;
let ctx;

before(async () => {
  mock = createMockUpstream(demoConfig(NOW));
  const base = await mock.listen();
  ctx = {
    origins: { tiktok: base, instagram: base, instagramApi: base },
    since: NOW - 3 * 86400_000,
    settings: { igSessionId: '' },
    browser: null,
    ytdlp: null,
    log: () => {},
    now: () => NOW,
  };
});
after(() => mock.close());
beforeEach(() => Object.assign(mock.modes, { tiktokApi: 'ok', tiktokProfile: 'ok', tiktokEmbed: 'ok', igWeb: 'ok', igMobile: 'ok' }));

test('TikTok ids carry their upload time', () => {
  const sec = 1793318400; // 2026-10-30T00:00:00Z
  assert.equal(tiktokIdToMs(tiktokId(sec, 77)), sec * 1000);
  assert.equal(tiktokIdToMs('123'), null);
  assert.equal(tiktokIdToMs('not-a-number'), null);
});

test('parseItem handles stats, statsV2-only and photo posts', () => {
  const id = tiktokId(1793318400, 5);
  const p = parseItem({ id, desc: 'hi', createTime: '1793318400', video: { cover: 'https://x.tiktokcdn.com/a.jpeg', duration: 12 }, statsV2: { playCount: '1500', diggCount: '20' } }, 'u');
  assert.equal(p.createdAt, 1793318400000);
  assert.equal(p.stats.views, 1500);
  assert.equal(p.url, `https://www.tiktok.com/@u/video/${id}`);
  const photo = parseItem({ id, imagePost: { images: [{ imageURL: { urlList: ['https://p.tiktokcdn.com/1.jpeg'] } }] } }, 'u');
  assert.equal(photo.kind, 'photo');
  assert.equal(photo.coverUrl, 'https://p.tiktokcdn.com/1.jpeg');
  assert.match(photo.url, /\/photo\//);
  assert.equal(photo.createdAt, 1793318400000, 'falls back to the id timestamp');
  assert.equal(parseItem({ id: 'abc' }, 'u'), null);
});

test('TikTok: profile page + item_list API', async () => {
  const acc = newAccount('tiktok', 'demo.kitchen');
  const r = await fetchTikTok(acc, ctx);
  assert.equal(r.strategy, 'api');
  assert.equal(r.profileRefreshed, true);
  assert.equal(r.profile.displayName, 'مطبخ أبو فهد');
  assert.equal(r.profile.followers, 284000);
  assert.ok(r.profile.meta.secUid.startsWith('MS4w'));
  assert.ok(r.posts.length >= 3);
  assert.equal(r.posts[0].caption.includes('كبسة'), true);
  assert.equal(r.posts[0].stats.views, 48200);
});

test('TikTok: falls back to the embed page when the API is blocked', async () => {
  mock.modes.tiktokApi = 'blocked';
  const r = await fetchTikTok(newAccount('tiktok', 'demo.kitchen'), ctx);
  assert.equal(r.strategy, 'embed');
  assert.ok(r.posts.length >= 3);
  assert.ok(r.posts.every((p) => p.createdAt > 0), 'times derived from ids');
});

test('TikTok: uses cached secUid and skips the profile page', async () => {
  const acc = newAccount('tiktok', 'demo.kitchen');
  acc.meta.secUid = mock.state.tiktok[0].secUid;
  acc.profileAt = NOW;
  mock.modes.tiktokProfile = 'blocked';
  const r = await fetchTikTok(acc, ctx);
  assert.equal(r.strategy, 'api');
  assert.equal(r.profileRefreshed, false);
  assert.equal(r.profile.displayName, 'مطبخ أبو فهد', 'profile comes from item authors');
});

test('TikTok: unknown user is reported as not found', async () => {
  await assert.rejects(fetchTikTok(newAccount('tiktok', 'nobody.here'), ctx), (e) => e.kind === 'not_found');
});

test('TikTok: everything blocked gives a combined error', async () => {
  Object.assign(mock.modes, { tiktokApi: 'blocked', tiktokProfile: 'blocked', tiktokEmbed: 'blocked' });
  await assert.rejects(fetchTikTok(newAccount('tiktok', 'demo.kitchen'), ctx), (e) => e.kind === 'blocked' && e.attempts.length >= 2);
});

test('TikTok: yt-dlp output is understood', () => {
  const id = tiktokId(1793318400, 9);
  const r = parseYtdlpPlaylist({
    id: 'MS4wLjABAAAAxyz',
    entries: [{ id, url: `https://www.tiktok.com/@u/video/${id}`, title: 't', description: 'full desc', timestamp: 1793318400, view_count: 5, thumbnails: [{ url: 'https://a.tiktokcdn.com/1.jpeg', preference: -1 }], channel: 'Name' }],
  }, 'u');
  assert.equal(r.posts[0].caption, 'full desc');
  assert.equal(r.posts[0].coverUrl, 'https://a.tiktokcdn.com/1.jpeg');
  assert.equal(r.profile.displayName, 'Name');
  assert.equal(r.profile.meta.secUid, 'MS4wLjABAAAAxyz');
});

test('Instagram: graph nodes and v1 items', () => {
  const g = parseGraphNode({ shortcode: 'ABC', taken_at_timestamp: 1793318400, product_type: 'clips', is_video: true, display_url: 'https://scontent.cdninstagram.com/a.jpg', edge_media_to_caption: { edges: [{ node: { text: 'cap' } }] }, edge_liked_by: { count: 3 } });
  assert.deepEqual([g.kind, g.url, g.caption, g.stats.likes], ['reel', 'https://www.instagram.com/reel/ABC/', 'cap', 3]);
  const v = parseV1Item({ code: 'XYZ', taken_at: 1793318400, media_type: 8, carousel_media: [{ image_versions2: { candidates: [{ url: 'https://x.fbcdn.net/1.jpg' }] } }], caption: { text: 'c' }, like_count: 9 });
  assert.deepEqual([v.kind, v.coverUrl, v.stats.likes], ['carousel', 'https://x.fbcdn.net/1.jpg', 9]);
  const any = postsFromAnyJson({ data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [{ node: { code: 'Q1', taken_at: 1, media_type: 1 } }] } } });
  assert.equal(any.posts[0].postId, 'Q1');
});

test('Instagram: public profile endpoint', async () => {
  const r = await fetchInstagram(newAccount('instagram', 'demo.travel'), ctx);
  assert.equal(r.strategy, 'web');
  assert.equal(r.profile.displayName, 'رحلات نورة');
  assert.equal(r.posts.length, 3);
  assert.ok(r.posts.find((p) => p.postId === 'DEMOold003').pinned);
});

test('Instagram: login wall on web → mobile endpoint', async () => {
  mock.modes.igWeb = 'login';
  const r = await fetchInstagram(newAccount('instagram', 'demo.travel'), ctx);
  assert.equal(r.strategy, 'mobile');
});

test('Instagram: rate limited everywhere', async () => {
  Object.assign(mock.modes, { igWeb: 'ratelimit', igMobile: 'ratelimit' });
  await assert.rejects(fetchInstagram(newAccount('instagram', 'demo.travel'), ctx), (e) => e.kind === 'rate_limited');
});

test('Instagram: unknown user', async () => {
  await assert.rejects(fetchInstagram(newAccount('instagram', 'nobody.here'), ctx), (e) => e.kind === 'not_found');
});

test('Instagram: shortcodes carry their creation time', async () => {
  const { shortcodeToMs } = await import('../lib/fetchers/instagram.js');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const encode = (ms) => {
    let id = (BigInt(ms - 1314220021721) << 23n) | 1234n;
    let s = '';
    while (id > 0n) {
      s = A[Number(id % 64n)] + s;
      id /= 64n;
    }
    return s;
  };
  const ms = Date.UTC(2026, 9, 30, 9, 15);
  assert.equal(shortcodeToMs(encode(ms)), ms);
  assert.equal(shortcodeToMs('!!'), null);
});

test('Instagram: profile embed page markup is understood', async () => {
  const { parseProfileEmbed, shortcodeToMs } = await import('../lib/fetchers/instagram.js');
  const html = `<html><head><title>Instagram</title></head><body>
    <div class="Header"><img class="Avatar" src="https://scontent.cdninstagram.com/av.jpg?a=1&amp;b=2" alt=""><span class="FullName">محمد عوف</span></div>
    <a href="https://www.instagram.com/p/DQabcdefghi/?utm_source=ig_embed&amp;ig_rid=x"><img src="https://scontent.cdninstagram.com/1.jpg?x=1&amp;y=2" alt="Photo by محمد on October 30, 2026."></a>
    <a href="https://www.instagram.com/reel/DQbbcdefghi/"><img src="https://scontent.cdninstagram.com/2.jpg" alt="رحلة جميلة"></a>
    <a href="https://www.instagram.com/p/DQabcdefghi/">dup</a></body></html>`;
  const r = parseProfileEmbed(html, 'mohamed.ouf.xx');
  assert.equal(r.posts.length, 2);
  assert.equal(r.posts[0].coverUrl, 'https://scontent.cdninstagram.com/1.jpg?x=1&y=2');
  assert.equal(r.posts[0].caption, '');
  assert.equal(r.posts[1].kind, 'reel');
  assert.equal(r.posts[1].caption, 'رحلة جميلة');
  assert.equal(r.posts[0].createdAt, shortcodeToMs('DQabcdefghi'));
  assert.equal(r.profile.displayName, 'محمد عوف');
  assert.equal(r.profile.avatarUrl, 'https://scontent.cdninstagram.com/av.jpg?a=1&b=2');
});
