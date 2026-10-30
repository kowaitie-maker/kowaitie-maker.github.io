export const PLATFORMS = {
  tiktok: { name: 'تيك توك', profileUrl: (u) => `https://www.tiktok.com/@${u}` },
  instagram: { name: 'إنستغرام', profileUrl: (u) => `https://www.instagram.com/${u}/` },
};

const IG_RESERVED = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'legal',
  'developer', 'web', 'api', 'graphql', 'emails', 'challenge', 'privacy', 'terms', 'session',
]);

const TT_USER = /^[A-Za-z0-9_.]{2,24}$/;
const IG_USER = /^[A-Za-z0-9_.]{1,30}$/;

/**
 * Parse what the user typed into { platform, username } or { error }.
 * Accepts profile links (with or without tracking params), post links with
 * a username in them, "@name", or a bare name plus a platform hint.
 */
export function parseAccountInput(input, platformHint) {
  let text = String(input || '').trim();
  if (!text) return { error: 'اكتب رابط الحساب أو اسم المستخدم' };

  // Pull the first URL out of pasted share text such as "Check this out https://..."
  const urlMatch = text.match(/https?:\/\/\S+/i) || text.match(/(?:^|\s)((?:www\.|m\.|vm\.|vt\.)?(?:tiktok|instagram)\.com\/\S*)/i);
  if (urlMatch) {
    let raw = urlMatch[1] && !urlMatch[0].startsWith('http') ? urlMatch[1] : urlMatch[0];
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { error: 'الرابط غير صالح' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));

    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || (host === 'tiktok.com' && parts[0] === 't')) {
      return { error: 'هذا رابط مختصر — افتح الحساب في تيك توك وانسخ رابط الملف الشخصي (يبدأ بـ tiktok.com/@)' };
    }
    if (host.endsWith('tiktok.com')) {
      const at = parts.find((p) => p.startsWith('@'));
      const username = at ? at.slice(1) : null;
      if (!username || !TT_USER.test(username)) return { error: 'لم أجد اسم المستخدم في رابط تيك توك' };
      return { platform: 'tiktok', username: username.toLowerCase() };
    }
    if (host.endsWith('instagram.com') || host === 'instagr.am') {
      const first = parts[0];
      if (!first || IG_RESERVED.has(first.toLowerCase())) {
        return { error: 'هذا رابط منشور وليس حساب — انسخ رابط الملف الشخصي (instagram.com/اسم_المستخدم)' };
      }
      const username = first.replace(/^@/, '');
      if (!IG_USER.test(username)) return { error: 'لم أجد اسم المستخدم في رابط إنستغرام' };
      return { platform: 'instagram', username: username.toLowerCase() };
    }
    return { error: 'المنصات المدعومة حالياً: تيك توك وإنستغرام' };
  }

  // Not a URL: "@name", "tiktok:@name", "ig:name", or a bare name.
  let platform = platformHint || null;
  const prefixed = text.match(/^(tiktok|tt|instagram|insta|ig)\s*[:/]\s*(.+)$/i);
  if (prefixed) {
    platform = /^t/i.test(prefixed[1]) ? 'tiktok' : 'instagram';
    text = prefixed[2].trim();
  }
  const username = text.replace(/^@/, '').trim();
  if (!platform) return { error: 'اختر المنصة (تيك توك أو إنستغرام)', needsPlatform: true };
  if (!PLATFORMS[platform]) return { error: 'منصة غير مدعومة' };
  const valid = platform === 'tiktok' ? TT_USER : IG_USER;
  if (!valid.test(username)) return { error: 'اسم المستخدم غير صالح' };
  return { platform, username: username.toLowerCase() };
}

export function profileUrl(platform, username) {
  return PLATFORMS[platform]?.profileUrl(username) ?? null;
}
