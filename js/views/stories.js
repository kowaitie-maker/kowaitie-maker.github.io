import { h, icon } from '../dom.js';
import { avatar, nameLine } from '../components.js';
import { ago } from '../format.js';

// Which stories this device has watched (ids), like the grey ring in Instagram.
const SEEN_KEY = 'radar.storiesSeen';
let seen = null;
function seenSet() {
  if (seen) return seen;
  try {
    seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    seen = new Set();
  }
  return seen;
}
function markSeen(id) {
  const set = seenSet();
  if (set.has(id)) return;
  set.add(id);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-2000)));
  } catch {
    /* storage blocked */
  }
}
export const hasUnseenStory = (a) => (a.stories || []).some((s) => !seenSet().has(s.id));

const IMAGE_MS = 5000;

/**
 * Full-screen story player. Plays the stories of `accounts` in order,
 * starting with `startId`, then moves on to the next account.
 */
export function openStories(accounts, startId, { onClose } = {}) {
  const list = accounts.filter((a) => a.stories?.length);
  let ai = Math.max(0, list.findIndex((a) => a.id === startId));
  if (!list.length) return;
  const firstUnseen = (a) => Math.max(0, a.stories.findIndex((s) => !seenSet().has(s.id)));
  let si = firstUnseen(list[ai]);

  let muted = false;
  let paused = false;
  let elapsed = 0;
  let duration = IMAGE_MS;
  let lastTick = 0;
  let raf = 0;
  let current = null; // the <video> or <img>

  const bars = h('div', { class: 'sv-bars' });
  const who = h('div', { class: 'sv-who' });
  const muteBtn = h('button', { class: 'sv-btn', 'aria-label': 'الصوت', onclick: (e) => { e.stopPropagation(); toggleMute(); } });
  const mediaBox = h('div', { class: 'sv-media' });
  const openLink = h('a', { class: 'sv-open', target: '_blank', rel: 'noopener noreferrer' }, 'فتح في إنستغرام', icon('external'));
  const stage = h('div', { class: 'sv-stage' },
    mediaBox,
    h('div', { class: 'sv-shade' }),
    h('div', { class: 'sv-top' }, bars, h('div', { class: 'sv-head' }, who, muteBtn,
      h('button', { class: 'sv-btn', 'aria-label': 'إغلاق', onclick: (e) => { e.stopPropagation(); close(); } }, icon('x')))),
    h('div', { class: 'sv-foot' }, openLink));
  const root = h('div', { class: 'sv', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'الستوري' }, stage);

  function paintMute() {
    muteBtn.hidden = !(current instanceof HTMLVideoElement);
    muteBtn.replaceChildren(icon(muted ? 'volumeOff' : 'volume'));
  }
  function toggleMute() {
    muted = !muted;
    if (current instanceof HTMLVideoElement) current.muted = muted;
    paintMute();
  }

  function paintBars() {
    const a = list[ai];
    bars.replaceChildren(...a.stories.map((s, i) => h('span', { class: 'sv-bar' }, h('span', { class: 'sv-fill', style: { width: i < si ? '100%' : '0%' } }))));
  }
  function setProgress(p) {
    const fill = bars.children[si]?.firstChild;
    if (fill) fill.style.width = `${Math.min(100, p * 100)}%`;
  }

  function stopMedia() {
    cancelAnimationFrame(raf);
    if (current instanceof HTMLVideoElement) {
      current.pause();
      current.removeAttribute('src');
      current.load();
    }
    current = null;
  }

  function show(nextAi, nextSi) {
    stopMedia();
    ai = nextAi;
    si = nextSi;
    const a = list[ai];
    const s = a.stories[si];
    markSeen(s.id);
    paintBars();
    who.replaceChildren(avatar(a, 34), h('div', { class: 'sv-name' }, nameLine(a), h('span', { class: 'sv-time' }, ago(s.takenAt))));
    openLink.href = `https://www.instagram.com/stories/${encodeURIComponent(a.username)}/${encodeURIComponent(s.id)}/`;
    elapsed = 0;
    lastTick = performance.now();

    const showImage = () => {
      const img = h('img', { src: s.image, alt: '', decoding: 'async' });
      mediaBox.replaceChildren(img);
      current = img;
      duration = IMAGE_MS;
      paintMute();
      tick();
    };

    if (s.video) {
      const v = h('video', { src: s.video, poster: s.image || null, playsinline: true, 'webkit-playsinline': true, preload: 'auto' });
      v.muted = muted;
      v.addEventListener('ended', () => next());
      v.addEventListener('error', () => current === v && showImage());
      mediaBox.replaceChildren(v);
      current = v;
      duration = (s.duration || 15) * 1000;
      paintMute();
      const play = v.play();
      // Browsers may refuse sound without a tap: retry muted and let the viewer unmute.
      if (play?.catch) {
        play.catch(() => {
          if (current !== v) return;
          muted = true;
          v.muted = true;
          paintMute();
          v.play().catch(() => {});
        });
      }
      tick();
    } else if (s.image) {
      showImage();
    } else {
      next();
    }
  }

  function tick() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame((t) => {
      if (!paused) {
        if (current instanceof HTMLVideoElement && current.duration) {
          setProgress(current.currentTime / current.duration);
        } else {
          elapsed += t - lastTick;
          setProgress(elapsed / duration);
          if (elapsed >= duration) return next();
        }
      }
      lastTick = t;
      tick();
    });
  }

  function next() {
    const a = list[ai];
    if (si + 1 < a.stories.length) show(ai, si + 1);
    else if (ai + 1 < list.length) show(ai + 1, firstUnseen(list[ai + 1]));
    else close();
  }
  function prev() {
    if (si > 0) show(ai, si - 1);
    else if (ai > 0) show(ai - 1, list[ai - 1].stories.length - 1);
    else show(ai, 0);
  }
  function setPaused(p) {
    paused = p;
    root.classList.toggle('paused', p);
    if (current instanceof HTMLVideoElement) (p ? current.pause() : current.play().catch(() => {}));
  }

  // Tap: left side = next (right-to-left reading), right side = previous. Hold = pause.
  let holdTimer = null;
  let held = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a')) return;
    held = false;
    holdTimer = setTimeout(() => {
      held = true;
      setPaused(true);
    }, 220);
  });
  stage.addEventListener('pointerup', (e) => {
    if (e.target.closest('button, a')) return;
    clearTimeout(holdTimer);
    if (held) return setPaused(false);
    const rect = stage.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.6) next();
    else prev();
  });
  stage.addEventListener('pointercancel', () => {
    clearTimeout(holdTimer);
    if (held) setPaused(false);
  });

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') next();
    else if (e.key === 'ArrowRight') prev();
    else if (e.key === ' ') {
      e.preventDefault();
      setPaused(!paused);
    }
  }
  const onVisibility = () => document.hidden && !paused && setPaused(true);

  let closed = false;
  function teardown() {
    if (closed) return;
    closed = true;
    stopMedia();
    clearTimeout(holdTimer);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('popstate', teardown);
    document.documentElement.classList.remove('no-scroll');
    root.classList.add('out');
    setTimeout(() => root.remove(), 200);
    onClose?.();
  }
  function close() {
    if (closed) return;
    if (history.state?.stories) history.back();
    else teardown();
  }

  history.pushState({ stories: true }, '');
  addEventListener('popstate', teardown);
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  document.documentElement.classList.add('no-scroll');
  document.body.appendChild(root);
  show(ai, si);
  return { close };
}
