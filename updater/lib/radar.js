import { parseAccountInput, profileUrl } from './accounts.js';
import { MESSAGES, asFetchError } from './errors.js';
import { jitter, localMidnight, newId, randInt, sleep } from './util.js';
import { embedUrl as tiktokEmbed } from './fetchers/tiktok.js';
import { embedUrl as instagramEmbed } from './fetchers/instagram.js';

/** The user asked to start following from this day. Changeable in settings. */
export const DEFAULT_SINCE_DATE = '2026-10-30';
export const SEED_ACCOUNTS = [
  { platform: 'tiktok', username: 'yousefali82__' },
  { platform: 'instagram', username: 'mohamed.ouf.xx' },
];
export const MIN_INTERVAL_MIN = 5;
const MAX_POSTS = 3000;
const MAX_BACKOFF = 3 * 3600_000;
const AVATAR_TTL = 24 * 3600_000;
const REFERERS = { tiktok: 'https://www.tiktok.com/', instagram: 'https://www.instagram.com/' };

export function newAccount(platform, username, now = Date.now()) {
  return {
    id: newId(),
    platform,
    username,
    url: profileUrl(platform, username),
    displayName: null,
    avatar: null,
    avatarAt: null,
    followers: null,
    postsCount: null,
    bio: '',
    verified: false,
    addedAt: now,
    paused: false,
    lastCheckAt: null,
    lastOkAt: null,
    lastError: null,
    errorCount: 0,
    nextCheckAt: 0,
    latestPostAt: null,
    strategy: null,
    profileAt: null,
    meta: {},
  };
}

export function seedData({ since = localMidnight(DEFAULT_SINCE_DATE), accounts = SEED_ACCOUNTS } = {}) {
  return {
    version: 1,
    settings: { since, intervalMin: 15, igSessionId: '', telegram: { token: '', chatId: '' } },
    accounts: accounts.map((a) => newAccount(a.platform, a.username)),
    posts: [],
    run: { lastRunAt: null, lastFinishedAt: null, lastNewCount: 0 },
  };
}

function embedFor(platform, postId, kind) {
  return platform === 'tiktok' ? tiktokEmbed(postId, kind) : instagramEmbed(postId);
}

/**
 * The app's core: owns accounts/posts, runs the periodic checks, and reports changes.
 * @param {object} deps
 * @param {{data:object, save:Function}} deps.store
 * @param {{tiktok:Function, instagram:Function}} deps.fetchers
 * @param {{cache:Function, remove:Function}} deps.media
 * @param {{emit:Function}} deps.events
 * @param {{notify:Function}} [deps.notifier]
 */
export function createRadar({
  store,
  fetchers,
  media,
  events,
  notifier = null,
  origins,
  browser = null,
  ytdlp = null,
  fetchStories = null,
  log = () => {},
  now = () => Date.now(),
  spacingMs = [1500, 4000],
  firstRunDelayMs = 2000,
}) {
  const db = store.data;
  let running = null;
  let currentAccountId = null;
  let nextRunAt = now() + firstRunDelayMs;
  let timer = null;

  const emit = (type, data = {}) => events.emit(type, data);
  const intervalMs = () => Math.max(MIN_INTERVAL_MIN, db.settings.intervalMin || 15) * 60_000;
  const postIndex = () => new Map(db.posts.map((p) => [p.id, p]));

  function ctx() {
    return { origins, since: db.settings.since, settings: db.settings, browser, ytdlp, log, now };
  }

  async function applyProfile(acc, profile, refreshed) {
    if (!profile) return;
    if (profile.displayName) acc.displayName = profile.displayName;
    if (profile.followers != null) acc.followers = profile.followers;
    if (profile.postsCount != null) acc.postsCount = profile.postsCount;
    if (profile.bio) acc.bio = profile.bio;
    if (profile.verified) acc.verified = true;
    if (typeof profile.hasStory === 'boolean') {
      const started = profile.hasStory && !acc.hasStory;
      acc.hasStory = profile.hasStory;
      acc.storySince = profile.hasStory ? (started ? now() : acc.storySince || now()) : null;
      if (started) notifier?.notifyStory?.(acc)?.catch?.((err) => log(`story notify failed: ${err.message}`));
    }
    const meta = Object.fromEntries(Object.entries(profile.meta || {}).filter(([, v]) => v));
    acc.meta = { ...acc.meta, ...meta };
    if (refreshed) acc.profileAt = now();

    const avatarStale = !acc.avatar || !acc.avatarAt || now() - acc.avatarAt > AVATAR_TTL;
    if (profile.avatarUrl && avatarStale) {
      const file = await media.cache(profile.avatarUrl, `avatar-${acc.id}-${now().toString(36)}`, { referer: REFERERS[acc.platform] });
      if (file) {
        if (acc.avatar && acc.avatar !== file) await media.remove(acc.avatar);
        acc.avatar = file;
        acc.avatarAt = now();
      }
    }
  }

  /** Can the Instagram CDN serve story videos to the page directly? (headers only, for deciding storage) */
  async function probeCdn(url, variants) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { Referer: REFERERS.instagram }, signal: AbortSignal.timeout(15000) });
      return {
        at: now(),
        status: res.status,
        corp: res.headers.get('cross-origin-resource-policy'),
        acao: res.headers.get('access-control-allow-origin'),
        size: Number(res.headers.get('content-length')) || null,
        variants: variants || [],
      };
    } catch (err) {
      return { at: now(), error: String(err.message).slice(0, 100), variants: variants || [] };
    }
  }

  /** Keep downloaded copies of the account's live stories; drop expired ones. */
  async function syncStories(acc) {
    const before = acc.stories || [];
    const dropMedia = async (list, keep) => {
      for (const s of list) {
        if (keep.includes(s)) continue;
        await media.remove(s.image);
        await media.remove(s.video);
      }
    };
    const canFetch = fetchStories && acc.platform === 'instagram' && db.settings.igSessionId;
    // No login, or Instagram says there is no story: nothing to show.
    if (!canFetch || acc.hasStory === false) {
      await dropMedia(before, []);
      acc.stories = [];
      return;
    }
    let items;
    try {
      items = await fetchStories(acc, ctx());
      acc.storyError = null;
    } catch (err) {
      const e = asFetchError(err, 'stories');
      acc.storyError = String(e.message).slice(0, 2500);
      log(`stories ${acc.username}: ${e.message}`);
      const keep = before.filter((s) => !s.expiresAt || s.expiresAt > now());
      await dropMedia(before, keep);
      acc.stories = keep;
      return;
    }
    const known = new Map(before.map((s) => [s.id, s]));
    const keep = [];
    for (const it of items) {
      if (it.expiresAt && it.expiresAt <= now()) continue;
      const prev = known.get(it.storyId);
      if (prev && prev.image) {
        // Signed video links change over time; keep the newest one. Older runs stored videos locally.
        if (prev.video) await media.remove(prev.video);
        prev.video = null;
        prev.videoUrl = it.videoUrl || null;
        keep.push(prev);
        continue;
      }
      // Only the cover is stored. Instagram's CDN lets other sites play the video
      // directly (CORP: cross-origin), so videos are streamed from there.
      const image = it.imageUrl ? await media.cache(it.imageUrl, `story-${it.storyId}`, { referer: REFERERS.instagram }) : null;
      if (!image && !it.videoUrl) continue;
      if (it.videoUrl && !db.cdnProbe) db.cdnProbe = await probeCdn(it.videoUrl, it.variants);
      keep.push({ id: it.storyId, takenAt: it.takenAt, expiresAt: it.expiresAt, kind: it.videoUrl ? 'video' : 'image', image, video: null, videoUrl: it.videoUrl || null, duration: it.duration || null });
    }
    keep.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));
    await dropMedia(before, keep);
    acc.stories = keep;
    if (keep.length && !acc.hasStory) {
      acc.hasStory = true;
      acc.storySince = now();
      notifier?.notifyStory?.(acc)?.catch?.((err) => log(`story notify failed: ${err.message}`));
    }
  }

  async function applyPosts(acc, posts) {
    const index = postIndex();
    const since = db.settings.since;
    const fresh = [];
    let latest = acc.latestPostAt || 0;
    for (const p of posts) {
      if (!p?.postId || !p.createdAt) continue;
      if (p.createdAt <= now() + 3600_000 && p.createdAt > latest) latest = p.createdAt;
      const id = `${acc.platform}:${p.postId}`;
      const existing = index.get(id);
      if (existing) {
        // Keep counters fresh; retry the cover if it failed before.
        for (const [k, v] of Object.entries(p.stats || {})) if (v != null) existing.stats[k] = v;
        if (p.caption) existing.caption = p.caption;
        if (!existing.cover && p.coverUrl) {
          existing.coverRemote = p.coverUrl;
          existing.cover = await media.cache(p.coverUrl, `${acc.platform}-${p.postId}`, { referer: REFERERS[acc.platform] });
        }
        continue;
      }
      if (p.createdAt < since) continue;
      const post = {
        id,
        platform: acc.platform,
        postId: p.postId,
        accountId: acc.id,
        url: p.url,
        embedUrl: embedFor(acc.platform, p.postId, p.kind),
        createdAt: p.createdAt,
        caption: p.caption || '',
        kind: p.kind || 'video',
        duration: p.duration || null,
        stats: { views: null, likes: null, comments: null, shares: null, ...p.stats },
        cover: null,
        coverRemote: typeof p.coverUrl === 'string' && /^https?:\/\//.test(p.coverUrl) ? p.coverUrl : null,
        discoveredAt: now(),
        seen: false,
      };
      post.cover = await media.cache(p.coverUrl, `${acc.platform}-${p.postId}`, { referer: REFERERS[acc.platform] });
      db.posts.push(post);
      index.set(id, post);
      fresh.push(post);
    }
    acc.latestPostAt = latest || null;
    if (fresh.length) {
      db.posts.sort((a, b) => b.createdAt - a.createdAt);
      if (db.posts.length > MAX_POSTS) {
        for (const old of db.posts.splice(MAX_POSTS)) await media.remove(old.cover);
      }
    }
    return fresh.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function checkAccount(acc) {
    currentAccountId = acc.id;
    acc.lastCheckAt = now();
    emit('run');
    let result;
    try {
      result = await fetchers[acc.platform](acc, ctx());
    } catch (err) {
      const e = asFetchError(err, 'fetch');
      acc.errorCount = (acc.errorCount || 0) + 1;
      acc.lastError = {
        kind: e.kind,
        message: MESSAGES[e.kind] || MESSAGES.parse,
        detail: String(e.message).slice(0, 600),
        at: now(),
      };
      acc.nextCheckAt = now() + jitter(Math.min(intervalMs() * 2 ** (acc.errorCount - 1), MAX_BACKOFF));
      log(`✗ ${acc.platform}/@${acc.username}: ${e.message}`);
      store.save();
      emit('accounts');
      return [];
    }
    if (!db.accounts.includes(acc)) return []; // removed while we were fetching
    acc.errorCount = 0;
    acc.lastError = null;
    acc.lastOkAt = now();
    acc.nextCheckAt = 0;
    acc.strategy = result.strategy;
    acc.fallbacks = result.fallbacks?.length ? result.fallbacks : undefined;
    await applyProfile(acc, result.profile, result.profileRefreshed);
    const fresh = await applyPosts(acc, result.posts || []);
    await syncStories(acc);
    log(`✓ ${acc.platform}/@${acc.username} via ${result.strategy}: ${result.posts?.length || 0} recent, ${fresh.length} new`);
    store.save();
    emit('accounts');
    if (fresh.length) {
      emit('posts', { ids: fresh.map((p) => p.id) });
      notifier?.notify(acc, fresh).catch((err) => log(`notify failed: ${err.message}`));
    }
    return fresh;
  }

  /**
   * Check accounts. Without `force`, accounts in error back-off are skipped.
   * Concurrent calls share the run already in progress.
   */
  function checkAll({ force = false, accountId = null } = {}) {
    if (running) return running;
    running = (async () => {
      db.run.lastRunAt = now();
      emit('run');
      const due = db.accounts.filter((a) =>
        accountId ? a.id === accountId : !a.paused && (force || !a.nextCheckAt || a.nextCheckAt <= now()),
      );
      let newCount = 0;
      for (let i = 0; i < due.length; i++) {
        if (i > 0 && spacingMs) await sleep(randInt(spacingMs[0], spacingMs[1]));
        if (!db.accounts.includes(due[i])) continue;
        newCount += (await checkAccount(due[i])).length;
      }
      db.run.lastFinishedAt = now();
      db.run.lastNewCount = newCount;
      if (!accountId) nextRunAt = now() + jitter(intervalMs());
      store.save();
      return { checked: due.length, newPosts: newCount };
    })().finally(() => {
      running = null;
      currentAccountId = null;
      emit('run');
    });
    return running;
  }

  function publicAccount(a) {
    return {
      id: a.id,
      platform: a.platform,
      username: a.username,
      url: a.url,
      displayName: a.displayName,
      avatar: a.avatar ? `/media/${a.avatar}` : null,
      followers: a.followers,
      postsCount: a.postsCount,
      bio: a.bio,
      verified: a.verified,
      addedAt: a.addedAt,
      paused: a.paused,
      lastCheckAt: a.lastCheckAt,
      lastOkAt: a.lastOkAt,
      lastError: a.lastError,
      nextCheckAt: a.nextCheckAt || null,
      latestPostAt: a.latestPostAt,
      strategy: a.strategy,
      hasStory: !!a.hasStory,
      storySince: a.hasStory ? a.storySince || null : null,
      stories: (a.stories || [])
        .filter((s) => !s.expiresAt || s.expiresAt > now())
        .map((s) => ({
          id: s.id,
          takenAt: s.takenAt,
          expiresAt: s.expiresAt,
          kind: s.kind,
          image: s.image ? `/media/${s.image}` : null,
          video: s.video ? `/media/${s.video}` : s.videoUrl || null,
          duration: s.duration,
        })),
      storyError: a.storyError || null,
    };
  }

  function publicPost(p) {
    return {
      id: p.id,
      platform: p.platform,
      postId: p.postId,
      accountId: p.accountId,
      url: p.url,
      embedUrl: p.embedUrl,
      createdAt: p.createdAt,
      caption: p.caption,
      kind: p.kind,
      duration: p.duration,
      stats: p.stats,
      cover: p.cover ? `/media/${p.cover}` : p.platform === 'tiktok' ? p.coverRemote : null,
      seen: p.seen,
    };
  }

  function state() {
    const since = db.settings.since;
    const ids = new Set(db.accounts.map((a) => a.id));
    return {
      serverTime: now(),
      settings: {
        since,
        intervalMin: db.settings.intervalMin,
        igSessionSet: !!db.settings.igSessionId,
        telegram: { chatId: db.settings.telegram?.chatId || '', tokenSet: !!db.settings.telegram?.token },
      },
      run: {
        running: !!running,
        currentAccountId,
        lastRunAt: db.run.lastRunAt,
        lastFinishedAt: db.run.lastFinishedAt,
        lastNewCount: db.run.lastNewCount,
        nextRunAt,
      },
      capabilities: { browser: !!browser, ytdlp: ytdlp?.version || null },
      accounts: db.accounts.map(publicAccount),
      posts: db.posts.filter((p) => p.createdAt >= since && ids.has(p.accountId)).slice(0, 600).map(publicPost),
    };
  }

  function addAccount(input, platformHint) {
    const parsed = parseAccountInput(input, platformHint);
    if (parsed.error) return { error: parsed.error, needsPlatform: !!parsed.needsPlatform };
    const dup = db.accounts.find((a) => a.platform === parsed.platform && a.username === parsed.username);
    if (dup) return { error: 'هذا الحساب مضاف مسبقاً', account: publicAccount(dup) };
    const acc = newAccount(parsed.platform, parsed.username, now());
    db.accounts.push(acc);
    store.save();
    emit('accounts');
    // Check the new account right away (shares an in-progress run if any).
    setTimeout(() => {
      Promise.resolve(running)
        .catch(() => {})
        .then(() => (db.accounts.includes(acc) ? checkAll({ force: true, accountId: acc.id }) : null))
        .catch(() => {});
    }, 50);
    return { account: publicAccount(acc) };
  }

  async function removeAccount(id) {
    const i = db.accounts.findIndex((a) => a.id === id);
    if (i < 0) return false;
    const [acc] = db.accounts.splice(i, 1);
    const keep = [];
    for (const p of db.posts) {
      if (p.accountId === id) await media.remove(p.cover);
      else keep.push(p);
    }
    db.posts = keep;
    await media.remove(acc.avatar);
    store.save();
    emit('accounts');
    return true;
  }

  function updateAccount(id, patch) {
    const acc = db.accounts.find((a) => a.id === id);
    if (!acc) return null;
    if (typeof patch.paused === 'boolean') {
      acc.paused = patch.paused;
      if (!patch.paused) acc.nextCheckAt = 0;
    }
    store.save();
    emit('accounts');
    return publicAccount(acc);
  }

  function markSeen({ ids, all, accountId, seen = true }) {
    let changed = 0;
    const set = Array.isArray(ids) ? new Set(ids) : null;
    for (const p of db.posts) {
      const match = all || (set && set.has(p.id)) || (accountId && p.accountId === accountId);
      if (match && p.seen !== seen) {
        p.seen = seen;
        changed++;
      }
    }
    if (changed) {
      store.save();
      emit('seen');
    }
    return changed;
  }

  function updateSettings(patch) {
    const s = db.settings;
    const errors = [];
    if (patch.since !== undefined) {
      const v = Number(patch.since);
      if (Number.isFinite(v) && v > Date.UTC(2010, 0, 1) && v < now() + 86_400_000) s.since = v;
      else errors.push('تاريخ البداية غير صالح');
    }
    if (patch.intervalMin !== undefined) {
      const v = Math.round(Number(patch.intervalMin));
      if (v >= MIN_INTERVAL_MIN && v <= 24 * 60) {
        s.intervalMin = v;
        const candidate = (db.run.lastFinishedAt || now()) + intervalMs();
        if (candidate < nextRunAt) nextRunAt = Math.max(candidate, now() + 1000);
      } else errors.push(`الفاصل يجب أن يكون بين ${MIN_INTERVAL_MIN} دقائق و24 ساعة`);
    }
    if (patch.igSessionId !== undefined) {
      const v = String(patch.igSessionId || '').trim().replace(/^sessionid=/, '');
      if (!v || /^[A-Za-z0-9%:._-]{10,300}$/.test(v)) s.igSessionId = v;
      else errors.push('قيمة sessionid غير صالحة');
    }
    if (patch.telegram) {
      s.telegram ||= { token: '', chatId: '' };
      if (patch.telegram.token !== undefined) {
        const t = String(patch.telegram.token || '').trim();
        if (!t || /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/.test(t)) s.telegram.token = t;
        else errors.push('رمز بوت تيليجرام غير صالح');
      }
      if (patch.telegram.chatId !== undefined) {
        const c = String(patch.telegram.chatId || '').trim();
        if (!c || /^-?\d{3,20}$|^@[A-Za-z0-9_]{4,40}$/.test(c)) s.telegram.chatId = c;
        else errors.push('معرّف المحادثة غير صالح');
      }
    }
    store.save();
    emit('settings');
    return errors;
  }

  return {
    state,
    checkAll,
    addAccount,
    removeAccount,
    updateAccount,
    markSeen,
    updateSettings,
    get running() {
      return !!running;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (!running && now() >= nextRunAt) checkAll().catch((err) => log(`run failed: ${err.message}`));
      }, 5000);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => {});
    },
  };
}
