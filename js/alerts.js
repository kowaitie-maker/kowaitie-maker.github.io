// New-post alerts on this device: chime, vibration, system notification, tab title and app badge.
import { prefs } from './prefs.js';
import { PLATFORM_NAMES, kindWord } from './format.js';

let audio = null;
// Browsers only allow sound after the user has interacted with the page once.
addEventListener('pointerdown', () => {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    /* no audio */
  }
}, { once: false, passive: true });

export function chime() {
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + i * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.18, t + i * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(t + i * 0.12);
    osc.stop(t + i * 0.12 + 0.4);
  }
}

export const notificationsSupported = () => 'Notification' in window && window.isSecureContext;

export async function requestNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

async function show(title, options) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) return reg.showNotification(title, options);
    return new Notification(title, options);
  } catch {
    /* ignore */
  }
}

export function alertNewPosts(posts, accountsById) {
  if (!posts.length) return;
  if (prefs.sound) chime();
  navigator.vibrate?.([60, 40, 60]);
  if (!prefs.notify || !notificationsSupported() || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  for (const p of posts.slice(0, 3)) {
    const a = accountsById.get(p.accountId);
    const who = a?.displayName || (a ? `@${a.username}` : 'حساب تتابعه');
    show(`${who} نشر ${kindWord(p.kind)} جديد`, {
      body: p.caption ? p.caption.slice(0, 140) : `على ${PLATFORM_NAMES[p.platform]}`,
      icon: a?.avatar || 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: p.id,
      data: { url: './' },
    });
  }
  if (posts.length > 3) show(`و${posts.length - 3} منشورات جديدة أخرى`, { tag: 'radar-more', icon: 'icons/icon-192.png' });
}

export function setUnseenBadge(count) {
  document.title = count ? `(${count}) رادار` : 'رادار';
  try {
    if (count) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch {
    /* unsupported */
  }
}
