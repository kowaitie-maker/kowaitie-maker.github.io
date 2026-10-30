import { h, icon } from './dom.js';
import { PLATFORM_NAMES } from './format.js';

const HUES = [262, 330, 200, 18, 150, 290, 45, 180];
function hueFor(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return HUES[n % HUES.length];
}

/** Round avatar: cached image, or coloured initials while we wait for the first fetch. */
export function avatar(account, size = 40, cls = '') {
  const label = account?.displayName || account?.username || '?';
  const initials = [...label.replace(/[@._]/g, ' ').trim()][0]?.toUpperCase() || '?';
  const hue = hueFor(account?.username || label);
  const el = h('span', {
    class: `avatar ${cls}`.trim(),
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, '--hue': hue },
  }, h('span', { class: 'avatar-initial' }, initials));
  if (account?.avatar) {
    const img = h('img', { src: account.avatar, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    el.appendChild(img);
  }
  return el;
}

export function platformBadge(platform, cls = '') {
  return h('span', { class: `pbadge pbadge-${platform} ${cls}`.trim(), title: PLATFORM_NAMES[platform] }, icon(platform));
}

export function platformChip(platform) {
  return h('span', { class: `pchip pchip-${platform}` }, icon(platform), PLATFORM_NAMES[platform]);
}

export function displayName(account) {
  return account?.displayName || account?.username || '';
}

export function nameLine(account) {
  return h('span', { class: 'name-line' },
    h('span', { class: 'name-text' }, displayName(account)),
    account?.verified ? icon('verified', 'verified') : null,
  );
}

export function handle(account) {
  return h('bdi', { class: 'handle', dir: 'ltr' }, `@${account?.username || ''}`);
}

export function spinner(cls = '') {
  return h('span', { class: `spinner ${cls}`.trim(), 'aria-hidden': 'true' });
}

export function emptyState({ title, body, action }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'radar-anim', 'aria-hidden': 'true' }, h('span', { class: 'sweep' }), h('span', { class: 'blip b1' }), h('span', { class: 'blip b2' })),
    h('h2', null, title),
    body ? h('p', null, body) : null,
    action || null,
  );
}
