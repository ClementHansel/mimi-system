import { ApiError } from '@/lib/api';
import { translate } from '@/lib/i18n';

/**
 * ONE function turns a failed request into words a user reads.
 *
 * The bug it closes (owner, 2026-08-31): a dozen screens did
 * `err instanceof Error && err.message ? err.message : t('auth.genericError')`,
 * and `ApiErrorShape.message` is a DEVELOPER fallback per CONTRACTS §0 — so
 * the Supplier form's duplicate-code toast read
 * `duplicate key value violates unique constraint "suppliers_code_key"`.
 * The backend's exception filter no longer emits that text at all
 * (`common/filters/pg-error.util.ts`), but the frontend half matters just as
 * much: `message` must never reach a toast, whatever it happens to say today.
 *
 * Resolution order, each step narrower than the next:
 *
 *   1. `details.field` + a code that CAN name a field (`ERR_DUPLICATE`,
 *      `ERR_VALIDATION`) → the specific sentence, e.g.
 *      «Kode "SUP001" sudah dipakai. Gunakan yang lain.»
 *   2. the `code` alone → `errors.byCode.<CODE>`.
 *   3. the HTTP status class → `errors.badRequest` / `.forbidden` / … .
 *   4. `fallback`, if the caller passed a screen-specific line, else
 *      `errors.generic`.
 *
 * A non-`ApiError` (a thrown `TypeError` from `fetch`, i.e. the request never
 * left the device) is a connection problem, not a server refusal, and gets
 * `errors.network` — the one case where a wrong sentence sends someone
 * hunting for the wrong problem.
 *
 * `translate` rather than `useI18n().t` on purpose: this is called from
 * `catch` blocks, some of them outside React's render, and there is exactly
 * one dictionary (BUILD-PLAN §6.9) so a hook buys nothing here.
 */

/** Codes whose sentence has a field-naming variant in `errors.byCode`. */
const FIELD_AWARE: Record<string, { withValue: string; withoutValue: string }> = {
  ERR_DUPLICATE: {
    withValue: 'errors.byCode.ERR_DUPLICATE_FIELD',
    withoutValue: 'errors.byCode.ERR_DUPLICATE_FIELD_NO_VALUE',
  },
  ERR_VALIDATION: {
    withValue: 'errors.byCode.ERR_VALIDATION_FIELD',
    withoutValue: 'errors.byCode.ERR_VALIDATION_FIELD',
  },
};

const STATUS_KEY: Record<number, string> = {
  400: 'errors.badRequest',
  401: 'errors.unauthorized',
  403: 'errors.forbidden',
  404: 'errors.notFound',
  409: 'errors.conflict',
  422: 'errors.badRequest',
};

/**
 * `translate` returns the KEY itself when a key is missing (see its own doc
 * comment), which would put `errors.byCode.ERR_WHATEVER` in a toast — the
 * same class of leak this file exists to stop. So every lookup goes through
 * here and a miss is reported as a miss.
 */
function lookup(key: string, params?: Record<string, string>): string | null {
  const text = translate(key, params);
  if (text === key) return null;
  // A leftover `{{token}}` means the sentence wanted a detail this response
  // did not carry. Showing `{{pendingCount}}` to a user is the same class of
  // leak as showing a constraint name, so this counts as a miss and the
  // caller falls through to a variant that needs no detail.
  if (/\{\{\w+\}\}/.test(text)) return null;
  return text;
}

/**
 * `details` scalars, as interpolation params — so a sentence can quote the
 * server's own numbers (`{{pendingCount}}` in the drain-before-off refusal)
 * without any screen having to read `details` itself.
 */
function detailParams(details: unknown): Record<string, string> {
  if (typeof details !== 'object' || details === null) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
  }
  return params;
}

function fieldLabel(details: unknown): { label: string; value?: string } | null {
  if (typeof details !== 'object' || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.field !== 'string') return null;
  // Unknown column → no field name. Printing `bank_account_name` at a user is
  // the technical-vocabulary problem in a different costume.
  const label = lookup(`errors.byField.${d.field}`);
  if (!label) return null;
  return { label, value: typeof d.value === 'string' ? d.value : undefined };
}

/**
 * The user-facing sentence for a caught request failure.
 *
 * @param fallback Optional screen-specific line ("Gagal menyimpan supplier"),
 *   used only when nothing more specific is known. Pass a translated string,
 *   not a key.
 */
export function apiErrorText(err: unknown, fallback?: string): string {
  if (!(err instanceof ApiError)) {
    return translate('errors.network');
  }

  const field = fieldLabel(err.details);
  const fieldAware = FIELD_AWARE[err.code];
  if (field && fieldAware) {
    const key = field.value ? fieldAware.withValue : fieldAware.withoutValue;
    const text = lookup(key, { field: field.label, value: field.value ?? '' });
    if (text) return text;
  }

  // The code's own sentence, with the server's `details` available to it. A
  // code may publish two lines — `ERR_X` quoting a detail and
  // `ERR_X_NO_DETAILS` for the response that omitted it — because a refusal
  // that can say "3 events still queued" should, and the same refusal
  // without a count still has to say something.
  const params = detailParams(err.details);
  const byCode =
    lookup(`errors.byCode.${err.code}`, params) ?? lookup(`errors.byCode.${err.code}_NO_DETAILS`);
  if (byCode) return byCode;

  const byStatus = err.statusCode >= 500 ? 'errors.server' : STATUS_KEY[err.statusCode];
  if (byStatus) {
    const text = lookup(byStatus);
    if (text) return text;
  }

  return fallback ?? translate('errors.generic');
}

/**
 * The `description` line under a toast whose TITLE already says what failed
 * ("Penjualan gagal", "Unggah gagal"). Returns `undefined` when nothing more
 * specific than the title is known, because "Terjadi kesalahan" stacked under
 * "Penjualan gagal" is two lines saying one thing.
 *
 * These call sites are why the resolver is split in two: they previously put
 * `err.message` here, so the same raw driver/exception text landed in the
 * second line instead of the first.
 */
export function apiErrorDetail(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return translate('errors.network');
  const specific = apiErrorText(err, '');
  if (!specific || specific === translate('errors.generic')) return undefined;
  return specific;
}

/**
 * The name 28 panels already used for their own private copy of this logic,
 * with the same `(err, fallback)` signature — so adopting the shared resolver
 * is an import, not a rewrite of every `catch` block. Prefer `apiErrorText`
 * in new code; this exists so the sweep that removed those 28 copies stayed
 * mechanical and reviewable.
 */
export function errMsg(err: unknown, fallback: string): string {
  return apiErrorText(err, fallback);
}
