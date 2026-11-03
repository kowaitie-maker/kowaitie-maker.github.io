import { confirmDialog, h, icon, toast } from '../dom.js';
import { ago, longDate } from '../format.js';
import { ghToken, links, verifyToken } from '../api.js';
import { prefs, setPref } from '../prefs.js';
import { notificationsSupported, requestNotifications } from '../alerts.js';

function group(title, ...rows) {
  return h('div', { class: 'group-wrap', id: /زر التحديث|التحديث الفوري/.test(title || '') ? 'instant' : null },
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

/** The refresh button can start a real check when a GitHub key is saved on this device. */
function instantGroup(app, manual) {
  const has = !!ghToken.get();
  if (has) {
    return group('زر التحديث',
      row('مفعّل على هذا الجهاز', 'زر التحديث ⟳ يفحص الحسابات فوراً، وتظهر النتائج خلال دقيقتين تقريباً.', h('span', { class: 'ok-pill' }, icon('check'), 'مفعّل')),
      h('div', { class: 'row row-actions' },
        h('button', { class: 'btn small', onclick: () => app.checkNow() }, icon('refresh'), 'افحص الآن'),
        h('button', { class: 'btn small danger-ghost', onclick: () => {
          ghToken.clear();
          toast('أُزيل المفتاح من هذا الجهاز', 'ok');
          app.rebuildSettings();
        } }, 'إزالة المفتاح')));
  }
  const input = h('input', { id: 'gh-token', class: 'input', type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: 'github_pat_…' });
  const save = h('button', { class: 'btn small primary', onclick: async () => {
    const v = input.value.trim();
    if (!v) return toast('الصق المفتاح أولاً', 'error');
    save.disabled = true;
    try {
      await verifyToken(v);
      ghToken.set(v);
      toast('تم التفعيل — زر التحديث يفحص الآن فوراً', 'ok', 3500);
      app.rebuildSettings();
    } catch (err) {
      toast(err.message, 'error', 6000);
      save.disabled = false;
    }
  } }, 'حفظ');
  const createUrl = 'https://github.com/settings/personal-access-tokens/new?name=Radar%20refresh&description=Start%20the%20Radar%20update%20from%20the%20page&target_name=kowaitie-maker&expires_in=365&actions=write';
  return group(manual ? 'تفعيل زر التحديث (مطلوب مرة واحدة)' : 'التحديث الفوري من الزر (اختياري)',
    h('div', { class: 'row row-col' },
      h('div', { class: 'row-label' }, 'اجعل زر ⟳ يفحص الحسابات'),
      h('div', { class: 'row-hint' }, manual
        ? 'الفحص يتم بهذا الزر فقط، وهو يحتاج مفتاحاً من GitHub مرة واحدة. يُحفظ على هذا الجهاز فقط ولا يظهر في الموقع.'
        : 'بدونه يعرض الزر آخر تحديث تلقائي فقط. يلزم مفتاح من GitHub مرة واحدة، يُحفظ على هذا الجهاز فقط.'),
      h('ol', { class: 'steps' },
        h('li', null, 'اضغط «إنشاء مفتاح» بالأسفل (سجّل دخولك في GitHub إن طُلب).'),
        h('li', null, 'Repository access: اختر ', code('Only select repositories'), ' ثم ', code('kowaitie-maker.github.io'), '.'),
        h('li', null, 'Permissions ← Repository permissions ← ', code('Actions'), ': ', code('Read and write'), '.'),
        h('li', null, 'اضغط ', code('Generate token'), ' وانسخ المفتاح والصقه هنا.')),
      h('a', { class: 'link-btn', href: createUrl, target: '_blank', rel: 'noopener noreferrer' }, 'إنشاء مفتاح في GitHub', icon('external')),
      h('div', { class: 'inline-form' }, input, save)));
}

function storiesRow(state) {
  const ig = state.accounts.filter((a) => a.platform === 'instagram');
  const failed = ig.find((a) => /ufac|checkpoint/i.test(a.storyError || '')) || ig.find((a) => a.storyError);
  if (failed) {
    const e = failed.storyError;
    const text = /ufac/i.test(e)
      ? 'إنستغرام أوقف تسجيل الدخول هذا للتحقق الأمني لأنه رصد نشاطاً آلياً. افتح تطبيق إنستغرام على نفس الحساب وأكمل خطوات التحقق، ثم ضع sessionid جديداً مكان IG_SESSIONID — أو احذف IG_SESSIONID (الدائرة ستبقى تفتح الستوري في التطبيق). نعيد المحاولة كل 12 ساعة فقط.'
      : /checkpoint/i.test(e)
      ? 'إنستغرام يطلب تأكيد تسجيل الدخول. افتح تطبيق إنستغرام بحسابك (أو instagram.com) وأكّد «هذا أنا» إن ظهر لك تنبيه، وستعمل في التحديث التالي.'
      : /login_required|expired/i.test(e)
        ? 'انتهت صلاحية مفتاح الدخول (ربما سجّلت الخروج). سجّل الدخول من جديد وانسخ sessionid جديداً وضعه مكان IG_SESSIONID.'
        : /login not accepted|login/i.test(e)
          ? 'إنستغرام لم يقبل مفتاح الدخول من خوادم GitHub. جرّب نسخ sessionid جديد، أو استخدم الدائرة لفتح الستوري في تطبيق إنستغرام.'
          : h('span', null, 'تعذّر جلب الستوري في آخر تحديث: ', h('bdi', { dir: 'ltr' }, e.slice(0, 120)));
    return row('الستوري', text, h('span', { class: 'err-pill' }, 'يحتاج تصحيح'));
  }
  const n = ig.reduce((sum, a) => sum + (a.stories?.length || 0), 0);
  const who = ig.filter((a) => a.stories?.length).length;
  return row('الستوري', n ? `${n} ستوري محفوظ الآن من ${who === 1 ? 'حساب واحد' : who === 2 ? 'حسابين' : `${who} حسابات`}، تُشاهَد داخل الصفحة.` : 'يعمل. لا يوجد ستوري حالياً لدى حساباتك.', pill(true, 'يعمل', ''));
}

function telegramRow(c) {
  const st = c.telegramStatus || {};
  if (!c.telegram) {
    return row('الحالة', 'ليصلك كل منشور جديد كإشعار على جوالك. بعد إضافة السرّين تتغيّر الحالة مع الفحص التالي.', pill(false, '', 'غير مفعّل'));
  }
  if (st.lastError) {
    return row('الحالة', h('span', null, `آخر فحص ${ago(st.lastErrorAt)}: `, h('bdi', { dir: 'auto' }, st.lastError), '. بعد التصحيح تتغيّر الحالة مع التحديث التالي.'), h('span', { class: 'err-pill' }, 'يحتاج تصحيح'));
  }
  const hint = st.lastSentAt
    ? `آخر رسالة أُرسلت ${ago(st.lastSentAt)}. يصلك كل منشور جديد يجده الفحص مع رابط مشاهدته.`
    : st.verifiedAt
      ? 'البوت متصل بمحادثتك. ستصلك رسالة مع كل منشور جديد يجده الفحص.'
      : 'سيرسل لك البوت كل منشور جديد يجده الفحص مع رابط مشاهدته.';
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
        s.manual
          ? row('التحديث', 'بالزر فقط: اضغط ⟳ أعلى الصفحة ليفحص الحسابات الآن. لا يوجد تحديث تلقائي.', null)
          : row('التحديث التلقائي', 'تقريباً كل ساعة على خوادم GitHub، حتى والصفحة مغلقة (GitHub يؤخّر المواعيد أحياناً).', null)),

      instantGroup(app, s.manual),

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
        row('مفتاح الدخول', c.instagramLogin ? 'مضاف — يُستخدم لعرض الستوري داخل الصفحة ولجلب إنستغرام بثبات أكبر.' : 'يلزم لعرض الستوري داخل الصفحة. إنستغرام لا يعرض الستوري إلا لمن سجّل دخوله.', pill(c.instagramLogin, 'مضاف', 'غير مضاف')),
        c.instagramLogin ? storiesRow(state) : null,
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
