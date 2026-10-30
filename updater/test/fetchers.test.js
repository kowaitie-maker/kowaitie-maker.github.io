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

test('Instagram: rendered profile embed (contextJSON with graphql_media)', async () => {
  const { parseProfileEmbed } = await import('../lib/fetchers/instagram.js');
  const context = {
    context: {
      username: 'someone', full_name: 'Some One', is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/p.jpg',
      followers_count: 2399963, posts_count: 820, owner_id: '33020898390', has_public_story: true,
      graphql_media: [{ shortcode_media: {
        __typename: 'GraphVideo', id: '1', shortcode: 'DfF6AUUtWFk', is_video: true, display_url: 'https://scontent.cdninstagram.com/1.jpg',
        edge_media_to_caption: { edges: [{ node: { text: 'ليه ابويا بيظهر معايا؟' } }] }, edge_media_to_comment: { count: 426 },
        edge_liked_by: { count: 14244 }, taken_at_timestamp: 1793307100, pinned_for_users: [],
      } }],
    },
  };
  const html = `<script>requireLazy(["ServerJS"],function(){s.handle({"require":[["PolarisEmbedSimple","init",[],[{"isProfileEmbed":true,"contextJSON":${JSON.stringify(JSON.stringify(context))}}]]]})});</script>`;
  const r = parseProfileEmbed(html, 'someone');
  assert.equal(r.posts.length, 1);
  assert.deepEqual([r.posts[0].postId, r.posts[0].kind, r.posts[0].createdAt, r.posts[0].stats.likes], ['DfF6AUUtWFk', 'video', 1793307100000, 14244]);
  assert.equal(r.profile.followers, 2399963);
  assert.equal(r.profile.displayName, 'Some One');
  assert.equal(r.profile.hasStory, true);
});

test('Instagram stories: falls back to a real browser and explains login problems', async () => {
  const { fetchStories, readStoriesAnswer } = await import('../lib/fetchers/instagram.js');
  const acc = { username: 'demo.travel', meta: { userId: '4100000001' } };
  const answer = { reels: { 4100000001: { items: [{ pk: '35', taken_at: 1793318400, image_versions2: { candidates: [{ width: 1080, url: 'https://scontent.cdninstagram.com/s.jpg' }] } }] } }, status: 'ok' };
  const browser = { evaluate: async (url, { arg, cookies }) => {
    assert.equal(url, 'https://www.instagram.com/');
    assert.equal(arg, '4100000001');
    assert.equal(cookies[0].name, 'sessionid');
    return { status: 200, text: JSON.stringify(answer) };
  } };
  // The plain request is refused (no cookie reaches the mock), the browser path succeeds.
  const items = await fetchStories(acc, { ...ctx, settings: { igSessionId: '' }, browser });
  assert.deepEqual(items.map((s) => s.storyId), ['35']);
  assert.throws(() => readStoriesAnswer(400, '{"message":"checkpoint_required","status":"fail"}', '1'), /checkpoint_required/);
  assert.throws(() => readStoriesAnswer(401, '{"message":"login_required","require_login":true}', '1'), /login_required/);
  assert.throws(() => readStoriesAnswer(200, '<html><title>Instagram</title></html>', '1'), /login not accepted/);
});

test('Instagram stories: items are found in GraphQL answers and other users are ignored', async () => {
  const { storyItemsFromJson } = await import('../lib/fetchers/instagram.js');
  const item = (pk, owner) => ({ pk, taken_at: 1793318400, expiring_at: 1793404800, user: { pk: owner }, image_versions2: { candidates: [{ width: 1080, url: `https://scontent.cdninstagram.com/${pk}.jpg` }] } });
  const json = { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '42', items: [item('1', '42'), item('2', '42')] }, { id: '7', items: [item('3', '7')] }] } } };
  assert.deepEqual(storyItemsFromJson(json, '42').map((s) => s.storyId), ['1', '2']);
  assert.deepEqual(storyItemsFromJson({ data: { other: { image_versions2: {}, taken_at: 1 } } }, '42'), []);
});

test('Instagram stories: tray reels (expiry on the reel) are understood', async () => {
  const { storyItemsFromJson, jsonShape } = await import('../lib/fetchers/instagram.js');
  const media = (pk) => ({ pk, taken_at: 1793318400, media_type: 2, video_versions: [{ width: 720, url: `https://x.cdninstagram.com/${pk}.mp4` }], image_versions2: { candidates: [{ width: 1080, url: `https://x.cdninstagram.com/${pk}.jpg` }] } });
  const json = { data: { xdt_api__v1__feed__reels_tray: { tray: [
    { id: '42', expiring_at: 1793404800, user: { pk: '42', username: 'a' }, items: [media('1'), media('2')] },
    { id: '7', user: { pk: '7' }, items: [media('3')] },
  ] } } };
  const items = storyItemsFromJson(json, '42');
  assert.deepEqual(items.map((s) => [s.storyId, s.kind, s.expiresAt]), [['1', 'video', 1793404800000], ['2', 'video', 1793404800000]]);
  assert.match(jsonShape(json), /tray:\[2×\{id:s,expiring_at:n/);
});
