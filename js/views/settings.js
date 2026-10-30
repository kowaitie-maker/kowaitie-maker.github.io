import { confirmDialog, h, icon, toast } from '../dom.js';
import { ago, longDate } from '../format.js';
import { links } from '../api.js';
import { prefs, setPref } from '../prefs.js';
import { notificationsSupported, requestNotifications } from '../alerts.js';

function group(title, ...rows) {
  return h('div', { class: 'group-wrap' },
    title ? h('h2', { class: 'group-title' }, title) : null,
    h('div', { class: 'group' }, ...rows));
}

function row(label, hint, control, cls = '') {
  return h('div', { class: `row ${cls}`.trim() },
    h('div', { class: 'row-text' }, h('div', { class: 'row-label' }, label), hint ? h('div', { class: 'row-hint' }, hint) : null),
    control || null);
}

function toggle(id, checked, onChange, label) {
  const input = h('input', { id, type: 'checkbox', role: 'switch', 'aria-label': label, checked });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-ui' }));
}

function ghLink(href, label) {
  return href ? h('a', { class: 'link-btn', href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external')) : null;
}

const code = (t) => h('code', null, t);

function telegramRow(c) {
  const st = c.telegramStatus || {};
  if (!c.telegram) {
    return row('الحالة', 'ليصلك كل منشور جديد كإشعار على جوالك حتى والصفحة مغلقة. بعد إضافة السرّين تتغيّر الحالة مع التحديث التالي (خلال 30 دقيقة).', pill(false, '', 'غير مفعّل'));
  }
  if (st.lastError) {
    return row('الحالة', h('span', null, `آخر محاولة إرسال فشلت ${ago(st.lastErrorAt)}: `, h('bdi', { dir: 'auto' }, st.lastError), '. تأكد من الرمز ورقمك، وأنك ضغطت Start في بوتك.'), h('span', { class: 'err-pill' }, 'خطأ'));
  }
  const hint = st.lastSentAt
    ? `آخر رسالة أُرسلت ${ago(st.lastSentAt)}. يصلك كل منشور جديد مع رابط مشاهدته، حتى والصفحة مغلقة.`
    : 'سيرسل لك البوت كل منشور جديد مع رابط مشاهدته، حتى والصفحة مغلقة.';
  return row('الحالة', hint, pill(true, 'مفعّل', ''));
}
const pill = (ok, onText, offText) => h('span', { class: ok ? 'ok-pill' : 'off-pill' }, ok ? icon('check') : null, ok ? onText : offText);

export function createSettingsView(app) {
  const el = h('section', { class: 'view view-settings' }, h('h1', { class: 'page-title' }, 'الإعدادات'));
  const body = h('div');
  el.appendChild(body);
  let built = false;

  function build(state) {
    const s = state.settings;
    const c = state.capabilities || {};

    const notifSupported = notificationsSupported();
    const notifToggle = toggle('pref-notify', prefs.notify && notifSupported && Notification.permission === 'granted', async (on, input) => {
      if (!on) return setPref('notify', false);
      const perm = await requestNotifications();
      if (perm === 'granted') {
        setPref('notify', true);
        toast('تم تفعيل الإشعارات', 'ok');
      } else {
        input.checked = false;
        setPref('notify', false);
        toast(perm === 'unsupported' ? 'الإشعارات غير متاحة في هذا المتصفح' : 'لم يُسمح بالإشعارات من المتصفح', 'error');
      }
    }, 'إشعارات المتصفح');
    if (!notifSupported) notifToggle.querySelector('input').disabled = true;

    const themes = [['auto', 'تلقائي'], ['dark', 'داكن'], ['light', 'فاتح']];
    const seg = h('div', { class: 'segmented', role: 'radiogroup' });
    const paintSeg = () => seg.replaceChildren(...themes.map(([k, label]) =>
      h('button', { class: prefs.theme === k ? 'active' : '', role: 'radio', 'aria-checked': prefs.theme === k ? 'true' : 'false', onclick: () => { setPref('theme', k); paintSeg(); } }, label)));
    paintSeg();

    body.replaceChildren(
      group('المتابعة',
        row('بداية المتابعة', h('span', null, `تظهر المنشورات التي نُشرت من ${longDate(s.since)} فصاعداً. لتغييره عدّل قيمة `, code('since'), ' في ملف القائمة.'), ghLink(links.editAccounts(), 'تعديل')),
        row('التحديث التلقائي', `كل ${s.intervalMin} دقيقة على خوادم GitHub، حتى والصفحة مغلقة. لتحديث فوري: افتح صفحة المهمة واضغط «Run workflow».`, ghLink(links.runNow(), 'تحديث الآن'))),

      group('التنبيهات على هذا الجهاز',
        row('صوت عند وصول جديد', 'يعمل والصفحة مفتوحة.', toggle('pref-sound', prefs.sound, (on) => setPref('sound', on), 'صوت')),
        row('إشعارات المتصفح', notifSupported
          ? 'تنبيه عند وصول منشور جديد والصفحة مفتوحة في الخلفية. على آيفون: أضف الصفحة للشاشة الرئيسية أولاً.'
          : 'غير متاحة في هذا المتصفح. للإشعارات على الجوال استخدم تيليجرام بالأسفل.', notifToggle)),

      group('إشعارات تيليجرام (اختياري)',
        telegramRow(c),
        c.telegram ? null : h('div', { class: 'row row-col' },
          h('ol', { class: 'steps' },
            h('li', null, 'في تيليجرام افتح ', code('@BotFather'), ' وأرسل ', code('/newbot'), ' ثم اتبع الخطوات وانسخ الرمز (token).'),
            h('li', null, 'افتح بوتك الجديد واضغط Start.'),
            h('li', null, 'افتح ', code('@userinfobot'), ' وانسخ رقم Id الخاص بك.'),
            h('li', null, 'في GitHub أضف سرّين: ', code('TELEGRAM_TOKEN'), ' (الرمز) و', code('TELEGRAM_CHAT_ID'), ' (رقمك).')),
          ghLink(links.newSecret(), 'إضافة سرّ في GitHub'))),

      group('إنستغرام (اختياري)',
        row('مفتاح الدخول', c.instagramLogin ? 'مضاف — يُستخدم لجلب إنستغرام بثبات أكبر.' : 'إنستغرام يقيّد الزوار غير المسجّلين. إن ظهرت أخطاء متكررة لحساب إنستغرام أضف هذا المفتاح.', pill(c.instagramLogin, 'مضاف', 'غير مضاف')),
        c.instagramLogin ? null : h('div', { class: 'row row-col' },
          h('ol', { class: 'steps' },
            h('li', null, 'سجّل دخولك إلى instagram.com من متصفح الكمبيوتر (يُفضّل حساب ثانوي).'),
            h('li', null, 'أدوات المطوّر (F12) ← Application ← Cookies ← انسخ قيمة ', code('sessionid'), '.'),
            h('li', null, 'في GitHub أضف سرّاً باسم ', code('IG_SESSIONID'), ' والصق القيمة. يبقى مخفياً ولا يظهر في الصفحة.')),
          ghLink(links.newSecret(), 'إضافة سرّ في GitHub'))),

      group('المظهر', row('السمة', null, seg)),

      group(null,
        h('button', { class: 'row row-button', onclick: async () => {
          const ok = await confirmDialog({ title: 'تعليم كل المنشورات كمُشاهَدة؟', body: 'يُحفظ على هذا الجهاز فقط.', ok: 'تعليم الكل' });
          if (ok) app.markSeen({ all: true });
        } }, icon('checks'), 'تعليم كل المنشورات كمُشاهَدة')),

      h('p', { class: 'footnote' },
        'الصفحة عامة: من لديه الرابط يرى نفس المنشورات (وهي منشورات عامة أصلاً). ما شاهدته محفوظ على هذا الجهاز فقط. ',
        links.repo() ? h('a', { class: 'link-btn', href: links.repo(), target: '_blank', rel: 'noopener noreferrer' }, 'مستودع الصفحة') : null),
    );
  }

  let shown = '';
  return {
    el,
    // The page has no text inputs, so it's safe to rebuild when the published status changes.
    update(state) {
      const key = JSON.stringify([state.capabilities, state.settings]);
      if (!built || key !== shown) {
        build(state);
        built = true;
        shown = key;
      }
    },
  };
}
