// Static data layer: the page reads feed.json, which a GitHub Actions job
// rewrites every 30 minutes. What you've watched is remembered on this device.
import { PLATFORMS, parseAccountInput } from './accounts.js';

const SEEN_KEY = 'radar.seen';
let seen = loadSeen();
let lastFeed = null;

function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-5000)));
  } catch {
    /* storage blocked: keep in memory */
  }
}

/** owner/repo of this site: from feed.json, or guessed from the github.io address. */
export function repoSlug() {
  if (lastFeed?.repo) return lastFeed.repo;
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const first = location.pathname.split('/').filter(Boolean)[0];
  return first && !first.includes('.') ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
}

const gh = (path) => (repoSlug() ? `https://github.com/${repoSlug()}${path}` : null);
export const links = {
  repo: () => gh(''),
  runNow: () => gh('/actions/workflows/update.yml'),
  editAccounts: () => gh('/edit/main/accounts.json'),
  secrets: () => gh('/settings/secrets/actions'),
  newSecret: () => gh('/settings/secrets/actions/new'),
  issue: (title) => gh(`/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent('اضغط «Submit new issue» (أو «Create») للتأكيد. سيُطبَّق الطلب خلال دقيقة تقريباً ويُغلق تلقائياً.')}`),
};

async function getJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`خطأ ${res.status}`);
  return res.json();
}

/** Before the first update has run: show the configured accounts as "waiting". */
async function pendingState() {
  const config = (await getJson('accounts.json').catch(() => null)) || { accounts: [] };
  const since = Date.parse(config.since) || Date.now();
  return {
    serverTime: Date.now(),
    pending: true,
    settings: { since, intervalMin: config.intervalMin || 30, manual: config.schedule === 'manual' },
    run: { running: true, currentAccountId: null, lastRunAt: null, lastFinishedAt: null, lastNewCount: 0, nextRunAt: null },
    capabilities: {},
    accounts: (config.accounts || []).map((a, i) => ({
      id: `pending-${i}`,
      platform: a.platform,
      username: a.username,
      url: a.platform === 'tiktok' ? `https://www.tiktok.com/@${a.username}` : `https://www.instagram.com/${a.username}/`,
      displayName: null,
      avatar: null,
      lastError: null,
      lastOkAt: null,
      latestPostAt: null,
    })),
    posts: [],
  };
}

export const api = {
  async state() {
    const feed = await getJson('feed.json');
    if (!feed) return pendingState();
    lastFeed = feed;
    if (feed.posts.length) {
      const ids = new Set(feed.posts.map((p) => p.id));
      for (const id of [...seen]) if (!ids.has(id)) seen.delete(id);
    }
    const interval = (feed.intervalMin || 30) * 60_000;
    return {
      serverTime: Date.now(),
      settings: { since: feed.since, intervalMin: feed.intervalMin || 30, manual: feed.schedule === 'manual' },
      run: { running: false, currentAccountId: null, lastRunAt: feed.generatedAt, lastFinishedAt: feed.generatedAt, lastNewCount: 0, nextRunAt: feed.generatedAt + interval },
      capabilities: feed.capabilities || {},
      accounts: feed.accounts,
      posts: feed.posts.map((p) => ({ ...p, seen: seen.has(p.id) })),
    };
  },

  async seen({ ids, all, accountId }) {
    const posts = lastFeed?.posts || [];
    let changed = 0;
    for (const p of posts) {
      if ((all || ids?.includes(p.id) || (accountId && p.accountId === accountId)) && !seen.has(p.id)) {
        seen.add(p.id);
        changed++;
      }
    }
    saveSeen();
    return { changed };
  },

  /** Validate a profile link and build the GitHub request that follows it. */
  followRequest(input, platform) {
    const parsed = parseAccountInput(input, platform);
    if (parsed.error) return parsed;
    const exists = lastFeed?.accounts?.some((a) => a.platform === parsed.platform && a.username === parsed.username);
    if (exists) return { error: 'هذا الحساب في قائمة المتابعة مسبقاً' };
    const url = PLATFORMS[parsed.platform].profileUrl(parsed.username);
    return { ...parsed, url: links.issue(`follow ${url}`) };
  },

  unfollowUrl(account) {
    return links.issue(`unfollow ${PLATFORMS[account.platform].profileUrl(account.username)}`);
  },
};

// ——— Instant check from the refresh button ———
// A GitHub key (fine-grained token limited to this repository's Actions) lets the
// button start the update job right away. It is kept only in this browser.
const TOKEN_KEY = 'radar.ghToken';
export const ghToken = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      localStorage.setItem(TOKEN_KEY, v);
    } catch {
      /* storage blocked */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked */
    }
  },
};

async function ghApi(path, { method = 'GET', body, token = ghToken.get() } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('مفتاح GitHub غير صالح أو انتهت مدته — أنشئ مفتاحاً جديداً من الإعدادات');
  if (res.status === 403 || res.status === 404) throw new Error('مفتاح GitHub لا يملك صلاحية Actions على مستودع الصفحة — راجع خطوات الإعدادات');
  if (!res.ok) throw new Error(`GitHub: خطأ ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const WORKFLOW = '/actions/workflows/update.yml';

/** Check a pasted key before saving it. */
export async function verifyToken(token) {
  const slug = repoSlug();
  if (!slug) throw new Error('افتح الصفحة من رابطها على github.io');
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) throw new Error('هذا لا يبدو مفتاح GitHub (يبدأ بـ github_pat_)');
  await ghApi(`/repos/${slug}${WORKFLOW}`, { token });
}

/** Start the update job (or join one already running). Returns its run id. */
export async function startCheck() {
  const slug = repoSlug();
  const runs = async () => (await ghApi(`/repos/${slug}${WORKFLOW}/runs?per_page=5`)).workflow_runs || [];
  const active = (await runs()).find((r) => r.status !== 'completed');
  if (active) return active.id;
  const clicked = Date.now();
  await ghApi(`/repos/${slug}${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: 'main' } });
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const run = (await runs()).find((r) => Date.parse(r.created_at) >= clicked - 15000);
    if (run) return run.id;
  }
  throw new Error('لم يبدأ الفحص — حاول مرة أخرى بعد قليل');
}

export async function runStatus(id) {
  const r = await ghApi(`/repos/${repoSlug()}/actions/runs/${id}`);
  return { status: r.status, conclusion: r.conclusion };
}
