/**
 * The ONE place Indonesian notification copy lives in the backend
 * (BUILD-PLAN §5 W2-C constraint: "All user-facing notification copy goes
 * through i18n keys in Bahasa Indonesia — never hardcode Indonesian strings
 * in the backend; expose keys and parameters").
 *
 * Every OTHER file in kernel/notification (the service, the channels, the
 * template registry) works exclusively with template KEYS and PARAMS —
 * never with literal Indonesian text. This module is the single explicit
 * resource dictionary that resolves a key + params into real text, exactly
 * the same shape `apps/frontend/src/lib/i18n` uses for UI strings (W1-E),
 * except this one exists because two of the three notification channels
 * (email, WhatsApp) have no frontend to render through — the backend must
 * produce the final message body itself for those, so it needs its own
 * (single-locale, since D-11/D-05 this app has exactly one) resource file
 * rather than "business logic string-building".
 *
 * `{{param}}` placeholders are replaced verbatim; a missing param leaves the
 * placeholder in place rather than throwing (a missing template param is a
 * caller bug, not a reason to fail sending an otherwise-legitimate alert).
 */
export interface NotificationText {
  title: string;
  body: string;
}

export const ID_ID_NOTIFICATION_TEXT: Record<string, NotificationText> = {
  payroll_slip: {
    title: 'Slip gaji {{period}} sudah tersedia',
    body: 'Slip gaji Anda untuk periode {{period}} sudah tersedia. Gaji bersih: Rp {{netPay}}. Silakan cek di aplikasi.',
  },
  low_stock: {
    title: 'Stok menipis: {{itemName}}',
    body: '{{itemName}} di {{locationName}} tersisa {{currentQty}} {{unit}} (minimum {{minQty}} {{unit}}). Segera ajukan permintaan barang.',
  },
  approval_pending: {
    title: 'Menunggu persetujuan Anda',
    body: '{{documentType}} {{documentNumber}} dari {{locationName}} menunggu persetujuan Anda. Buka: {{deepLink}}',
  },
  /** `{{outcome}}` arrives pre-mapped to its Indonesian verb by `renderNotificationText` below (`APPROVAL_OUTCOME_LABELS`) — the caller only ever supplies the raw `'approved'|'rejected'|'cancelled'` data value. */
  approval_decided: {
    title: 'Keputusan persetujuan: {{documentType}} {{documentNumber}}',
    body: '{{documentType}} {{documentNumber}} telah {{outcome}}. Alasan: {{reason}}. Buka: {{deepLink}}',
  },
  maintenance_due: {
    title: 'Jadwal servis: {{assetName}}',
    body: '{{assetName}} di {{locationName}} dijadwalkan servis pada {{dueDate}}.',
  },
  cold_chain_breach: {
    title: 'Peringatan suhu rantai dingin — {{goodsClass}}',
    body: 'Suhu {{recordedTemp}}°C terdeteksi di luar batas untuk {{goodsClass}} ({{minTemp}}°C – {{maxTemp}}°C) pada {{context}} ({{locationName}}).',
  },
  outlet_offline: {
    title: 'Outlet offline: {{locationName}}',
    body: '{{locationName}} terputus dari server sejak {{lastSeenAt}}. Mohon segera diperiksa.',
  },
};

/**
 * `approval_decided`'s ONLY caller (`ApprovalService`) passes `outcome` as
 * the same bare `DecisionOutcome` string its own bookkeeping already uses
 * (`'approved'|'rejected'|'cancelled'`, `kernel/approvals/types.ts`) — never
 * an Indonesian word, per this module's "never hardcode Indonesian in the
 * backend" rule (that rule is exactly why `ApprovalService` doesn't compute
 * "disetujui"/"ditolak"/"dibatalkan" itself). This is the one place that
 * mapping happens, so every Indonesian word for it still lives in this one
 * file. No other registered template uses a param literally named `outcome`
 * (checked against `template-registry.ts`), so this substitution can safely
 * run unconditionally for every template key, not just `approval_decided`.
 */
const APPROVAL_OUTCOME_LABELS: Record<string, string> = {
  approved: 'disetujui',
  rejected: 'ditolak',
  cancelled: 'dibatalkan',
};

export function renderNotificationText(templateKey: string, params: Record<string, string>): NotificationText {
  const entry = ID_ID_NOTIFICATION_TEXT[templateKey];
  if (!entry) {
    return { title: templateKey, body: '' };
  }
  const resolvedParams =
    params.outcome && APPROVAL_OUTCOME_LABELS[params.outcome]
      ? { ...params, outcome: APPROVAL_OUTCOME_LABELS[params.outcome]! }
      : params;
  return {
    title: interpolate(entry.title, resolvedParams),
    body: interpolate(entry.body, resolvedParams),
  };
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? params[key]! : match,
  );
}
