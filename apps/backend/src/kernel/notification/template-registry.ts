export type NotificationChannel = 'in_app' | 'email' | 'whatsapp';

export interface NotificationTemplate {
  /** Matches `notifications.type` (migration 006's documented values) and the i18n key in `i18n/id-ID.ts`. */
  key: string;
  /** Which channels this template is delivered over by default. */
  channels: NotificationChannel[];
  /** Param names the template interpolates — documentation + a cheap completeness check in tests. */
  requiredParams: string[];
}

/**
 * The six templates BUILD-PLAN §5 W2-C names explicitly, plus `payment_pending`/
 * `sync_exception` (the other two the `notifications` table migration
 * comment documents) are left for the modules that will actually need them
 * (accounting M17, sync kernel W2-D) to register alongside their own domain
 * logic, to avoid inventing copy for events that don't exist yet.
 *
 * `approval_decided` was the third of that trio — it is registered here
 * (not left to a domain module) because closing B-07 means `kernel/approvals`
 * itself is the one firing it (see `ApprovalService`'s file header: "Notify
 * from ApprovalService, not from the eight domain modules" — wiring eight
 * callers would mean eight chances to diverge).
 */
export const NOTIFICATION_TEMPLATES = {
  payroll_slip: {
    key: 'payroll_slip',
    channels: ['in_app', 'email', 'whatsapp'],
    requiredParams: ['period', 'netPay'],
  },
  low_stock: {
    key: 'low_stock',
    channels: ['in_app', 'email'],
    requiredParams: ['itemName', 'locationName', 'currentQty', 'minQty', 'unit'],
  },
  /**
   * B-07 fix: was `channels: ['in_app']` only — `NotificationService.notify()`
   * INTERSECTS a caller's `channels` override with the template's own list, so
   * `ApprovalService.resolveNotificationChannels()`'s mode-driven `email`/
   * `whatsapp` choice was being silently filtered down to `in_app` regardless
   * of what `manual`/`whatsapp` mode asked for. Widened to permit all three;
   * the actual per-call set is still restricted by `ApprovalService`'s
   * `channels` override (D-23), this is just the template's own ceiling.
   */
  approval_pending: {
    key: 'approval_pending',
    channels: ['in_app', 'email', 'whatsapp'],
    requiredParams: ['documentType', 'documentNumber', 'locationName', 'deepLink'],
  },
  /**
   * B-07 — the decision/outcome notification to the REQUESTER (submit/step-
   * advance notify the APPROVER via `approval_pending` above; this one tells
   * the person who asked what happened to their request). `outcome` is a
   * data value (`'approved'|'rejected'|'cancelled'`, the same strings
   * `DecisionOutcome` in `kernel/approvals/types.ts` already uses) — never an
   * Indonesian word assembled in `ApprovalService`; `id-ID.ts`'s
   * `renderNotificationText` maps it to the correctly conjugated Indonesian
   * verb, keeping every Indonesian word in that one file per this module's
   * own i18n rule. `reason` is always populated (a literal `'-'` when none
   * was given, e.g. a plain approve) rather than omitted, so the template
   * text never has to conditionally include/exclude a sentence.
   */
  approval_decided: {
    key: 'approval_decided',
    channels: ['in_app', 'email', 'whatsapp'],
    requiredParams: ['documentType', 'documentNumber', 'outcome', 'reason', 'deepLink'],
  },
  maintenance_due: {
    key: 'maintenance_due',
    channels: ['in_app', 'email'],
    requiredParams: ['assetName', 'locationName', 'dueDate'],
  },
  cold_chain_breach: {
    key: 'cold_chain_breach',
    channels: ['in_app', 'email', 'whatsapp'],
    // `goodsClass` (added when a cold truck's cargo was split into per-class ranges, D-14 update): which
    // goods class this specific breach is about ("barang beku" / "barang chiller") — a cold truck carries
    // BOTH, so naming the class is what makes the alert actionable rather than "temperature out of range".
    requiredParams: ['recordedTemp', 'minTemp', 'maxTemp', 'goodsClass', 'context', 'locationName'],
  },
  /**
   * B-15 — the one-time approval code, delivered to the APPROVER who just
   * authorised a document. All three channels: the whole point is that the
   * approver can be away from the outlet (Q2 — a swapped shift, someone off
   * sick) and still read the code off their own phone. WhatsApp is listed
   * even though `WA_ENABLED=false` today, so it starts working the moment
   * credentials exist without another code change (RISK-P4).
   *
   * This is the ONLY template whose params carry a live secret. It is
   * deliberately short-lived (5 minutes, single-use), which is what makes
   * putting it through an ordinary notification channel acceptable at all.
   */
  approval_code_issued: {
    key: 'approval_code_issued',
    channels: ['in_app', 'email', 'whatsapp'],
    // `documentId` is deliberately NOT here. It is passed for the audit trail
    // but has no place in the copy: a supervisor reading a WhatsApp message
    // needs the code and what it is for, not a UUID.
    requiredParams: ['documentType', 'code', 'minutes'],
  },
  /**
   * B-15 Q9 — someone burned their approval-code attempts. Goes to the people
   * who can actually clear it plus the locked user, so a stalled till is
   * visible rather than mysterious. No WhatsApp: this is an operational alert,
   * not something worth a message to a personal phone at 23:00.
   */
  auth_lockout: {
    key: 'auth_lockout',
    channels: ['in_app', 'email'],
    requiredParams: ['userName', 'attempts'],
  },
  outlet_offline: {
    key: 'outlet_offline',
    channels: ['in_app', 'email'],
    requiredParams: ['locationName', 'lastSeenAt'],
  },
} as const satisfies Record<string, NotificationTemplate>;

export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

export function getTemplate(key: NotificationTemplateKey): NotificationTemplate {
  return NOTIFICATION_TEMPLATES[key];
}
