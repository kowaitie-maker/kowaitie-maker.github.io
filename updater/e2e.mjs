// Browser check of the static page: build a site with the updater against the
// fake TikTok/Instagram server, serve it, and drive it in Chromium.
//   node updater/e2e.mjs        (needs Playwright with Chromium)
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { update } from './update.mjs';
import { createMockUpstream, demoConfig } from './test/support/mock-upstream.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const siteSrc = path.join(here, '..');
const out = path.join(here, 'e2e-out');
await fs.mkdir(out, { recursive: true });

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'radar-e2e-'));
for (const entry of await fs.readdir(siteSrc)) {
  if (['updater', '.git', '.github', 'feed.json', 'data', 'media', 'accounts.json'].includes(entry)) continue;
  await fs.cp(path.join(siteSrc, entry), path.join(root, entry), { recursive: true });
}
await fs.writeFile(path.join(root, 'accounts.json'), JSON.stringify({
  since: new Date(Date.now() - 2 * 86400_000).toISOString(),
  accounts: [{ platform: 'tiktok', username: 'demo.kitchen' }, { platform: 'instagram', username: 'demo.travel' }],
}));

const mock = createMockUpstream(demoConfig());
const up = await mock.listen();
process.env.GITHUB_REPOSITORY = 'kowaitie-maker/kowaitie-maker.github.io';
process.env.IG_SESSIONID = 'TEST_SESSION_for_e2e_only';
const build = () => update({ root, origins: { tiktok: up, instagram: up, instagramApi: up }, extraMediaHosts: ['127.0.0.1'], enableBrowser: false, enableYtdlp: false, spacingMs: null });

// Static file server, like GitHub Pages.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const errors = [];
let step = 0;
async function newPage(colorScheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar', colorScheme, hasTouch: true, isMobile: true });
  await ctx.route(/https:\/\/www\.(tiktok|instagram)\.com\/.*/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<body style="margin:0;background:#111"></body>' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return page;
}
const shot = async (page, name) => {
  step++;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${String(step).padStart(2, '0')}-${name}.png`) });
};
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.log(`  ✗ ${label}`);
    throw err;
  }
};

try {
  const page = await newPage('dark');

  await check('before the first update the page shows the accounts as waiting', async () => {
    await page.goto(base);
    await page.waitForSelector('.empty h2');
    assert.match(await page.locator('.empty h2').textContent(), /نجهّز/);
    assert.equal(await page.locator('.story').count(), 3);
  });
  await shot(page, 'pending');

  await build();
  await check('after the update the feed shows the 5 posts', async () => {
    await page.locator('.refresh-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 5, null, { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.card img.cover')].slice(0, 2).every((i) => i.complete && i.naturalWidth > 0));
    assert.match(await page.title(), /^\(5\) رادار$/);
    assert.match(await page.locator('.status-text').textContent(), /آخر تحديث/);
  });
  await shot(page, 'feed');

  await check('an account with stories gets a ring that plays them in the page', async () => {
    const ring = page.locator('.story.has-story');
    assert.equal(await ring.count(), 1);
    assert.match(await ring.textContent(), /ستوري/);
    assert.equal(await page.locator('.story').nth(1).evaluate((el) => el.classList.contains('has-story')), true, 'story accounts come first');
    await ring.click();
    await page.waitForSelector('.sv .sv-media img');
    assert.equal(await page.locator('.sv-bar').count(), 3);
    await page.waitForFunction(() => document.querySelector('.sv-media img')?.naturalWidth > 0);
  });
  await shot(page, 'story');
  await check('story player moves on and closes after the last story', async () => {
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    // The mock video is empty bytes, so the player may already have fallen back to the cover.
    await page.waitForFunction(() => {
      const v = document.querySelector('.sv .sv-media video');
      const img = document.querySelector('.sv .sv-media img');
      return (v && /\/vid\/3500000000000000003\.mp4$/.test(v.getAttribute('src') || '')) || (img && /story-3500000000000000003/.test(img.getAttribute('src') || ''));
    }, null, { timeout: 10000 });
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector('.sv', { state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.story.has-story')?.classList.contains('story-seen'));
  });

  await check('viewer plays the official embed and marks the post seen on this device', async () => {
    await page.locator('.card').first().locator('.card-media').click();
    await page.waitForSelector('.viewer iframe');
    assert.match(await page.locator('.viewer iframe').getAttribute('src'), /^https:\/\/www\.(tiktok\.com\/player\/v1|instagram\.com\/p)\//);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.viewer', { state: 'detached' });
    assert.equal(await page.locator('.card').first().evaluate((el) => el.classList.contains('seen')), true);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.seen')));
    assert.equal(stored.length, 1);
  });

  await check('a new post arrives on the next update', async () => {
    await fetch(`${up}/__add`, { method: 'POST', body: JSON.stringify({ platform: 'tiktok', username: 'demo.kitchen', desc: 'وصفة اليوم: شوربة عدس 🥣' }) });
    await build();
    await page.locator('.refresh-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 6, null, { timeout: 8000 });
    assert.match(await page.locator('.card').first().textContent(), /شوربة عدس/);
  });

  await check('accounts page shows status and unfollow goes to a GitHub request', async () => {
    await page.goto(`${base}#/accounts`);
    await page.waitForSelector('.acc-card');
    assert.match(await page.locator('.acc-card').first().textContent(), /يعمل/);
    await page.locator('.acc-card').first().locator('.danger-ghost').click();
    const href = await page.locator('.dialog a.btn').getAttribute('href');
    assert.equal(href, 'https://github.com/kowaitie-maker/kowaitie-maker.github.io/issues/new?title=unfollow%20https%3A%2F%2Fwww.tiktok.com%2F%40demo.kitchen&body=' + href.split('&body=')[1]);
    await page.locator('.dialog .btn.ghost').click();
  });
  await shot(page, 'accounts');

  await check('add sheet turns the pasted Instagram link into a follow request', async () => {
    await page.locator('.page-head .btn').click();
    await page.locator('#follow-input').fill('https://www.instagram.com/mohamed.ouf.xx?cplk=MTFsdTJvY2t3dHFjMg==');
    assert.match(await page.locator('.detect').textContent(), /@mohamed\.ouf\.xx/);
    const href = await page.locator('.sheet a.btn').getAttribute('href');
    assert.ok(href.includes('title=follow%20https%3A%2F%2Fwww.instagram.com%2Fmohamed.ouf.xx%2F'), href);
    await page.locator('#follow-input').fill('https://www.tiktok.com/@demo.kitchen');
    assert.match(await page.locator('.detect').textContent(), /مسبقاً/);
    assert.equal(await page.locator('.sheet a.btn').getAttribute('aria-disabled'), 'true');
    await page.locator('#follow-input').fill('https://www.instagram.com/mohamed.ouf.xx?cplk=MTFsdTJvY2t3dHFjMg==');
  });
  await shot(page, 'add-sheet');

  await check('settings explain updates, Telegram and Instagram', async () => {
    await page.goto(`${base}#/settings`);
    await page.waitForSelector('.view-settings .group');
    const text = await page.locator('main').textContent();
    assert.match(text, /TELEGRAM_TOKEN/);
    assert.match(text, /الستوري/);
    assert.match(text, /3 ستوري محفوظ/);
    assert.ok(!/\bnull\b|undefined/.test(text));
  });
  await shot(page, 'settings');

  await check('instant check: save a GitHub key, press refresh, results arrive', async () => {
    let dispatched = 0;
    const calls = [];
    await page.context().route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      calls.push(`${req.method()} ${u.pathname}`);
      assert.match(req.headers().authorization || '', /^Bearer github_pat_/);
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.method() === 'POST' && u.pathname.endsWith('/dispatches')) {
        dispatched = Date.now();
        await fetch(`${up}/__add`, { method: 'POST', body: JSON.stringify({ platform: 'tiktok', username: 'demo.kitchen', desc: 'فحص فوري من الزر' }) });
        await build();
        return route.fulfill({ status: 204, body: '' });
      }
      if (u.pathname.endsWith('/runs')) return json({ workflow_runs: dispatched ? [{ id: 77, status: 'completed', conclusion: 'success', created_at: new Date(dispatched).toISOString() }] : [] });
      if (u.pathname.endsWith('/runs/77')) return json({ status: 'completed', conclusion: 'success' });
      return json({ id: 1, path: '.github/workflows/update.yml' });
    });
    await page.locator('#gh-token').fill(`github_pat_${'A'.repeat(40)}`);
    await page.locator('#gh-token').locator('xpath=following-sibling::button').click();
    await page.waitForFunction(() => /مفعّل على هذا الجهاز/.test(document.querySelector('main').textContent));
    await page.goto(base);
    await page.waitForSelector('.card');
    await page.locator('.refresh-btn').click();
    await page.waitForSelector('.toast-ok', { timeout: 30000 });
    await page.waitForFunction(() => /فحص فوري من الزر/.test(document.querySelector('.card')?.textContent || ''), null, { timeout: 15000 });
    assert.ok(calls.some((c) => c.startsWith('POST') && c.endsWith('/dispatches')), calls.join(', '));
  });

  await check('button-only mode: pressing refresh without a key opens the setup', async () => {
    const cfg = JSON.parse(await fs.readFile(path.join(root, 'accounts.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'accounts.json'), JSON.stringify({ ...cfg, schedule: 'manual' }));
    await build();
    const fresh = await newPage('dark');
    await fresh.goto(base);
    await fresh.waitForSelector('.card');
    await fresh.locator('.refresh-btn').click();
    await fresh.waitForSelector('#instant', { timeout: 5000 });
    assert.equal(new URL(fresh.url()).hash, '#/settings');
    assert.match(await fresh.locator('#instant').textContent(), /مطلوب مرة واحدة/);
    assert.match(await fresh.locator('main').textContent(), /بالزر فقط/);
    await fresh.context().close();
  });

  const light = await newPage('light');
  await light.goto(base);
  await light.waitForSelector('.card');
  await light.waitForFunction(() => [...document.querySelectorAll('.card img.cover')].slice(0, 2).every((i) => i.complete && i.naturalWidth > 0));
  await shot(light, 'feed-light');

  const real = errors.filter((e) => !/net::ERR|Failed to load resource/.test(e));
  assert.deepEqual(real, [], 'no JavaScript errors in the page');
  console.log(`\nE2E passed — screenshots in ${path.relative(process.cwd(), out)}/`);
} catch (err) {
  console.error('\nE2E failed:', err.message);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  await mock.close();
  await fs.rm(root, { recursive: true, force: true });
}
