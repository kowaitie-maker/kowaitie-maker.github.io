import fsp from 'node:fs/promises';
import path from 'node:path';
import { PLATFORMS } from './accounts.js';

const API = 'https://api.telegram.org';
const MAX_PER_BATCH = 3;

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * Optional Telegram notifications: a bot sends you each new post, so you get a
 * real phone notification even when the app isn't open.
 */
export function createTelegramNotifier({ getSettings, mediaDir, apiBase = API, log = () => {} }) {
  async function call(method, body, token) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(json.description || `Telegram HTTP ${res.status}`);
    return json.result;
  }

  function config() {
    const t = getSettings().telegram || {};
    return t.token && t.chatId ? t : null;
  }

  async function sendPost(cfg, account, post) {
    const who = account.displayName || `@${account.username}`;
    const what = post.kind === 'image' || post.kind === 'carousel' || post.kind === 'photo' ? 'منشوراً جديداً' : 'فيديو جديد';
    const caption = post.caption ? `\n\n${escapeHtml(post.caption.slice(0, 600))}` : '';
    const text = `🔴 <b>${escapeHtml(who)}</b> نشر ${what} على ${PLATFORMS[account.platform].name}${caption}`;
    const reply_markup = { inline_keyboard: [[{ text: 'مشاهدة ▶️', url: post.url }]] };
    if (post.cover) {
      try {
        const buf = await fsp.readFile(path.join(mediaDir, post.cover));
        const form = new FormData();
        form.set('chat_id', cfg.chatId);
        form.set('caption', text.slice(0, 1000));
        form.set('parse_mode', 'HTML');
        form.set('reply_markup', JSON.stringify(reply_markup));
        form.set('photo', new Blob([buf]), post.cover);
        return await call('sendPhoto', form, cfg.token);
      } catch (err) {
        log(`telegram photo failed, sending text: ${err.message}`);
      }
    }
    return call('sendMessage', { chat_id: cfg.chatId, text: `${text}\n\n${post.url}`, parse_mode: 'HTML', reply_markup }, cfg.token);
  }

  return {
    async notify(account, posts) {
      const cfg = config();
      if (!cfg) return;
      for (const post of posts.slice(0, MAX_PER_BATCH)) await sendPost(cfg, account, post);
      if (posts.length > MAX_PER_BATCH) {
        const more = posts.length - MAX_PER_BATCH;
        await call('sendMessage', { chat_id: cfg.chatId, text: `➕ و${more} منشورات أخرى جديدة من @${account.username} — افتح رادار لمشاهدتها.` }, cfg.token);
      }
    },
    async test() {
      const cfg = config();
      if (!cfg) throw new Error('أدخل رمز البوت ومعرّف المحادثة أولاً');
      await call('sendMessage', { chat_id: cfg.chatId, text: '✅ رادار متصل! ستصلك هنا المنشورات الجديدة من حساباتك المفضلة.' }, cfg.token);
    },
    /** Find the chat id of whoever last messaged the bot (user sends /start first). */
    async detectChat(token) {
      const updates = await call('getUpdates', { limit: 20, allowed_updates: ['message'] }, token);
      const msg = [...updates].reverse().find((u) => u.message?.chat?.id)?.message;
      if (!msg) throw new Error('لم أجد رسائل — أرسل /start إلى البوت ثم أعد المحاولة');
      return { chatId: String(msg.chat.id), name: msg.chat.first_name || msg.chat.title || msg.chat.username || '' };
    },
  };
}
