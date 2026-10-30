/** Error kinds, ordered from most to least definitive. */
const KINDS = ['not_found', 'private', 'login', 'rate_limited', 'blocked', 'parse', 'network', 'unavailable'];

export const MESSAGES = {
  not_found: 'الحساب غير موجود — تأكد من اسم المستخدم',
  private: 'الحساب خاص — لا يمكن رؤية منشوراته',
  login: 'المنصة تطلب تسجيل الدخول لعرض هذا الحساب',
  rate_limited: 'طلبات كثيرة على المنصة — سنعيد المحاولة تلقائياً',
  blocked: 'المنصة رفضت الطلب مؤقتاً — سنعيد المحاولة تلقائياً',
  parse: 'تغيّر شكل بيانات المنصة',
  network: 'تعذّر الاتصال بالمنصة — تحقق من الإنترنت',
  unavailable: 'لا توجد طريقة جلب متاحة',
};

export class FetchError extends Error {
  /**
   * @param {string} kind one of KINDS
   * @param {string} detail technical detail (English, for logs)
   * @param {string} [strategy] which fetch strategy failed
   */
  constructor(kind, detail, strategy) {
    super(`${strategy ? `[${strategy}] ` : ''}${kind}: ${detail}`);
    this.kind = KINDS.includes(kind) ? kind : 'parse';
    this.detail = detail;
    this.strategy = strategy || null;
  }
}

/** Wrap any thrown value as a FetchError tagged with a strategy. */
export function asFetchError(err, strategy) {
  if (err instanceof FetchError) {
    if (!err.strategy) err.strategy = strategy;
    return err;
  }
  const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err));
  return new FetchError('network', msg, strategy);
}

/** Combine failures from several strategies into the most useful single error. */
export function combineErrors(errors) {
  if (!errors.length) return new FetchError('unavailable', 'no strategy ran');
  const sorted = [...errors].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const best = sorted[0];
  const combined = new FetchError(best.kind, errors.map((e) => e.message).join(' | '));
  combined.attempts = errors.map((e) => ({ strategy: e.strategy, kind: e.kind, detail: e.detail }));
  return combined;
}

/** Map an HTTP status to an error kind. */
export function kindForStatus(status) {
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'login';
  if (status >= 400 && status < 500) return 'blocked';
  return 'network';
}
