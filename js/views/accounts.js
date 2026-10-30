import { h, icon, syncList } from '../dom.js';
import { avatar, emptyState, handle, nameLine, platformChip, spinner } from '../components.js';
import { STRATEGY_NAMES, ago, compact, newPostsText } from '../format.js';
import { api } from '../api.js';

const HINTS = {
  tiktok: {
    blocked: 'تيك توك يحجب الطلبات الآلية أحياناً، وسنعيد المحاولة كل نصف ساعة تلقائياً.',
    parse: 'سنعيد المحاولة تلقائياً. إن استمر الخطأ أياماً فقد غيّر تيك توك طريقة عرض البيانات.',
    rate_limited: 'سنعيد المحاولة تلقائياً في الفحص القادم.',
    login: 'هذا الحساب يتطلب تسجيل الدخول لعرضه.',
  },
  instagram: {
    login: 'إنستغرام يقيّد الزوار غير المسجّلين. أضف مفتاح الدخول IG_SESSIONID — الطريقة في الإعدادات.',
    blocked: 'إنستغرام يقيّد الزوار غير المسجّلين. أضف مفتاح الدخول IG_SESSIONID — الطريقة في الإعدادات.',
    rate_limited: 'إنستغرام يحدّ عدد الطلبات. سنعيد المحاولة تلقائياً، وإضافة IG_SESSIONID (في الإعدادات) تحل المشكلة غالباً.',
    parse: 'أضف مفتاح الدخول IG_SESSIONID — الطريقة في الإعدادات.',
  },
  any: {
    network: 'تعذّر الوصول للمنصة في هذا الفحص، وسنعيد المحاولة تلقائياً.',
    not_found: 'تأكد من اسم المستخدم — ربما غيّره صاحب الحساب.',
    private: 'لا يمكن متابعة الحسابات الخاصة.',
  },
};

export function createAccountsView(app) {
  const list = h('div', { class: 'acc-list' });
  const emptySlot = h('div');
  const el = h('section', { class: 'view view-accounts' },
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, 'الحسابات'),
      h('button', { class: 'btn primary small', onclick: () => app.openAddSheet() }, icon('plus'), 'إضافة')),
    list, emptySlot);

  const openDetails = new Set();

  function update(state) {
    const counts = new Map();
    for (const p of state.posts) counts.set(p.accountId, (counts.get(p.accountId) || 0) + 1);
    syncList(list, state.accounts, {
      key: (a) => a.id,
      create: (a) => {
        const card = h('article', { class: 'acc-card' });
        fill(card, a, state, counts.get(a.id) || 0);
        return card;
      },
      update: (card, a) => fill(card, a, state, counts.get(a.id) || 0),
    });
    emptySlot.replaceChildren(state.accounts.length ? '' : emptyState({
      title: 'لا حسابات بعد',
      body: 'أضف رابط حساب من تيك توك أو إنستغرام لتبدأ المتابعة.',
      action: h('button', { class: 'btn primary', onclick: () => app.openAddSheet() }, icon('plus'), 'إضافة حساب'),
    }));
  }

  function fill(card, a, state, newCount) {
    const checking = state.run.currentAccountId === a.id;
    const status = statusLine(a, checking);
    const hint = a.lastError && (HINTS[a.platform]?.[a.lastError.kind] || HINTS.any[a.lastError.kind]);
    const detailsOpen = openDetails.has(a.id);

    card.className = 'acc-card';
    card.replaceChildren(
      h('a', { class: 'acc-top', href: state.pending ? a.url : `#/a/${a.id}`, ...(state.pending ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
        avatar(a, 54),
        h('div', { class: 'acc-id' },
          h('div', { class: 'acc-name' }, nameLine(a)),
          h('div', { class: 'acc-sub' }, handle(a), a.followers != null ? h('span', null, ` · ${compact(a.followers)} متابِع`) : null)),
        platformChip(a.platform)),
      h('div', { class: 'acc-status' },
        h('div', { class: `status-row status-${status.tone}` }, status.tone === 'busy' ? spinner() : h('span', { class: 'dot' }), h('span', null, status.text)),
        a.lastError
          ? h('div', { class: 'status-row muted' }, icon('clock'), h('span', null, a.nextCheckAt ? `المحاولة التالية ${ago(a.nextCheckAt)}` : 'سنعيد المحاولة في الفحص القادم'))
          : null,
        hint ? h('div', { class: 'status-hint' }, hint) : null,
        a.stories?.length
          ? h('button', { class: 'status-row story-row', onclick: () => app.openStories(a.id) },
            icon('play'), h('span', null, `${a.stories.length === 1 ? 'ستوري واحد' : `${a.stories.length} ستوري`} الآن — اضغط للمشاهدة`))
          : a.hasStory && a.platform === 'instagram'
            ? h('a', { class: 'status-row story-row', href: `https://www.instagram.com/stories/${encodeURIComponent(a.username)}/`, target: '_blank', rel: 'noopener noreferrer' },
              icon('play'), h('span', null, `لديه ستوري الآن${a.storySince ? ` (${ago(a.storySince)})` : ''} — اضغط للمشاهدة`))
            : null,
        h('div', { class: 'status-row muted' }, icon('bell'),
          h('span', null, `${newPostsText(newCount)} منذ بداية المتابعة`)),
        h('div', { class: 'status-row muted' }, icon('clock'),
          h('span', null, a.latestPostAt ? `آخر نشر له ${ago(a.latestPostAt)}` : a.lastOkAt ? 'لم نرَ منشورات حديثة' : 'آخر نشر: غير معروف بعد')),
        a.strategy && !a.lastError ? h('div', { class: 'status-row muted small' }, icon('info'), h('span', null, `طريقة الجلب: ${STRATEGY_NAMES[a.strategy] || a.strategy}`)) : null,
        a.lastError
          ? h('button', { class: 'linkish', onclick: () => {
            if (detailsOpen) openDetails.delete(a.id);
            else openDetails.add(a.id);
            fill(card, a, state, newCount);
          } }, detailsOpen ? 'إخفاء التفاصيل التقنية' : 'التفاصيل التقنية')
          : null,
        a.lastError && detailsOpen ? h('pre', { class: 'tech', dir: 'ltr' }, a.lastError.detail) : null),
      h('div', { class: 'acc-actions' },
        h('a', { class: 'btn', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'فتح الحساب'),
        state.pending ? null : h('button', { class: 'btn danger-ghost', 'aria-label': 'إلغاء المتابعة', onclick: () => remove(a) }, icon('trash'))),
    );
  }

  /** Unfollowing edits the list on GitHub: confirm, then hand over to a pre-filled request. */
  function remove(a) {
    const url = api.unfollowUrl(a);
    const close = () => {
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 180);
    };
    const wrap = h('div', { class: 'dialog-wrap', onclick: (e) => e.target === wrap && close() },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('h3', null, 'إلغاء متابعة ', h('bdi', { dir: 'ltr' }, `@${a.username}`), '؟'),
        h('p', null, 'سيفتح GitHub بطلب جاهز. اضغط «Submit new issue» للتأكيد، ويختفي الحساب ومنشوراته من الصفحة خلال دقائق.'),
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn ghost', onclick: close }, 'تراجع'),
          url
            ? h('a', { class: 'btn danger', href: url, target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(close, 300) }, 'متابعة إلى GitHub')
            : h('span', { class: 'muted-line' }, 'افتح الصفحة من رابطها على github.io')),
      ),
    );
    document.body.appendChild(wrap);
  }

  return { el, update };
}

function statusLine(a, checking) {
  if (checking) return { tone: 'busy', text: 'يفحص الآن…' };
  if (a.lastError) return { tone: 'err', text: `تعذّر الجلب: ${a.lastError.message}` };
  if (a.lastOkAt) return { tone: 'ok', text: `يعمل · آخر فحص ${ago(a.lastOkAt)}` };
  return { tone: 'idle', text: 'بانتظار أول فحص…' };
}
