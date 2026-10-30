import { FetchError, kindForStatus } from './errors.js';

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Minimal cookie jar: remembers name=value pairs from Set-Cookie headers. */
export class CookieJar {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }
  absorb(headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of list) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /^deleted$/i.test(value)) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  get(name) {
    return this.map.get(name);
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * HTTP GET/POST with timeout and optional cookie jar.
 * Returns { status, url, headers, text, location } and never throws on HTTP status;
 * throws FetchError('network') on connection problems.
 */
export async function request(url, { method = 'GET', headers = {}, body, timeout = 20000, jar, redirect = 'follow', strategy } = {}) {
  const h = { 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8', ...headers };
  if (jar && jar.map.size) h.Cookie = [h.Cookie, jar.header()].filter(Boolean).join('; ');
  let res;
  try {
    res = await fetch(url, { method, headers: h, body, redirect, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code || err?.message || String(err);
    throw new FetchError('network', `${detail} (${new URL(url).host})`, strategy);
  }
  if (jar) jar.absorb(res.headers);
  const text = redirect === 'manual' && res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, url: res.url || url, headers: res.headers, text, location: res.headers.get('location') };
}

/** Throw a FetchError for non-2xx responses. */
export function ensureOk(res, strategy) {
  if (res.status >= 200 && res.status < 300) return res;
  throw new FetchError(kindForStatus(res.status), `HTTP ${res.status} ${shortUrl(res.url)}`, strategy);
}

/** Parse JSON or throw FetchError. Empty bodies are treated as a soft block. */
export function parseJson(res, strategy) {
  const body = (res.text || '').trim();
  if (!body) throw new FetchError('blocked', `empty body from ${shortUrl(res.url)}`, strategy);
  if (body[0] === '<') throw new FetchError('blocked', `HTML instead of JSON from ${shortUrl(res.url)}`, strategy);
  try {
    return JSON.parse(body);
  } catch {
    throw new FetchError('parse', `invalid JSON from ${shortUrl(res.url)}`, strategy);
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return String(u).slice(0, 80);
  }
}
