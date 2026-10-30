import { h, icon, toast } from '../dom.js';
import { api } from '../api.js';

/**
 * Follow a new account. The list of accounts lives in the site's GitHub
 * repository, so the last step opens a ready-made request on GitHub; the
 * repository owner taps "Submit new issue" and the list updates by itself.
 */
export function openAddSheet() {
  let platform = null;
  const input = h('input', {
    id: 'follow-input',
    class: 'input input-big',
    type: 'text',
    dir: 'ltr',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'tiktok.com/@name  أو  @name',
    'aria-label': 'رابط الحساب أو اسم المستخدم',
  });
  const preview = h('div', { class: 'detect' });
  const pickers = h('div', { class: 'platform-pick', role: 'radiogroup', 'aria-label': 'المنصة' });
  const go = h('a', { class: 'btn primary block', target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': 'true' }, icon('external'), 'متابعة عبر GitHub');
  go.addEventListener('click', (e) => {
    if (go.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      toast(lastResult?.error || 'الصق رابط الحساب أولاً', 'error');
      return;
    }
    setTimeout(() => {
      close();
      toast('بعد الضغط على «Submit new issue» في GitHub ستُضاف المتابعة خلال دقائق', 'ok', 5000);
    }, 400);
  });
  let lastResult = null;

  const form = h('div', { class: 'sheet-form' },
    h('div', { class: 'input-wrap' }, input),
    preview,
    pickers,
    go,
    h('p', { class: 'sheet-note' }, 'قائمة المتابعة محفوظة في مستودع الصفحة على GitHub. سيفتح GitHub بطلب جاهز — اضغط «Submit new issue» (يجب أن تكون مسجّلاً بحسابك صاحب الصفحة) وتُضاف المتابعة تلقائياً.'));

  function paint() {
    const text = input.value.trim();
    const guess = /tiktok\.com/i.test(text) ? 'tiktok' : /instagram\.com|instagr\.am/i.test(text) ? 'instagram' : null;
    pickers.replaceChildren(...[['tiktok', 'تيك توك'], ['instagram', 'إنستغرام']].map(([k, label]) => {
      const active = (guess || platform) === k;
      return h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': active ? 'true' : 'false',
        class: `pick pick-${k}${active ? ' active' : ''}`,
        disabled: !!guess && guess !== k,
        onclick: () => {
          platform = k;
          paint();
        },
      }, icon(k), label);
    }));

    lastResult = text ? api.followRequest(text, guess || platform || undefined) : null;
    const ok = lastResult && !lastResult.error && lastResult.url;
    go.setAttribute('aria-disabled', ok ? 'false' : 'true');
    if (ok) go.setAttribute('href', lastResult.url);
    else go.removeAttribute('href');

    if (!text) {
      preview.className = 'detect muted';
      preview.replaceChildren(h('span', null, 'الصق رابط الملف الشخصي من التطبيق (مشاركة ← نسخ الرابط)'));
    } else if (ok) {
      preview.className = 'detect ok';
      preview.replaceChildren(icon('check'), h('span', null, 'سنتابع ', h('bdi', { dir: 'ltr' }, `@${lastResult.username}`), ` على ${lastResult.platform === 'tiktok' ? 'تيك توك' : 'إنستغرام'}`));
    } else if (lastResult?.needsPlatform) {
      preview.className = 'detect';
      preview.replaceChildren(icon('info'), h('span', null, 'اختر المنصة'));
    } else {
      preview.className = 'detect warn';
      preview.replaceChildren(icon('alert'), h('span', null, lastResult?.error || 'رابط غير صالح'));
    }
  }
  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  paint();

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'add-title' },
    h('div', { class: 'grabber' }),
    h('div', { class: 'sheet-head' },
      h('h2', { id: 'add-title' }, 'متابعة حساب جديد'),
      h('button', { class: 'icon-btn', 'aria-label': 'إغلاق', onclick: () => close() }, icon('x'))),
    form);
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => close() });
  const onKey = (e) => e.key === 'Escape' && close();

  function close() {
    document.removeEventListener('keydown', onKey);
    removeEventListener('hashchange', close);
    sheet.classList.add('out');
    backdrop.classList.add('out');
    setTimeout(() => {
      sheet.remove();
      backdrop.remove();
    }, 220);
  }

  document.addEventListener('keydown', onKey);
  addEventListener('hashchange', close);
  document.body.append(backdrop, sheet);
  setTimeout(() => input.focus(), 60);
}
