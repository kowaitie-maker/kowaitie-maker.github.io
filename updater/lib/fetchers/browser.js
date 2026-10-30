import { createRequire } from 'node:module';
import { CHROME_UA } from '../net.js';
import { FetchError } from '../errors.js';

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
      browser?.close().catch(() => {});
      browser = null;
    }, 120_000);
    idleTimer.unref?.();
  }

  async function captureNow(url, { match, cookies = [], waitMs = 15000, waitFor = null }) {
    let b;
    try {
      b = await getBrowser();
    } catch (err) {
      throw new FetchError('unavailable', `browser launch failed: ${err.message.split('\n')[0]}`, 'browser');
    }
    const context = await b.newContext({ userAgent: CHROME_UA, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();
    const jsons = [];
    const pending = [];
    page.on('response', (res) => {
      if (!match(res.url())) return;
      pending.push(res.json().then((j) => jsons.push(j)).catch(() => {}));
    });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const start = Date.now();
      let scrolled = false;
      while (Date.now() - start < waitMs) {
        await page.waitForTimeout(700);
        await Promise.all(pending);
        if (jsons.length) break;
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
      return { jsons, html };
    } catch (err) {
      throw new FetchError('network', `browser: ${err.message.split('\n')[0]}`, 'browser');
    } finally {
      await context.close().catch(() => {});
      scheduleClose();
    }
  }

  return {
    /** Runs one capture at a time to keep memory use low. */
    capture(url, opts) {
      const job = queue.then(() => captureNow(url, opts));
      queue = job.catch(() => {});
      return job;
    },
    async close() {
      clearTimeout(idleTimer);
      await browser?.close().catch(() => {});
      browser = null;
    },
  };
}
