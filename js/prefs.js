// Per-device preferences (theme, sound, notifications). Safe when storage is blocked.
const KEY = 'radar.prefs';
const defaults = { theme: 'auto', sound: true, notify: false };

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const prefs = load();

export function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: keep in memory */
  }
  if (key === 'theme') applyTheme();
}

export function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0a12' : '#f7f7fb');
}
