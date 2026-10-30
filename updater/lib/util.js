import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Multiply `ms` by a random factor in [1 - spread, 1 + spread]. */
export function jitter(ms, spread = 0.1) {
  return Math.round(ms * (1 - spread + Math.random() * spread * 2));
}

export function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/** Number from a number or numeric string; otherwise null. */
export function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** First non-empty string among the arguments (arrays are searched too). */
export function firstStr(...vals) {
  for (const v of vals) {
    if (Array.isArray(v)) {
      const s = firstStr(...v);
      if (s) return s;
    } else if (str(v)) {
      return v;
    }
  }
  return null;
}

/**
 * Extract and parse the JSON body of `<script id="ID" ...>{...}</script>`.
 * Returns null when missing or invalid.
 */
export function scriptJson(html, id) {
  if (!html) return null;
  const re = new RegExp(`<script[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Depth-first search for the first value under `key` that satisfies `test`. */
export function findKey(obj, key, test = () => true, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key) && test(obj[key])) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, test, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Local midnight (server time zone) of a YYYY-MM-DD date. */
export function localMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
