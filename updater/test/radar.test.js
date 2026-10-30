import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRadar, seedData, DEFAULT_SINCE_DATE, SEED_ACCOUNTS } from '../lib/radar.js';
import { FetchError } from '../lib/errors.js';
import { localMidnight } from '../lib/util.js';

// Fake bot token, joined at run time so these files never contain anything that
// looks like a real Telegram token (GitHub's secret scanner flags those).
const FAKE = ['TEST', 'ONLY', 'not', 'a', 'real', 'bot', 'token', 'x'.repeat(14)].join('_').slice(0, 35);

function setup({ fetchers, since = Date.UTC(2026, 9, 30), now = Date.UTC(2026, 9, 30, 12) } = {}) {
  const data = seedData({ since, accounts: [{ platform: 'tiktok', username: 'a' }, { platform: 'instagram', username: 'b' }] });
  let clock = now;
  const events = [];
  const removed = [];
  const notified = [];
  const radar = createRadar({
    store: { data, save() {} },
    fetchers,
    media: { cache: async (url, key) => (url ? `${key}.jpg` : null), remove: async (f) => removed.push(f) },
    events: { emit: (type, d) => events.push([type, d]) },
    notifier: {
      notify: async (acc, posts) => notified.push([acc.username, posts.length]),
      notifyStory: async (acc) => notified.push([acc.username, 'story']),
    },
    spacingMs: null,
    now: () => clock,
  });
  return { radar, data, events, removed, notified, tick: (ms) => (clock += ms) };
}

const post = (id, createdAt, extra = {}) => ({ postId: id, url: `https://x/${id}`, createdAt, caption: id, kind: 'video', coverUrl: `https://c/${id}`, stats: { views: 1 }, ...extra });

test('defaults: follows the two requested accounts from 30 Oct 2026', () => {
  assert.equal(DEFAULT_SINCE_DATE, '2026-10-30');
  const d = seedData();
  assert.equal(d.settings.since, localMidnight('2026-10-30'));
  assert.deepEqual(d.accounts.map((a) => `${a.platform}:${a.username}`), SEED_ACCOUNTS.map((a) => `${a.platform}:${a.username}`));
});

test('keeps only posts since the start date, deduplicates and notifies', async () => {
  const since = Date.UTC(2026, 9, 30);
  let batch = [post('old', since - 1000), post('p1', since + 1000), post('p2', since + 5000)];
  const { radar, events, notified } = setup({
    since,
    fetchers: {
      tiktok: async () => ({ profile: { displayName: 'A', avatarUrl: 'https://av', meta: { secUid: 'S' } }, posts: batch, strategy: 'api', profileRefreshed: true }),
      instagram: async () => ({ profile: null, posts: [], strategy: 'web' }),
    },
  });
  let r = await radar.checkAll();
  assert.equal(r.newPosts, 2);
  let s = radar.state();
  assert.deepEqual(s.posts.map((p) => p.postId), ['p2', 'p1']);
  assert.equal(s.posts[0].cover, '/media/tiktok-p2.jpg');
  assert.match(s.posts[0].embedUrl, /tiktok\.com\/player\/v1\/p2/);
  const acc = s.accounts.find((a) => a.username === 'a');
  assert.equal(acc.displayName, 'A');
  assert.equal(acc.latestPostAt, since + 5000);
  assert.equal(acc.avatar, `/media/avatar-${acc.id}-${(Date.UTC(2026, 9, 30, 12)).toString(36)}.jpg`);
  assert.deepEqual(notified, [['a', 2]]);
  assert.ok(events.some(([t, d]) => t === 'posts' && d.ids.length === 2));

  batch = [post('p3', since + 9000), post('p1', since + 1000, { stats: { views: 50 } })];
  r = await radar.checkAll({ force: true });
  assert.equal(r.newPosts, 1);
  s = radar.state();
  assert.equal(s.posts.length, 3);
  assert.equal(s.posts.find((p) => p.postId === 'p1').stats.views, 50, 'stats refresh');
});

test('errors back off and recover', async () => {
  let fail = true;
  const { radar, tick } = setup({
    fetchers: {
      tiktok: async () => {
        if (fail) throw new FetchError('blocked', 'nope', 'api');
        return { posts: [], strategy: 'api' };
      },
      instagram: async () => ({ posts: [], strategy: 'web' }),
    },
  });
  await radar.checkAll();
  let a = radar.state().accounts[0];
  assert.equal(a.lastError.kind, 'blocked');
  assert.match(a.lastError.message, /رفضت/);
  assert.ok(a.nextCheckAt > Date.UTC(2026, 9, 30, 12));

  const r = await radar.checkAll(); // still backing off: skipped
  assert.equal(r.checked, 1);

  fail = false;
  tick(3 * 3600_000);
  await radar.checkAll();
  a = radar.state().accounts[0];
  assert.equal(a.lastError, null);
  assert.equal(a.strategy, 'api');
});

test('mark seen, pause, remove, settings validation', async () => {
  const since = Date.UTC(2026, 9, 30);
  const { radar, removed } = setup({
    since,
    fetchers: {
      tiktok: async () => ({ posts: [post('t1', since + 10)], strategy: 'api' }),
      instagram: async () => ({ posts: [post('i1', since + 20)], strategy: 'web' }),
    },
  });
  await radar.checkAll();
  assert.equal(radar.markSeen({ ids: ['tiktok:t1'] }), 1);
  assert.deepEqual(radar.state().posts.map((p) => p.seen), [false, true]);
  assert.equal(radar.markSeen({ all: true }), 1);

  const [ttAcc, igAcc] = radar.state().accounts;
  radar.updateAccount(igAcc.id, { paused: true });
  const r = await radar.checkAll({ force: true });
  assert.equal(r.checked, 1, 'paused account skipped');

  assert.equal(await radar.removeAccount(ttAcc.id), true);
  assert.deepEqual(removed, ['tiktok-t1.jpg', null]);
  assert.equal(radar.state().posts.length, 1);

  assert.deepEqual(radar.updateSettings({ intervalMin: 2 }).length, 1);
  assert.deepEqual(radar.updateSettings({ intervalMin: 30, since: since - 86400_000 }), []);
  assert.equal(radar.state().settings.intervalMin, 30);
  assert.equal(radar.updateSettings({ telegram: { token: 'bad' } }).length, 1);
  assert.deepEqual(radar.updateSettings({ telegram: { token: `123456789:${FAKE}`, chatId: '-100123' } }), []);
  const st = radar.state().settings;
  assert.equal(st.telegram.tokenSet, true);
  assert.equal(JSON.stringify(st).includes(FAKE), false, 'token never leaves the server');
});

test('adding accounts validates input and rejects duplicates', () => {
  const { radar } = setup({ fetchers: { tiktok: async () => ({ posts: [] }), instagram: async () => ({ posts: [] }) } });
  assert.ok(radar.addAccount('https://www.instagram.com/b/').error.includes('مسبقاً'));
  assert.ok(radar.addAccount('nonsense!!').error);
  const r = radar.addAccount('https://www.instagram.com/new.one/');
  assert.equal(r.account.username, 'new.one');
  assert.equal(radar.state().accounts.length, 3);
});

test('stories: the ring follows Instagram and each new story alerts once', async () => {
  let story = true;
  const { radar, notified, tick } = setup({
    fetchers: {
      tiktok: async () => ({ posts: [], strategy: 'api' }),
      instagram: async () => ({ profile: { displayName: 'B', hasStory: story }, posts: [], strategy: 'browser' }),
    },
  });
  await radar.checkAll();
  let b = radar.state().accounts.find((a) => a.platform === 'instagram');
  assert.equal(b.hasStory, true);
  assert.equal(b.storySince, Date.UTC(2026, 9, 30, 12));
  tick(1800_000);
  await radar.checkAll({ force: true });
  assert.equal(notified.filter(([, k]) => k === 'story').length, 1, 'same story: no second alert');
  assert.equal(radar.state().accounts.find((a) => a.platform === 'instagram').storySince, Date.UTC(2026, 9, 30, 12));
  story = false;
  await radar.checkAll({ force: true });
  b = radar.state().accounts.find((a) => a.platform === 'instagram');
  assert.deepEqual([b.hasStory, b.storySince], [false, null]);
  story = true;
  await radar.checkAll({ force: true });
  assert.equal(notified.filter(([, k]) => k === 'story').length, 2, 'a later story alerts again');
});
