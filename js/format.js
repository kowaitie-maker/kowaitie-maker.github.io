const LOCALE = 'ar-u-nu-latn';
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

let offset = 0;
/** Keep client clock aligned with the server so "x minutes ago" is right. */
export function setServerTime(serverNow) {
  offset = serverNow - Date.now();
}
export const now = () => Date.now() + offset;

export function compact(n) {
  return n == null ? null : compactFmt.format(n);
}

export function ago(ms) {
  if (!ms) return '';
  const diff = (ms - now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff <= 0 ? 'الآن' : 'خلال لحظات';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return dateFmt.format(ms);
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function dayLabel(ms) {
  const today = startOfDay(now());
  const day = startOfDay(ms);
  if (day === today) return 'اليوم';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return 'أمس';
  return dayFmt.format(ms);
}

export const longDate = (ms) => dateFmt.format(ms);
export const fullDate = (ms) => fullFmt.format(ms);

export function duration(sec) {
  if (!sec) return null;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** YYYY-MM-DD in local time (for <input type="date">). */
export function ymd(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export const PLATFORM_NAMES = { tiktok: 'تيك توك', instagram: 'إنستغرام' };

export function kindWord(kind) {
  return { video: 'فيديو', reel: 'ريلز', photo: 'صور', image: 'صورة', carousel: 'ألبوم' }[kind] || 'منشور';
}

export const STRATEGY_NAMES = {
  api: 'واجهة تيك توك',
  profile: 'صفحة الحساب',
  embed: 'صفحة التضمين',
  'yt-dlp': 'yt-dlp',
  browser: 'متصفح خفي',
  web: 'الواجهة العامة',
  mobile: 'واجهة التطبيق',
  feed: 'حسابك المسجّل',
};

const pr = new Intl.PluralRules('ar');
/** "منشور جديد" with correct Arabic number agreement. */
export function newPostsText(n) {
  return {
    zero: 'لا منشورات جديدة',
    one: 'منشور جديد',
    two: 'منشوران جديدان',
    few: `${n} منشورات جديدة`,
    many: `${n} منشوراً جديداً`,
    other: `${n} منشور جديد`,
  }[pr.select(n)];
}

/** Accusative form, e.g. "نراقب حسابين". */
export function accountsText(n) {
  return {
    zero: 'لا حسابات',
    one: 'حساباً واحداً',
    two: 'حسابين',
    few: `${n} حسابات`,
    many: `${n} حساباً`,
    other: `${n} حساب`,
  }[pr.select(n)];
}
