import { createRequire } from 'node:module';
import { CHROME_UA } from '../net.js';
import { FetchError } from '../errors.js';

/**
 * Parse an answer that may be plain JSON, JSON behind a "for (;;);" guard, or
 * several JSON documents on separate lines (streamed GraphQL).
 */
export function parseJsonish(text) {
  const body = String(text || '').replace(/^\s*for\s*\(;;\);\s*/, '').trim();
  if (!body) return [];
  try {
    return [JSON.parse(body)];
  } catch {
    const out = [];
    for (const line of body.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

/**
 * Optional headless-browser fetcher built on Playwright. It opens the real
 * profile page and keeps the JSON the site itself loads. Returns null when
 * Playwright (and its Chromium) is not installed.
 */
export async function createBrowserFetcher({ log = () => {} } = {}) {
  let playwright;
  try {
    playwright = createRequire(import.meta.url)('playwright');
  } catch {
    return null;
  }

  let browser = null;
  let launching = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  const sessions = new Map(); // logged-in pages kept open for a run, keyed by cookies

  async function getBrowser() {
    if (browser?.isConnected()) return browser;
    launching ||= playwright.chromium
      .launch({
        headless: true,
        // On GitHub's runners Google Chrome is preinstalled, so no browser download is needed.
        ...(process.env.RADAR_BROWSER_CHANNEL ? { channel: process.env.RADAR_BROWSER_CHANNEL } : {}),
        args: ['--disable-blink-features=AutomationControlled'],
      })
      .then((b) => {
        browser = b;
        launching = null;
        return b;
      })
      .catch((err) => {
        launching = null;
        throw err;
      });
    return launching;
  }

  function scheduleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      sessions.clear();
      browser?.close().catch(() => {});
      browser = null;
    }, 120_000);
    idleTimer.unref?.();
  }

  async function captureNow(url, { match, cookies = [], waitMs = 15000, waitFor = null, until = null, block = null, clickButton = null, keepDocument = false }) {
    let b;
    try {
      b = await getBrowser();
    } catch (err) {
      throw new FetchError('unavailable', `browser launch failed: ${err.message.split('\n')[0]}`, 'browser');
    }
    const context = await b.newContext({ userAgent: CHROME_UA, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    if (cookies.length) await context.addCookies(cookies);
    let blocked = 0;
    if (block) {
      await context.route('**/*', (route) => {
        if (block(route.request())) {
          blocked++;
          return route.abort();
        }
        return route.continue();
      });
    }
    const page = await context.newPage();
    const jsons = [];
    const pending = [];
    const trace = [];
    let documentText = '';
    page.on('response', (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (keepDocument && type === 'document' && !documentText && res.url().startsWith(url.split('?')[0])) {
        pending.push(res.text().then((t) => (documentText = t)).catch(() => {}));
      }
      const matched = match(res.url());
      if (type === 'xhr' || type === 'fetch') {
        let path = '';
        try {
          path = new URL(res.url()).pathname;
        } catch {
          /* ignore */
        }
        trace.push(`${req.method()} ${path}${req.headers()['x-fb-friendly-name'] ? ` [${req.headers()['x-fb-friendly-name']}]` : ''} ${res.status()}${matched ? '' : ' (skipped)'}`);
      }
      if (!matched) return;
      pending.push(res.text().then((t) => jsons.push(...parseJsonish(t))).catch(() => {}));
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      let clicked = false;
      if (clickButton) {
        try {
          await page.getByRole('button', { name: clickButton }).first().click({ timeout: 8000 });
          clicked = true;
        } catch {
          /* no such button */
        }
      }
      const start = Date.now();
      let scrolled = false;
      while (Date.now() - start < waitMs) {
        await page.waitForTimeout(700);
        await Promise.all(pending);
        if (until ? until(jsons) : jsons.length) break;
        if (waitFor && (await page.$(waitFor).catch(() => null))) break;
        if (!scrolled && Date.now() - start > 4000) {
          scrolled = true;
          await page.mouse.wheel(0, 1500).catch(() => {});
        }
      }
      await page.waitForTimeout(500);
      await Promise.all(pending);
      const html = await page.content();
      log(`browser captured ${jsons.length} responses from ${url}`);
      return { jsons, html, blocked, clicked, trace, documentText };
    } catch (err) {
      throw new FetchError('network', `browser: ${err.message.split('\n')[0]}`, 'browser');
    } finally {
      await context.close().catch(() => {});
      scheduleClose();
    }
  }

  /** Run `fn(arg)` inside a page at `url` (same-origin fetches use the page's cookies). */
  async function evaluateNow(url, { cookies = [], fn, arg }) {
    let b;
    try {
      b = await getBrowser();
    } catch (err) {
      throw new FetchError('unavailable', `browser launch failed: ${err.message.split('\n')[0]}`, 'browser');
    }
    const key = `${url}|${JSON.stringify(cookies)}`;
    let entry = sessions.get(key);
    if (!entry || entry.page.isClosed()) {
      const context = await b.newContext({ userAgent: CHROME_UA, locale: 'en-US', viewport: { width: 1280, height: 900 } });
      if (cookies.length) await context.addCookies(cookies);
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        await context.close().catch(() => {});
        throw new FetchError('network', `browser: ${err.message.split('\n')[0]}`, 'browser');
      }
      entry = { context, page };
      sessions.set(key, entry);
    }
    try {
      return await entry.page.evaluate(fn, arg);
    } finally {
      scheduleClose();
    }
  }

  return {
    evaluate(url, opts) {
      const job = queue.then(() => evaluateNow(url, opts));
      queue = job.catch(() => {});
      return job;
    },
    /** Runs one capture at a time to keep memory use low. */
    capture(url, opts) {
      const job = queue.then(() => captureNow(url, opts));
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      clearTimeout(idleTimer);
      sessions.clear();
      await browser?.close().catch(() => {});
      browser = null;
    },
  };
}
