import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockUpstream, demoConfig } from './support/mock-upstream.js';
import { readConfig, update } from '../update.mjs';
import { applyRequest } from '../follow.mjs';

let mock;
let root;
let origins;
const since = Date.now() - 2 * 86400_000;

before(async () => {
  mock = createMockUpstream(demoConfig());
  const base = await mock.listen();
  origins = { tiktok: base, instagram: base, instagramApi: base };
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-site-'));
  await fs.writeFile(path.join(root, 'accounts.json'), JSON.stringify({
    since: new Date(since).toISOString(),
    accounts: [{ platform: 'tiktok', username: 'demo.kitchen' }, { platform: 'instagram', username: '@Demo.Travel' }],
  }));
});
after(async () => {
  await mock.close();
  await fs.rm(root, { recursive: true, force: true });
});

const run = () => update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null });
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));

test('config: since must be a date, accounts are normalised', () => {
  assert.throws(() => readConfig({ since: 'soon', accounts: [] }), /since/);
  const c = readConfig({ since: '2026-10-30T00:00:00+03:00', accounts: [{ platform: 'TikTok', username: '@A.b' }, { platform: 'x', username: 'y' }, { platform: 'tiktok', username: 'a.b' }] });
  assert.equal(c.since, Date.UTC(2026, 9, 29, 21));
  assert.deepEqual(c.accounts, [{ platform: 'tiktok', username: 'a.b' }]);
});

test('update writes feed.json, state and media with relative paths', async () => {
  const { result } = await run();
  assert.equal(result.newPosts, 5);
  const feed = await readJson('feed.json');
  assert.equal(feed.since, since);
  assert.equal(feed.accounts.length, 2);
  assert.ok(feed.accounts.every((a) => !a.lastError && a.avatar.startsWith('media/avatar-')));
  assert.equal(feed.posts.length, 5);
  for (const p of feed.posts) {
    assert.match(p.cover, /^media\/(tiktok|instagram)-/);
    await fs.access(path.join(root, p.cover));
    assert.equal('seen' in p, false);
  }
  const state = await readJson('data/state.json');
  assert.deepEqual(Object.keys(state.settings).sort(), ['intervalMin', 'since']);
});

test('secrets never reach the published files', async () => {
  process.env.IG_SESSIONID = 'SECRET_SESSION_123456';
  process.env.TELEGRAM_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  process.env.TELEGRAM_CHAT_ID = '42';
  try {
    await update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null, telegramApi: 'http://127.0.0.1:9' });
  } finally {
    delete process.env.IG_SESSIONID;
    delete process.env.TELEGRAM_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
  const text = (await fs.readFile(path.join(root, 'feed.json'), 'utf8')) + (await fs.readFile(path.join(root, 'data/state.json'), 'utf8'));
  assert.ok(!text.includes('SECRET_SESSION'));
  assert.ok(!text.includes('AAHdq'));
  const feed = await readJson('feed.json');
  assert.equal(feed.capabilities.instagramLogin, true);
  assert.equal(feed.capabilities.telegram, true);
});

test('new posts are added; removing an account drops its posts and media', async () => {
  await fetch(`${mock.base}/__add`, { method: 'POST', body: JSON.stringify({ platform: 'tiktok', username: 'demo.kitchen', desc: 'جديد' }) });
  const { result } = await run();
  assert.equal(result.newPosts, 1);

  const cfg = await readJson('accounts.json');
  cfg.accounts = cfg.accounts.filter((a) => a.platform === 'tiktok');
  await fs.writeFile(path.join(root, 'accounts.json'), JSON.stringify(cfg));
  await run();
  const feed = await readJson('feed.json');
  assert.deepEqual(feed.accounts.map((a) => a.username), ['demo.kitchen']);
  assert.ok(feed.posts.every((p) => p.platform === 'tiktok'));
  const files = await fs.readdir(path.join(root, 'media'));
  assert.ok(files.every((f) => !f.startsWith('instagram-')), files.join());
});

test('follow / unfollow requests from issue titles', async () => {
  const file = path.join(root, 'follow-test.json');
  await fs.writeFile(file, JSON.stringify({ since: '2026-10-30', accounts: [] }));
  let r = await applyRequest('follow https://www.instagram.com/mohamed.ouf.xx?cplk=MTFsdTJvY2t3dHFjMg==', file);
  assert.equal(r.changed, true);
  r = await applyRequest('follow instagram:@mohamed.ouf.xx', file);
  assert.equal(r.changed, false);
  assert.match(r.message, /مسبقاً/);
  r = await applyRequest('follow https://www.tiktok.com/@yousefali82__', file);
  assert.equal(r.changed, true);
  let cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(cfg.accounts, [{ platform: 'instagram', username: 'mohamed.ouf.xx' }, { platform: 'tiktok', username: 'yousefali82__' }]);
  r = await applyRequest('unfollow https://www.instagram.com/mohamed.ouf.xx/', file);
  assert.equal(r.changed, true);
  cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(cfg.accounts.length, 1);
  assert.equal((await applyRequest('please add someone', file)).changed, false);
  assert.equal((await applyRequest('follow https://youtube.com/@x', file)).changed, false);
});

test('Telegram test run sends a confirmation and the latest post, and records the result', async () => {
  const http = await import('node:http');
  const calls = [];
  let fail = false;
  const tg = http.createServer((req, res) => {
    calls.push(req.url.split('/').pop());
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { ok: false, description: 'Bad Request: chat not found' } : { ok: true, result: {} }));
  });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${tg.address().port}`;
  Object.assign(process.env, { TELEGRAM_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', TELEGRAM_CHAT_ID: '42', RADAR_TELEGRAM_TEST: '1' });
  try {
    await update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null, telegramApi: api });
    assert.deepEqual(calls, ['sendMessage', 'sendPhoto']);
    let feed = await readJson('feed.json');
    assert.equal(feed.capabilities.telegram, true);
    assert.ok(feed.capabilities.telegramStatus.lastSentAt);
    assert.equal(feed.capabilities.telegramStatus.lastError, null);

    fail = true;
    await update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null, telegramApi: api });
    feed = await readJson('feed.json');
    assert.match(feed.capabilities.telegramStatus.lastError, /chat not found/);
  } finally {
    for (const k of ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'RADAR_TELEGRAM_TEST']) delete process.env[k];
    tg.close();
  }
});

test('Telegram secrets pasted with extra text still work; errors never contain the token', async () => {
  const http = await import('node:http');
  const urls = [];
  const tg = http.createServer((req, res) => {
    urls.push(req.url);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));
  const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  Object.assign(process.env, { TELEGRAM_TOKEN: `‏Use this token to access the HTTP API:\n${token}\nKeep it secure `, TELEGRAM_CHAT_ID: ' Id: 42‎', RADAR_TELEGRAM_TEST: '1' });
  try {
    await update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null, telegramApi: `http://127.0.0.1:${tg.address().port}` });
    assert.equal(urls[0], `/bot${token}/sendMessage`);
    // Unreachable Telegram: the recorded error must not leak the token.
    await update({ root, origins, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null, telegramApi: 'http://127.0.0.1:9' });
    const feed = await readJson('feed.json');
    assert.match(feed.capabilities.telegramStatus.lastError, /network error/);
    assert.ok(!JSON.stringify(feed).includes('AAHdq'));
  } finally {
    for (const k of ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'RADAR_TELEGRAM_TEST']) delete process.env[k];
    tg.close();
  }
});
