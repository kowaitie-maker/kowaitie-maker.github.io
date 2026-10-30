import { h, icon, toast } from './dom.js';
import { api, links } from './api.js';
import { applyTheme } from './prefs.js';
import { ago, now, setServerTime } from './format.js';
import { spinner } from './components.js';
import { alertNewPosts, setUnseenBadge } from './alerts.js';
import { createFeedView } from './views/feed.js';
import { createProfileView } from './views/profile.js';
import { createAccountsView } from './views/accounts.js';
import { createSettingsView } from './views/settings.js';
import { openViewer } from './views/viewer.js';
import { openAddSheet } from './views/add-sheet.js';

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

// ——— App context shared with views ———
const app = {
  state: null,
  accountsById: new Map(),
  ui: { filter: 'all' },
  connected: false,
  links,
  api,
  refresh,
  openAddSheet: () => openAddSheet(app),
  openViewer(postId, list) {
    const posts = list || (current?.currentList ? current.currentList() : app.state?.posts || []);
    if (!posts.length) return;
    openViewer(app, posts, postId);
  },
  /** The page itself can't run a check; it reloads the latest results (updated every 30 min on GitHub). */
  async checkNow() {
    const before = app.state?.run.lastFinishedAt;
    manualBusy = true;
    renderChrome();
    await refresh();
    manualBusy = false;
    renderChrome();
    if (!app.connected) toast('تعذّر التحميل — تحقق من الإنترنت', 'error');
    else if (app.state?.run.lastFinishedAt && app.state.run.lastFinishedAt !== before) toast('وصلت آخر التحديثات', 'ok', 2000);
    else toast(`أنت على آخر تحديث. يتم الفحص تلقائياً كل ${app.state?.settings.intervalMin || 30} دقيقة.`, 'info', 3000);
  },
  async markSeen(body) {
    // Optimistic update so the UI reacts instantly.
    if (app.state) {
      for (const p of app.state.posts) {
        if (body.all || body.ids?.includes(p.id) || (body.accountId && p.accountId === body.accountId)) p.seen = true;
      }
      render();
    }
    try {
      await api.seen(body);
    } catch {
      /* next refresh restores the truth */
    }
  },
  async rebuildSettings() {
    await refresh();
    if (routeKey === 'settings') {
      routeKey = null;
      render();
    }
  },
};

// ——— Shell ———
const statusText = h('span', { class: 'status-text' });
const statusDot = h('span', { class: 'status-dot' });
let manualBusy = false;
const refreshBtn = h('button', { class: 'icon-btn refresh-btn', 'aria-label': 'تحديث', onclick: () => app.checkNow() }, icon('refresh'));
const topbar = h('header', { class: 'topbar' },
  h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('radar')), h('span', { class: 'brand-name' }, 'رادار')),
  h('button', { class: 'status-pill', onclick: () => app.checkNow(), title: 'تحديث' }, statusDot, statusText),
  refreshBtn);

const navItems = {
  feed: { href: '#/', label: 'الرئيسية', icon: 'home', iconActive: 'homeFill' },
  accounts: { href: '#/accounts', label: 'الحسابات', icon: 'users' },
  settings: { href: '#/settings', label: 'الإعدادات', icon: 'sliders' },
};
const navBadge = h('span', { class: 'nav-badge', hidden: true });
const nav = h('nav', { class: 'bottomnav', 'aria-label': 'التنقل' },
  h('div', { class: 'bottomnav-inner' },
    ...Object.entries(navItems).map(([key, it]) =>
      h('a', { class: 'nav-item', href: it.href, dataset: { route: key } },
        h('span', { class: 'nav-ico' }, icon(it.icon, 'off'), it.iconActive ? icon(it.iconActive, 'on') : null, key === 'feed' ? navBadge : null),
        h('span', null, it.label)))));

const main = h('main', { class: 'main', id: 'main' });
const offline = h('div', { class: 'offline-bar', hidden: true }, icon('alert'), 'تعذّر تحميل آخر التحديثات — تحقق من الإنترنت');
document.getElementById('app').replaceChildren(h('div', { class: 'shell' }, topbar, offline, main, nav));

// ——— Routing ———
let current = null;
let routeKey = null;

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const m = hash.match(/^\/a\/([a-f0-9]{6,32})$/);
  if (m) return { name: 'profile', param: m[1], key: `profile:${m[1]}`, nav: 'accounts' };
  if (hash === '/accounts') return { name: 'accounts', key: 'accounts', nav: 'accounts' };
  if (hash === '/settings') return { name: 'settings', key: 'settings', nav: 'settings' };
  return { name: 'feed', key: 'feed', nav: 'feed' };
}

const factories = {
  feed: () => createFeedView(app),
  profile: (id) => createProfileView(app, id),
  accounts: () => createAccountsView(app),
  settings: () => createSettingsView(app),
};

function render() {
  const r = parseRoute();
  if (r.key !== routeKey) {
    current?.destroy?.();
    current = factories[r.name](r.param);
    routeKey = r.key;
    main.replaceChildren(current.el);
    window.scrollTo(0, 0);
  }
  for (const a of nav.querySelectorAll('.nav-item')) a.classList.toggle('active', a.dataset.route === r.nav);
  if (app.state) {
    main.querySelector('.boot')?.remove();
    current.update(app.state);
  } else if (!main.querySelector('.boot')) main.appendChild(h('div', { class: 'boot' }, spinner(), 'جارٍ التحميل…'));
  renderChrome();
}

function renderChrome() {
  const s = app.state;
  offline.hidden = app.connected || !s;
  topbar.classList.toggle('busy', manualBusy || !!s?.pending);
  refreshBtn.disabled = manualBusy;
  if (!app.connected) {
    statusDot.className = 'status-dot err';
    statusText.textContent = 'غير متصل';
    return;
  }
  if (!s) return;
  const late = s.run.lastFinishedAt && now() - s.run.lastFinishedAt > (s.settings.intervalMin * 2 + 20) * 60_000;
  if (s.pending) {
    statusDot.className = 'status-dot busy';
    statusText.textContent = 'يُجهَّز أول تحديث…';
  } else if (late) {
    statusDot.className = 'status-dot warn';
    statusText.textContent = `آخر تحديث ${ago(s.run.lastFinishedAt)}`;
  } else {
    statusDot.className = 'status-dot ok';
    statusText.textContent = `آخر تحديث ${ago(s.run.lastFinishedAt)}`;
  }
  const unseen = s.posts.filter((p) => !p.seen).length;
  navBadge.hidden = !unseen;
  navBadge.textContent = unseen > 99 ? '99+' : String(unseen);
  setUnseenBadge(unseen);
}

addEventListener('hashchange', render);

// ——— Data: fetch state, detect new posts ———
let knownIds = null;
let inflight = null;
let again = false;

async function refresh() {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      const s = await api.state();
      setServerTime(s.serverTime);
      app.connected = true;
      app.accountsById = new Map(s.accounts.map((a) => [a.id, a]));
      if (knownIds) {
        const fresh = s.posts.filter((p) => !knownIds.has(p.id) && !p.seen);
        if (fresh.length) alertNewPosts(fresh, app.accountsById);
      }
      knownIds = new Set(s.posts.map((p) => p.id));
      app.state = s;
    } catch {
      app.connected = false;
    }
    render();
  })().finally(() => {
    inflight = null;
    if (again) {
      again = false;
      refresh();
    }
  });
  return inflight;
}

refresh();
// The feed is regenerated every 30 minutes; check for it while the page is open.
setInterval(() => (document.visibilityState === 'visible' ? refresh() : null), 2 * 60_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging in the browser console.
window.radar = { app, now };
