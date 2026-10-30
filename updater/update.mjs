#!/usr/bin/env node
// Runs in GitHub Actions every 30 minutes: checks every followed account and
// rewrites feed.json (read by the page), data/state.json (memory between runs)
// and media/ (covers and avatars). Secrets come from environment variables
// and are never written to disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRadar, newAccount, seedData } from './lib/radar.js';
import { createMediaCache, MEDIA_FILE_RE } from './lib/media.js';
import { createTelegramNotifier } from './lib/notify.js';
import { fetchTikTok } from './lib/fetchers/tiktok.js';
import { fetchInstagram } from './lib/fetchers/instagram.js';
import { createBrowserFetcher } from './lib/fetchers/browser.js';
import { createYtdlp } from './lib/fetchers/ytdlp.js';
import { PLATFORMS } from './lib/accounts.js';
import { STRATEGY_NAMES } from './strategies.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${path.basename(file)}: ${err.message}`);
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 1)}\n`);
  await fs.rename(`${file}.tmp`, file);
}

/** Turn Telegram's API errors into advice. */
export function friendlyTelegramError(message) {
  const m = String(message || '');
  if (/unauthorized/i.test(m)) return 'رمز البوت غير صحيح (Unauthorized). انسخه من جديد من BotFather وضعه في TELEGRAM_TOKEN';
  if (/chat not found/i.test(m)) return 'البوت لا يجد محادثتك (chat not found). افتح بوتك واضغط Start، وتأكد أن TELEGRAM_CHAT_ID هو رقم Id من @userinfobot';
  if (/blocked by the user/i.test(m)) return 'البوت محظور من حسابك. افتحه في تيليجرام واضغط Start أو Unblock';
  if (/network error/i.test(m)) return `تعذّر الوصول لتيليجرام في هذه المرة (${m.replace(/^.*\(|\)$/g, '')})`;
  return m.slice(0, 200);
}

/** Explain what is wrong with the Telegram secrets without revealing their values. */
export function describeTelegramProblem(rawToken, rawChat, token, chatId) {
  const problems = [];
  const t = rawToken.trim();
  const c = rawChat.trim();
  if (!t) problems.push('السرّ TELEGRAM_TOKEN فارغ أو غير موجود');
  else if (!token) {
    if (/^-?\d+$/.test(t)) problems.push('TELEGRAM_TOKEN يحتوي رقماً فقط — يبدو أنه رقمك (Id)، والرمز الصحيح من BotFather شكله 123456789:AA…؛ ربما بدّلت بين السرّين');
    else if (!t.includes(':')) problems.push('TELEGRAM_TOKEN لا يحتوي النقطتين «:» — انسخ الرمز كاملاً من رسالة BotFather (شكله 123456789:AA…)');
    else problems.push('TELEGRAM_TOKEN ليس بصيغة رمز البوت (123456789:AA… بطول 45 حرفاً تقريباً) — ربما نُسخ ناقصاً');
  }
  if (!c) problems.push('السرّ TELEGRAM_CHAT_ID فارغ أو غير موجود');
  else if (!chatId) {
    if (/\d{5,15}:/.test(c)) problems.push('TELEGRAM_CHAT_ID يحتوي رمز البوت — ربما بدّلت بين السرّين');
    else problems.push('TELEGRAM_CHAT_ID لا يحتوي رقماً — ضع رقم Id من @userinfobot وليس اسم المستخدم');
  }
  return problems.join('. ') || 'إعداد تيليجرام غير مكتمل';
}

export function readConfig(raw) {
  const since = Date.parse(raw?.since);
  if (!Number.isFinite(since)) throw new Error('accounts.json: "since" must be a date like 2026-10-30T00:00:00+03:00');
  if (!Array.isArray(raw.accounts)) throw new Error('accounts.json: "accounts" must be a list');
  const accounts = [];
  for (const a of raw.accounts) {
    const platform = String(a?.platform || '').toLowerCase();
    const username = String(a?.username || '').trim().replace(/^@/, '').toLowerCase();
    if (!PLATFORMS[platform] || !/^[a-z0-9_.]{1,30}$/.test(username)) {
      console.warn(`skipping invalid account entry: ${JSON.stringify(a)}`);
      continue;
    }
    if (!accounts.some((x) => x.platform === platform && x.username === username)) accounts.push({ platform, username });
  }
  const intervalMin = Number(raw.intervalMin) || 30;
  return { since, accounts, intervalMin };
}

export async function update({
  root = path.resolve(env.RADAR_SITE_DIR || path.join(here, '..')),
  origins = { tiktok: 'https://www.tiktok.com', instagram: 'https://www.instagram.com', instagramApi: 'https://i.instagram.com' },
  extraMediaHosts = [],
  enableBrowser = env.RADAR_NO_BROWSER !== '1',
  enableYtdlp = env.RADAR_NO_YTDLP !== '1',
  telegramApi,
  spacingMs = [1500, 4000],
} = {}) {
  const config = readConfig(await readJson(path.join(root, 'accounts.json')));
  const db = (await readJson(path.join(root, 'data', 'state.json'), null)) || seedData({ since: config.since, accounts: [] });
  db.run ||= { lastRunAt: null, lastFinishedAt: null, lastNewCount: 0 };
  db.posts ||= [];
  db.accounts ||= [];
  // Secrets are often pasted with extra text or invisible characters: keep only the real value.
  const rawToken = String(env.TELEGRAM_TOKEN || '');
  const rawChat = String(env.TELEGRAM_CHAT_ID || '');
  // Exact match first; then allow spaces / invisible marks inside the token (bot tokens end with 35 characters).
  const squeezed = rawToken.replace(/[\s\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '');
  const token = (rawToken.match(/\d{5,15}:[A-Za-z0-9_-]{30,}/) || squeezed.match(/\d{5,15}:[A-Za-z0-9_-]{35}/) || [''])[0];
  const chatId = (rawChat.match(/-?\d{1,20}|@[A-Za-z0-9_]{4,40}/) || [''])[0];
  if (token) console.log(`::add-mask::${token}`);
  db.settings = {
    since: config.since,
    intervalMin: config.intervalMin,
    igSessionId: String(env.IG_SESSIONID || '').trim().replace(/^sessionid=/, ''),
    telegram: { token, chatId },
  };

  const mediaDir = path.join(root, 'media');
  const media = createMediaCache({ dir: mediaDir, extraHosts: extraMediaHosts });

  // Bring the followed accounts in line with accounts.json.
  const keyOf = (a) => `${a.platform}:${a.username}`;
  const wanted = new Map(config.accounts.map((a, i) => [keyOf(a), i]));
  for (const acc of [...db.accounts]) {
    if (wanted.has(keyOf(acc))) continue;
    log(`unfollowing ${keyOf(acc)}`);
    db.accounts.splice(db.accounts.indexOf(acc), 1);
    db.posts = db.posts.filter((p) => p.accountId !== acc.id);
  }
  for (const a of config.accounts) {
    if (!db.accounts.some((x) => keyOf(x) === keyOf(a))) {
      log(`now following ${keyOf(a)}`);
      db.accounts.push(newAccount(a.platform, a.username));
    }
  }
  db.accounts.sort((a, b) => wanted.get(keyOf(a)) - wanted.get(keyOf(b)));

  // Telegram sends are awaited before the job ends.
  const pending = [];
  const telegram = createTelegramNotifier({ getSettings: () => db.settings, mediaDir, apiBase: telegramApi, log });
  const telegramOn = !!(token && chatId);
  db.telegramStatus ||= { lastSentAt: null, lastError: null, lastErrorAt: null };
  const telegramSecretsSet = !!(rawToken.trim() || rawChat.trim());
  if (telegramSecretsSet && !telegramOn) {
    Object.assign(db.telegramStatus, { lastError: describeTelegramProblem(rawToken, rawChat, token, chatId), lastErrorAt: Date.now() });
  }
  const fail = (err) => {
    log(`telegram: ${err.message}`);
    Object.assign(db.telegramStatus, { lastError: friendlyTelegramError(err.message), lastErrorAt: Date.now() });
  };
  // Remember whether the last send worked, so the page can show it.
  const track = (job) => {
    const done = job.then(() => Object.assign(db.telegramStatus, { lastSentAt: Date.now(), lastError: null, lastErrorAt: null }), fail);
    pending.push(done);
    return job;
  };
  const notifier = { notify: (acc, posts) => track(telegram.notify(acc, posts)) };

  const [browser, ytdlp] = await Promise.all([
    enableBrowser ? createBrowserFetcher({ log }) : null,
    enableYtdlp ? createYtdlp() : null,
  ]);
  log(`tools: yt-dlp ${ytdlp ? ytdlp.version : 'not installed'}, browser ${browser ? 'available' : 'not installed'}`);

  const radar = createRadar({
    store: { data: db, save() {} },
    fetchers: { tiktok: fetchTikTok, instagram: fetchInstagram },
    media,
    events: { emit() {} },
    notifier,
    origins,
    browser,
    ytdlp,
    log,
    spacingMs,
  });

  // Each run confirms the bot token and chat still work (no message is sent).
  if (telegramOn) {
    await telegram.verify().then(
      () => Object.assign(db.telegramStatus, { verifiedAt: Date.now(), lastError: null, lastErrorAt: null }),
      fail,
    );
  }

  const result = await radar.checkAll({ force: true });

  // Manual run with "test Telegram": send a confirmation plus the latest post.
  if (env.RADAR_TELEGRAM_TEST === '1') {
    if (!telegramOn) {
      log(`telegram test skipped: ${db.telegramStatus.lastError || 'secrets missing'}`);
      if (!telegramSecretsSet) Object.assign(db.telegramStatus, { lastError: 'السرّان TELEGRAM_TOKEN و TELEGRAM_CHAT_ID غير موجودين في أسرار المستودع', lastErrorAt: Date.now() });
    } else {
      await track(telegram.test()).catch(() => {});
      const latest = [...db.posts].sort((a, b) => b.createdAt - a.createdAt)[0];
      const acc = latest && db.accounts.find((a) => a.id === latest.accountId);
      if (latest && acc) await track(telegram.notify(acc, [latest])).catch(() => {});
    }
  }
  await Promise.all(pending);
  await browser?.close();

  const state = radar.state();
  const rel = (u) => (typeof u === 'string' && u.startsWith('/media/') ? u.slice(1) : u);
  const feed = {
    version: 1,
    generatedAt: Date.now(),
    since: config.since,
    intervalMin: config.intervalMin,
    repo: env.GITHUB_REPOSITORY || null,
    capabilities: { ...state.capabilities, instagramLogin: !!db.settings.igSessionId, telegram: telegramOn || telegramSecretsSet, telegramStatus: db.telegramStatus },
    accounts: state.accounts.map((a) => ({ ...a, avatar: rel(a.avatar), nextCheckAt: null })),
    posts: state.posts.map(({ seen, ...p }) => ({ ...p, cover: rel(p.cover) })),
  };
  await writeJson(path.join(root, 'feed.json'), feed);

  // Memory for the next run, without secrets.
  await writeJson(path.join(root, 'data', 'state.json'), { ...db, settings: { since: config.since, intervalMin: config.intervalMin } });

  // Drop media nothing refers to any more.
  const used = new Set([...db.accounts.map((a) => a.avatar), ...db.posts.map((p) => p.cover)].filter(Boolean));
  for (const f of await fs.readdir(mediaDir).catch(() => [])) {
    if ((MEDIA_FILE_RE.test(f) && !used.has(f)) || f.endsWith('.part')) await fs.unlink(path.join(mediaDir, f)).catch(() => {});
  }

  // Human-readable summary (shown on the GitHub Actions run page).
  const lines = ['| الحساب | الحالة | جديد منذ البداية | آخر نشر |', '|---|---|---|---|'];
  for (const a of db.accounts) {
    const count = db.posts.filter((p) => p.accountId === a.id && p.createdAt >= config.since).length;
    const status = a.lastError ? `❌ ${a.lastError.message}` : `✅ ${STRATEGY_NAMES[a.strategy] || a.strategy}`;
    const latest = a.latestPostAt ? new Date(a.latestPostAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
    lines.push(`| ${PLATFORMS[a.platform].name} @${a.username} | ${status} | ${count} | ${latest} |`);
    if (a.lastError) log(`  ${a.platform}/@${a.username} failed: ${a.lastError.detail}`);
  }
  const summary = `### رادار — ${result.newPosts} منشور جديد في هذا الفحص\n\n${lines.join('\n')}\n`;
  console.log(`\n${summary}`);
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, summary).catch(() => {});
  return { feed, result };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  update().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
