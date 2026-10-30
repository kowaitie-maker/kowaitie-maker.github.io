import { fill, h, icon, richText, syncList } from '../dom.js';
import { hasUnseenStory } from './stories.js';
import { avatar, emptyState, handle, nameLine, platformBadge, spinner } from '../components.js';
import { PLATFORM_NAMES, accountsText, ago, compact, dayKey, dayLabel, duration, fullDate, kindWord, longDate, newPostsText } from '../format.js';

const FILTERS = [
  ['all', 'الكل'],
  ['unseen', 'لم أشاهده'],
  ['tiktok', 'تيك توك'],
  ['instagram', 'إنستغرام'],
];

export const storyUrl = (a) => `https://www.instagram.com/stories/${encodeURIComponent(a.username)}/`;

export function statNodes(stats = {}) {
  const out = [];
  const add = (name, value, label) => {
    const v = compact(value);
    if (v) out.push(h('span', { class: 'stat', title: label }, icon(name), h('bdi', null, v)));
  };
  add('eye', stats.views, 'مشاهدات');
  add('heart', stats.likes, 'إعجابات');
  add('comment', stats.comments, 'تعليقات');
  return out;
}

export function coverEl(post, cls = '') {
  const ph = h('span', { class: `cover-ph cover-ph-${post.platform} ${cls}`.trim() }, icon(post.platform));
  if (!post.cover) return ph;
  const img = h('img', { class: `cover ${cls}`.trim(), src: post.cover, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(ph));
  return img;
}

export function createFeedView(app) {
  const stories = h('div', { class: 'stories', role: 'list', 'aria-label': 'الحسابات' });
  const chips = h('div', { class: 'chips', role: 'tablist' });
  const notice = h('div', { class: 'notice-slot' });
  const banner = h('button', { class: 'fresh-banner', hidden: true, onclick: () => releaseHeld(true) });
  const list = h('div', { class: 'feed-list' });
  const emptySlot = h('div');
  const el = h('section', { class: 'view view-feed' }, stories, chips, notice, banner, list, emptySlot);

  let displayed = null; // ids rendered so far (null before first render)
  const held = new Set(); // new posts waiting behind the banner while the user is scrolled down
  let last = null;

  function releaseHeld(scrollTop) {
    held.clear();
    banner.hidden = true;
    if (last) update(last, { force: true });
    if (scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const onScroll = () => {
    if (held.size && window.scrollY < 80) releaseHeld(false);
  };
  addEventListener('scroll', onScroll, { passive: true });

  function renderStories(state) {
    const unseenBy = new Map();
    for (const p of state.posts) if (!p.seen) unseenBy.set(p.accountId, (unseenBy.get(p.accountId) || 0) + 1);
    // Like the apps: unwatched stories first, then accounts with new posts.
    const score = (a) => (hasUnseenStory(a) ? 4 : 0) + (a.hasStory ? 2 : 0) + (unseenBy.get(a.id) ? 1 : 0);
    const accounts = [...state.accounts].sort((a, b) => score(b) - score(a) || (b.latestPostAt || 0) - (a.latestPostAt || 0));
    const items = [{ type: 'add' }, ...accounts.map((a) => ({ type: 'acc', a, unseen: unseenBy.get(a.id) || 0 }))];
    syncList(stories, items, {
      key: (i) => (i.type === 'add' ? 'add' : i.a.id),
      create: (i) => {
        if (i.type === 'add') {
          return h('button', { class: 'story story-add', role: 'listitem', onclick: () => app.openAddSheet() },
            h('span', { class: 'ring' }, h('span', { class: 'add-circle' }, icon('plus'))),
            h('span', { class: 'story-label' }, 'إضافة'));
        }
        const s = h('a', { class: 'story', role: 'listitem', href: `#/a/${i.a.id}` });
        // Saved stories play here; otherwise the link opens the story in Instagram.
        s.addEventListener('click', (e) => {
          if (s._acc?.stories?.length) {
            e.preventDefault();
            app.openStories(s._acc.id);
          }
        });
        fillStory(s, i, state);
        return s;
      },
      update: (s, i) => i.type === 'acc' && fillStory(s, i, state),
    });
  }

  function fillStory(s, { a, unseen }, state) {
    const checking = state.run.currentAccountId === a.id;
    s._acc = a;
    const saved = a.stories?.length > 0;
    const story = (saved || !!a.hasStory) && a.platform === 'instagram';
    const watched = saved && !hasUnseenStory(a);
    s.className = `story${unseen ? ' unseen' : ''}${story ? ' has-story' : ''}${watched ? ' story-seen' : ''}${checking ? ' checking' : ''}${a.lastError ? ' has-error' : ''}`;
    // Like the apps: tapping a story ring opens the story (in the Instagram app on phones).
    if (story) {
      s.setAttribute('href', storyUrl(a));
      s.setAttribute('target', '_blank');
      s.setAttribute('rel', 'noopener noreferrer');
    } else {
      s.setAttribute('href', `#/a/${a.id}`);
      s.removeAttribute('target');
      s.removeAttribute('rel');
    }
    s.setAttribute('aria-label', `${a.displayName || a.username}${story ? ' — لديه ستوري' : ''}${unseen ? ` — ${unseen} جديد` : ''}`);
    s.replaceChildren(
      h('span', { class: 'ring' }, avatar(a, 60), platformBadge(a.platform, 'story-pf'), a.lastError ? h('span', { class: 'err-dot' }) : null,
        story ? h('span', { class: 'story-pill' }, 'ستوري') : null),
      h('span', { class: 'story-label', dir: 'auto' }, a.displayName || a.username),
    );
  }

  function renderChips(state) {
    const unseen = state.posts.filter((p) => !p.seen).length;
    const counts = { all: state.posts.length, unseen };
    fill(chips,
      ...FILTERS.map(([key, label]) =>
        h('button', {
          class: `chip${app.ui.filter === key ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': app.ui.filter === key ? 'true' : 'false',
          onclick: () => {
            app.ui.filter = key;
            displayed = null;
            held.clear();
            update(state, { force: true });
          },
        },
        key === 'tiktok' || key === 'instagram' ? icon(key) : null,
        label,
        key === 'unseen' && counts.unseen ? h('span', { class: 'chip-count' }, String(counts.unseen)) : null),
      ),
      unseen
        ? h('button', { class: 'chip chip-action', onclick: () => app.markSeen({ all: true }) }, icon('checks'), 'تعليم الكل كمُشاهَد')
        : null,
    );
  }

  function renderNotice(state) {
    const failing = state.accounts.filter((a) => a.lastError && !a.paused);
    if (!failing.length) return notice.replaceChildren();
    const names = failing.slice(0, 2).flatMap((a, i) => [i ? '، ' : '', h('bdi', { dir: 'ltr' }, `@${a.username}`)]);
    notice.replaceChildren(
      h('a', { class: 'notice', href: '#/accounts' },
        icon('alert'),
        h('span', null, 'تعذّر جلب ', names, failing.length > 2 ? ` و${failing.length - 2} غيرها` : '', ' — ', h('u', null, 'التفاصيل'))),
    );
  }

  function createCard(post) {
    const acc = app.accountsById.get(post.accountId) || { username: '?' };
    const timeEl = h('time', { datetime: new Date(post.createdAt).toISOString(), title: fullDate(post.createdAt) });
    const stats = h('div', { class: 'stats' });
    const isStill = post.kind === 'image' || post.kind === 'carousel' || post.kind === 'photo';
    const dur = duration(post.duration);
    const caption = post.caption ? h('p', { class: 'caption', dir: 'auto' }, richText(post.caption)) : null;
    const more = caption && (post.caption.length > 120 || post.caption.split('\n').length > 3)
      ? h('button', { class: 'more', onclick: (e) => {
        caption.classList.toggle('open');
        e.currentTarget.textContent = caption.classList.contains('open') ? 'عرض أقل' : 'المزيد';
      } }, 'المزيد')
      : null;

    const card = h('article', { class: 'card' },
      h('header', { class: 'card-head' },
        h('a', { href: `#/a/${acc.id}`, class: 'card-avatar', 'aria-label': acc.displayName || acc.username }, avatar(acc, 42)),
        h('div', { class: 'who' },
          h('a', { href: `#/a/${acc.id}`, class: 'name' }, nameLine(acc)),
          h('div', { class: 'sub' }, handle(acc), h('span', { class: 'sep' }, '·'), timeEl)),
        h('span', { class: 'badge-new' }, 'جديد'),
        platformBadge(post.platform)),
      h('button', { class: 'card-media', 'aria-label': `مشاهدة ${kindWord(post.kind)}`, onclick: () => app.openViewer(post.id) },
        coverEl(post),
        h('span', { class: 'media-shade' }),
        h('span', { class: 'play' }, h('span', { class: 'play-btn' }, icon(isStill ? 'images' : 'play'))),
        dur ? h('span', { class: 'media-tag media-dur' }, dur) : null,
        h('span', { class: 'media-tag media-kind' }, kindWord(post.kind))),
      h('div', { class: 'card-body' },
        caption,
        more,
        h('div', { class: 'card-foot' },
          stats,
          h('a', { class: 'open-app', href: post.url, target: '_blank', rel: 'noopener noreferrer', onclick: () => app.markSeen({ ids: [post.id] }) },
            `فتح في ${PLATFORM_NAMES[post.platform]}`, icon('external')))),
    );
    card._refs = { timeEl, stats };
    updateCard(card, post);
    return card;
  }

  function updateCard(card, post) {
    card.classList.toggle('seen', !!post.seen);
    card._refs.timeEl.textContent = ago(post.createdAt);
    card._refs.stats.replaceChildren(...statNodes(post.stats));
  }

  function visiblePosts(state) {
    const f = app.ui.filter;
    return state.posts.filter((p) => (f === 'all' ? true : f === 'unseen' ? !p.seen : p.platform === f));
  }

  function update(state, { force = false } = {}) {
    last = state;
    renderStories(state);
    renderChips(state);
    renderNotice(state);

    let posts = visiblePosts(state);
    if (displayed && !force) {
      const arrivals = posts.filter((p) => !displayed.has(p.id));
      if (arrivals.length && window.scrollY > 200) for (const p of arrivals) held.add(p.id);
    }
    if (held.size) {
      posts = posts.filter((p) => !held.has(p.id));
      banner.hidden = false;
      const heldAccounts = [...new Set(state.posts.filter((p) => held.has(p.id)).map((p) => p.accountId))].slice(0, 3);
      banner.replaceChildren(
        icon('arrowUp'),
        h('span', { class: 'banner-avatars' }, heldAccounts.map((id) => avatar(app.accountsById.get(id), 22))),
        newPostsText(held.size),
      );
    } else banner.hidden = true;

    const fresh = displayed ? new Set(posts.filter((p) => !displayed.has(p.id)).map((p) => p.id)) : new Set();
    displayed = new Set([...(displayed || []), ...posts.map((p) => p.id)]);

    const items = [];
    let lastDay = null;
    for (const p of posts) {
      const dk = dayKey(p.createdAt);
      if (dk !== lastDay) {
        items.push({ type: 'day', key: `day-${dk}`, label: dayLabel(p.createdAt) });
        lastDay = dk;
      }
      items.push({ type: 'post', key: p.id, post: p });
    }
    syncList(list, items, {
      key: (i) => i.key,
      create: (i) => {
        if (i.type === 'day') return h('h3', { class: 'day' }, i.label);
        const c = createCard(i.post);
        if (fresh.has(i.post.id)) c.classList.add('arrive');
        return c;
      },
      update: (node, i) => (i.type === 'day' ? (node.textContent = i.label) : updateCard(node, i.post)),
    });

    emptySlot.replaceChildren(posts.length || held.size ? '' : renderEmpty(state));
  }

  function renderEmpty(state) {
    if (!state.accounts.length) {
      return emptyState({
        title: 'ابدأ بمتابعة حساب',
        body: 'الصق رابط أي حساب من تيك توك أو إنستغرام، وسيظهر هنا كل منشور جديد ينشره.',
        action: h('button', { class: 'btn primary', onclick: () => app.openAddSheet() }, icon('plus'), 'إضافة حساب'),
      });
    }
    if (state.posts.length && app.ui.filter === 'unseen') {
      return emptyState({ title: 'شاهدت كل الجديد 🎉', body: 'سنخبرك فور نشر أي منشور جديد.' });
    }
    if (state.posts.length) {
      return emptyState({ title: 'لا شيء هنا', body: 'لا توجد منشورات جديدة على هذه المنصة بعد.' });
    }
    const n = state.accounts.length;
    if (state.pending) {
      return emptyState({
        title: 'نجهّز الصفحة…',
        body: `أول فحص لـ${accountsText(n)} يعمل الآن على خوادم GitHub ويستغرق دقائق قليلة. ستظهر المنشورات هنا تلقائياً.`,
        action: h('span', { class: 'muted-line' }, spinner(), 'بانتظار أول تحديث'),
      });
    }
    return emptyState({
      title: 'لا جديد حتى الآن',
      body: `نراقب ${accountsText(n)} منذ ${longDate(state.settings.since)}، ونفحصها كل ${state.settings.intervalMin} دقيقة. أي فيديو أو منشور جديد سيظهر هنا تلقائياً.`,
      action: h('button', { class: 'btn primary', onclick: () => app.checkNow() }, icon('refresh'), 'تحديث'),
    });
  }

  return {
    el,
    update,
    destroy() {
      removeEventListener('scroll', onScroll);
    },
    /** Posts in on-screen order, for swiping in the viewer. */
    currentList: () => (last ? visiblePosts(last).filter((p) => !held.has(p.id)) : []),
  };
}
