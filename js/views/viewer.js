import { h, icon, richText } from '../dom.js';
import { avatar, handle, nameLine, platformChip, spinner } from '../components.js';
import { PLATFORM_NAMES, ago } from '../format.js';
import { toast } from '../dom.js';
import { coverEl, statNodes } from './feed.js';

/**
 * Full-screen, swipe-up/down player (like Reels / For You). Only the active
 * slide holds a live embed so just one video plays at a time.
 */
export function openViewer(app, posts, startId) {
  const start = Math.max(0, posts.findIndex((p) => p.id === startId));
  const scroller = h('div', { class: 'viewer-scroll' });
  const counter = h('span', { class: 'viewer-count' });
  const prevBtn = h('button', { class: 'viewer-nav', 'aria-label': 'السابق', onclick: () => go(active - 1) }, icon('up'));
  const nextBtn = h('button', { class: 'viewer-nav', 'aria-label': 'التالي', onclick: () => go(active + 1) }, icon('down'));
  const root = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'مشاهدة المنشورات' },
    h('div', { class: 'viewer-top' },
      h('button', { class: 'viewer-btn', 'aria-label': 'إغلاق', onclick: () => close() }, icon('x')),
      counter),
    scroller,
    h('div', { class: 'viewer-side' }, prevBtn, nextBtn),
  );

  const slides = posts.map((post) => buildSlide(app, post));
  scroller.append(...slides.map((s) => s.el));

  let active = -1;
  let loadTimer = null;
  let seenTimer = null;

  function setActive(i) {
    if (i === active || i < 0 || i >= slides.length) return;
    active = i;
    counter.textContent = `${i + 1} / ${slides.length}`;
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === slides.length - 1;
    clearTimeout(loadTimer);
    clearTimeout(seenTimer);
    slides.forEach((s, j) => j !== i && s.unload());
    loadTimer = setTimeout(() => slides[i].load(), 220);
    seenTimer = setTimeout(() => {
      const p = posts[i];
      if (!p.seen) app.markSeen({ ids: [p.id] });
    }, 1200);
  }

  function go(i) {
    if (i < 0 || i >= slides.length) return;
    slides[i].el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) setActive(slides.findIndex((s) => s.el === e.target));
  }, { root: scroller, threshold: 0.6 });
  slides.forEach((s) => io.observe(s.el));

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); go(active + 1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(active - 1); }
  }

  let closed = false;
  function teardown() {
    if (closed) return;
    closed = true;
    io.disconnect();
    clearTimeout(loadTimer);
    clearTimeout(seenTimer);
    slides.forEach((s) => s.unload());
    document.removeEventListener('keydown', onKey);
    removeEventListener('popstate', onPop);
    removeEventListener('hashchange', onPop);
    document.documentElement.classList.remove('no-scroll');
    root.classList.add('out');
    setTimeout(() => root.remove(), 200);
  }
  // The phone's back button closes the viewer instead of leaving the app.
  function onPop() {
    teardown();
  }
  function close() {
    if (closed) return;
    if (history.state?.viewer) history.back();
    else teardown();
  }

  history.pushState({ viewer: true }, '');
  addEventListener('popstate', onPop);
  addEventListener('hashchange', onPop); // e.g. tapping the account name opens its profile
  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('no-scroll');
  document.body.appendChild(root);
  slides[start].el.scrollIntoView({ block: 'start' });
  setActive(start);
  root.focus?.();
  return { close };
}

function buildSlide(app, post) {
  const acc = app.accountsById.get(post.accountId) || { username: '?' };
  const isTikTok = post.platform === 'tiktok';
  const frame = h('div', { class: `slide-frame ${isTikTok ? 'frame-tiktok' : 'frame-instagram'}` },
    h('div', { class: 'slide-poster' }, coverEl(post), h('span', { class: 'slide-loading' }, spinner('light'))));
  let iframe = null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(post.url);
      toast('تم نسخ الرابط', 'ok');
    } catch {
      toast(post.url, 'info', 5000);
    }
  };

  const el = h('section', { class: 'slide' },
    h('div', { class: 'slide-bg' }, post.cover ? h('img', { src: post.cover, alt: '', referrerpolicy: 'no-referrer' }) : null),
    frame,
    h('div', { class: 'slide-info' },
      h('a', { class: 'slide-who', href: `#/a/${acc.id}` },
        avatar(acc, 38),
        h('span', { class: 'slide-who-text' },
          h('span', { class: 'slide-name' }, nameLine(acc)),
          h('span', { class: 'slide-sub' }, handle(acc), ' · ', ago(post.createdAt)))),
      h('div', { class: 'slide-actions' },
        h('button', { class: 'viewer-btn', 'aria-label': 'نسخ الرابط', onclick: copyLink }, icon('copy')),
        h('a', { class: 'viewer-open', href: post.url, target: '_blank', rel: 'noopener noreferrer' },
          platformChip(post.platform), icon('external')))),
    post.caption || post.stats
      ? h('div', { class: 'slide-meta' },
        post.caption ? h('p', { class: 'slide-caption', dir: 'auto' }, richText(post.caption)) : null,
        h('div', { class: 'stats light' }, statNodes(post.stats)))
      : null,
  );

  return {
    el,
    load() {
      if (iframe) return;
      iframe = h('iframe', {
        src: post.embedUrl,
        title: `${PLATFORM_NAMES[post.platform]} — ${acc.username}`,
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write',
        allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
        loading: 'eager',
      });
      iframe.addEventListener('load', () => frame.classList.add('loaded'));
      frame.appendChild(iframe);
    },
    unload() {
      if (!iframe) return;
      iframe.remove();
      iframe = null;
      frame.classList.remove('loaded');
    },
  };
}
