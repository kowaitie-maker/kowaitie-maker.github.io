import fsp from 'node:fs/promises';
import path from 'node:path';
import { CHROME_UA } from './net.js';

/** CDN hosts that serve TikTok / Instagram images. Only these are downloaded. */
export const MEDIA_HOST_SUFFIXES = [
  'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'tiktokv.us', 'tiktokv.eu',
  'ttwstatic.com', 'ibyteimg.com', 'byteimg.com', 'muscdn.com',
  'cdninstagram.com', 'fbcdn.net',
];

const TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const EXT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_FILE_RE = /^[a-z0-9][a-z0-9_.-]{0,120}\.(jpg|png|webp|gif|avif)$/;

export function mediaContentType(file) {
  return EXT_TYPES[file.split('.').pop()] || 'application/octet-stream';
}

/**
 * Downloads remote images into `dir` so the app keeps working after the
 * platform's signed CDN links expire (and because Instagram blocks hotlinking).
 * @param {{dir:string, extraHosts?:string[]}} opts extraHosts may use http (tests only)
 */
export function createMediaCache({ dir, extraHosts = [] }) {
  const extra = new Set(extraHosts.map((h) => h.toLowerCase()));

  function allowed(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const host = u.hostname.toLowerCase();
    if (extra.has(host) || extra.has(u.host.toLowerCase())) return u.protocol === 'http:' || u.protocol === 'https:';
    if (u.protocol !== 'https:') return false;
    return MEDIA_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  }

  async function exists(file) {
    try {
      await fsp.access(path.join(dir, file));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Download `url` and save it as `<key>.<ext>`. Returns the file name, or null.
   * @param {string} url
   * @param {string} key  [a-z0-9_-] only
   */
  async function cache(url, key, { referer } = {}) {
    if (!url || !allowed(url)) return null;
    const safeKey = String(key).toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 100);
    for (const ext of Object.values(EXT_TYPES).map((t) => TYPES[t])) {
      if (await exists(`${safeKey}.${ext}`)) return `${safeKey}.${ext}`;
    }
    let res;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5', ...(referer ? { Referer: referer } : {}) },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
      });
    } catch {
      return null;
    }
    if (!res.ok || !allowed(res.url || url)) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_BYTES) return null;
        chunks.push(chunk);
      }
    } catch {
      return null;
    }
    if (!size) return null;
    const file = `${safeKey}.${ext}`;
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${file}.part`);
    await fsp.writeFile(tmp, Buffer.concat(chunks));
    await fsp.rename(tmp, path.join(dir, file));
    return file;
  }

  async function remove(file) {
    if (!file || !MEDIA_FILE_RE.test(file)) return;
    await fsp.unlink(path.join(dir, file)).catch(() => {});
  }

  return { dir, allowed, cache, remove, exists };
}
