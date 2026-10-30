import { ICONS } from './icons.js';

/**
 * Create an element. Strings become text nodes (never parsed as HTML).
 * Props: class, style (object), on* listeners, dataset (object), any attribute.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Replace an element's children, skipping null/false (unlike el.replaceChildren). */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Icon element from the trusted icon set. */
export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `ico ${cls}`.trim();
  span.innerHTML = ICONS[name] || '';
  return span;
}

/**
 * Keyed list reconciliation: reuses existing children with the same key,
 * creates missing ones, removes stale ones and keeps order.
 */
export function syncList(container, items, { key, create, update }) {
  const existing = new Map();
  for (const el of [...container.children]) if (el.dataset.key) existing.set(el.dataset.key, el);
  const wanted = new Set();
  let prev = null;
  for (const item of items) {
    const k = key(item);
    wanted.add(k);
    let el = existing.get(k);
    if (el) update?.(el, item);
    else {
      el = create(item);
      el.dataset.key = k;
    }
    const expected = prev ? prev.nextSibling : container.firstChild;
    if (el !== expected) container.insertBefore(el, expected);
    prev = el;
  }
  for (const [k, el] of existing) if (!wanted.has(k)) el.remove();
}

let toastBox = null;
export function toast(message, kind = 'info', ms = 2800) {
  toastBox ||= document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  const t = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'), h('span', null, message));
  toastBox.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Promise-based confirm dialog styled like the app. */
export function confirmDialog({ title, body, ok = 'تأكيد', cancel = 'إلغاء', danger = false }) {
  return new Promise((resolve) => {
    const close = (v) => {
      wrap.classList.add('out');
      setTimeout(() => wrap.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && close(false);
    const wrap = h('div', { class: 'dialog-wrap', onclick: (e) => e.target === wrap && close(false) },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('h3', null, title),
        body ? h('p', null, body) : null,
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, ok),
        ),
      ),
    );
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.btn:last-child').focus();
  });
}

/** Split text into nodes, highlighting #hashtags, @mentions and links. */
export function richText(text) {
  const out = [];
  const re = /(#[\p{L}\p{N}_]+|@[A-Za-z0-9_.]+|https?:\/\/\S+)/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('span', { class: m[0].startsWith('#') ? 'tag' : m[0].startsWith('@') ? 'mention' : 'link' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
