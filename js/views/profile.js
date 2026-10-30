import { fill, h, icon, syncList } from '../dom.js';
import { avatar, emptyState, handle, nameLine, platformChip } from '../components.js';
import { PLATFORM_NAMES, ago, compact, longDate } from '../format.js';
import { coverEl, storyUrl } from './feed.js';

/** One followed account: header like a social profile + grid of its new posts. */
export function createProfileView(app, accountId) {
  const head = h('div', { class: 'profile-head' });
  const grid = h('div', { class: 'grid' });
  const emptySlot = h('div');
  let posts = [];
  const el = h('section', { class: 'view view-profile' },
    h('div', { class: 'subbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'رجوع', onclick: () => (history.length > 1 ? history.back() : (location.hash = '#/')) }, icon('back')),
      h('span', { class: 'subbar-title' }, 'الحساب')),
    head, grid, emptySlot);

  function update(state) {
    const a = state.accounts.find((x) => x.id === accountId);
    if (!a) {
      head.replaceChildren();
      grid.replaceChildren();
      emptySlot.replaceChildren(emptyState({ title: 'الحساب غير موجود', body: 'ربما حذفته من قائمة المتابعة.' }));
      return;
    }
    posts = state.posts.filter((p) => p.accountId === a.id);
    const unseen = posts.filter((p) => !p.seen).length;

    fill(head,
      h('div', { class: `profile-top${unseen ? ' unseen' : ''}` },
        a.hasStory && a.platform === 'instagram'
          ? h('a', { class: 'ring big story-ring', href: storyUrl(a), target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'شاهد الستوري' }, avatar(a, 88))
          : h('span', { class: 'ring big' }, avatar(a, 88)),
        h('div', { class: 'profile-id' },
          h('h1', { class: 'profile-name' }, nameLine(a)),
          h('div', { class: 'profile-handle' }, handle(a), platformChip(a.platform)),
          a.bio ? h('p', { class: 'profile-bio', dir: 'auto' }, a.bio) : null)),
      h('div', { class: 'profile-stats' },
        stat(compact(a.followers) ?? '—', 'متابِع'),
        stat(String(posts.length), `جديد منذ ${longDate(state.settings.since)}`),
        stat(a.latestPostAt ? ago(a.latestPostAt) : '—', 'آخر نشر')),
      h('div', { class: 'profile-actions' },
        a.hasStory && a.platform === 'instagram'
          ? h('a', { class: 'btn story-btn', href: storyUrl(a), target: '_blank', rel: 'noopener noreferrer' }, icon('play'), `شاهد الستوري${a.storySince ? ` · ${ago(a.storySince)}` : ''}`)
          : null,
        h('a', { class: 'btn primary', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, `فتح في ${PLATFORM_NAMES[a.platform]}`, icon('external')),
        unseen ? h('button', { class: 'btn', onclick: () => app.markSeen({ accountId: a.id }) }, icon('checks'), 'تعليم كمُشاهَد') : null),
      a.lastError ? h('a', { class: 'notice', href: '#/accounts' }, icon('alert'), h('span', null, a.lastError.message)) : null,
    );

    syncList(grid, posts, {
      key: (p) => p.id,
      create: (p) => {
        const tile = h('button', { class: `tile${p.platform === 'tiktok' ? ' tall' : ''}`, onclick: () => app.openViewer(p.id, posts) },
          coverEl(p),
          h('span', { class: 'tile-shade' }),
          h('span', { class: 'tile-views' }, icon(p.kind === 'image' || p.kind === 'carousel' || p.kind === 'photo' ? 'images' : 'play'), h('bdi', null, compact(p.stats?.views ?? p.stats?.likes) ?? '')),
          h('span', { class: 'tile-new' }, 'جديد'));
        tile.classList.toggle('seen', !!p.seen);
        return tile;
      },
      update: (tile, p) => tile.classList.toggle('seen', !!p.seen),
    });

    emptySlot.replaceChildren(posts.length ? '' : emptyState({
      title: 'لا منشورات جديدة بعد',
      body: a.latestPostAt
        ? `آخر منشور له كان ${ago(a.latestPostAt)}، قبل تاريخ بداية المتابعة. سيظهر هنا أي جديد.`
        : 'سيظهر هنا كل ما ينشره من الآن فصاعداً.',
    }));
  }

  return { el, update };
}

function stat(value, label) {
  return h('div', { class: 'pstat' }, h('bdi', { class: 'pstat-v' }, value), h('span', { class: 'pstat-l' }, label));
}
