/**
 * Global constants — CONTRACTS.md §0 (conventions) and §4.20 (`settings` seed
 * defaults). Values here are the seed/default values a fresh install starts
 * with; the live values always live in the `settings` table and are read
 * through M20 at runtime — this file is the fallback/reference shape, and the
 * one place their TypeScript types are declared for validation.
 */
import { ApprovalDocumentType, ApprovalMode, RoleKey } from './enums';
import type { Money } from './types';

// ── D-11: timezone / locale / currency ───────────────────────────────────────

/** Fixed app-wide. Never `Asia/Jakarta` — do not copy the AIRE default (D-11). */
export const TIMEZONE = 'Asia/Makassar';

/** UTC offset of WITA. Fixed (no DST in Indonesia). */
export const TIMEZONE_UTC_OFFSET_HOURS = 8;

export const LOCALE = 'id-ID';

export const CURRENCY = 'IDR';

// ── D-05 / D-15 geofence & cold-chain defaults ────────────────────────────────

/** `locations.geofence_radius_m` default (FR-HR-01). */
export const DEFAULT_GEOFENCE_RADIUS_M = 100;

/**
 * @deprecated STALE — modeled `settings['coldchain.frozen']` as one static
 * range for the whole shipment, which was superseded by the owner's ruling
 * (2026-08-17, cold-chain backend agent finding): a `frozen`-shipment-type
 * truck is "the cold-chain vehicle" and carries BOTH frozen (-25..-15°C) AND
 * chilled (0..5°C) cargo at once, so cold-chain evaluation is now PER GOODS
 * CLASS, sourced from the origin warehouse's own `storage_areas` (D-15) —
 * not a single shipment-wide setting. `settings['coldchain.frozen']` itself
 * is a settings-module concern to retire, not this package's; this constant
 * has zero consumers in this repo (checked at the time of this note) and is
 * kept only so a caller holding a reference to it doesn't get a build
 * failure — do not use it in new code, and see `../interfaces`'s
 * `TempLog.breachedClasses`/`.ranges` for the shape that replaced it.
 */
export const DEFAULT_COLD_CHAIN_FROZEN_RANGE: { minC: string; maxC: string } = {
  minC: '-25.0',
  maxC: '-15.0',
};

// ── D-17 offline authorization defaults ───────────────────────────────────────

export const DEFAULT_OFFLINE_CREDENTIAL_TTL_HOURS = 24;
export const DEFAULT_OFFLINE_SELFIE_REQUIRED_ABOVE: Money = '200000.00';
export const DEFAULT_OFFLINE_APPROVAL_VOLUME_CAP = 20;
export const DEFAULT_MAX_OFFLINE_WINDOW_HOURS = 24;
export const CLOCK_SKEW_WARN_MINUTES = 2; // SYNC-PROTOCOL §6.3: persistent UI banner past this
export const CLOCK_SKEW_SUSPECT_HOURS = 24; // SYNC-PROTOCOL §6.3: time_suspect tagging past this

// ── D-19 / Amendment 2 ────────────────────────────────────────────────────────

/** `settings['pos.cash_variance_propose_above']` default — 0 means every shortfall proposes. */
export const DEFAULT_CASH_VARIANCE_PROPOSE_ABOVE: Money = '0.00';

// ── §4.20 approval thresholds (settings defaults) ─────────────────────────────

export const DEFAULT_APPROVAL_THRESHOLDS = {
  void: { managerAboveIdr: '200000.00' as Money },
  po: { ownerAboveIdr: '10000000.00' as Money },
  payment: { ownerAboveIdr: '20000000.00' as Money },
  opname: { managerAboveIdr: '2000000.00' as Money },
} as const;

/**
 * D-23 (owner-decided) — every `ApprovalDocumentType`'s default mode.
 * `MANUAL` for all 12 so existing behaviour is unchanged until an Owner
 * explicitly opts a document type into `whatsapp`/`auto`/`off` via
 * `PUT /api/settings/approval-modes/:documentType`. Kept here (not just
 * inline in M20) so `kernel/approvals`' repository can fall back to this
 * exact default without importing anything from `modules/settings`.
 */
export const DEFAULT_APPROVAL_MODES: Readonly<Record<ApprovalDocumentType, ApprovalMode>> = {
  [ApprovalDocumentType.REPLENISHMENT_REQUEST]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.VOID_REFUND]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.PURCHASE_REQUEST]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.PURCHASE_ORDER]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.STOCK_OPNAME]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.RETURN]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.WASTE]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.PAYROLL_RUN]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.PAYMENT_VERIFICATION]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.LEAVE_REQUEST]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.EMPLOYEE_LOAN]: ApprovalMode.MANUAL,
  [ApprovalDocumentType.CASH_VARIANCE_PROPOSAL]: ApprovalMode.MANUAL,
};

// ── §4.20 HR / payroll defaults ───────────────────────────────────────────────

export const DEFAULT_LATE_GRACE_MINUTES = 5;

export const DEFAULT_OVERTIME_SETTINGS = {
  ratePerHour: '15000.00' as Money,
  minMinutes: 30,
} as const;

export const DEFAULT_DEDUCTION_RATES = {
  /** `'daily_rate'` = employee's own daily-equivalent rate; otherwise a flat Money amount. */
  perAbsentDay: 'daily_rate' as const,
  perLateMinute: '500.00' as Money,
  sickPaid: true,
  permissionPaid: false,
} as const;

/** POUT-04 quotas. */
export const ANNUAL_LEAVE_QUOTA_DAYS = 12;
export const MARRIAGE_LEAVE_QUOTA_DAYS = 3;

/** POUT-05 stock-shortfall deduction policy. */
export const DEFAULT_SO_SHORTFALL_SETTINGS = {
  mode: 'attributable_only' as const,
  splitRule: 'equal_among_on_shift' as const,
} as const;

/** R4 (SYNC-PROTOCOL §5.5) — sale price vs catalog price tolerance. */
export const DEFAULT_PRICE_VARIANCE_TOLERANCE_PCT = '1.0';

// ── D-10 field scales (mirrors NUMERIC(p,s) in every migration; see ./decimal) ──

export const MONEY_DECIMALS = 2; // NUMERIC(18,2)
export const QTY_DECIMALS = 3; // NUMERIC(14,3)
export const TEMP_DECIMALS = 1; // NUMERIC(4,1)

// ── §0 document numbering ─────────────────────────────────────────────────────

/** Cloud-issued document type prefixes (`document_counters.doc_type`). */
export enum DocumentPrefix {
  SURAT_JALAN = 'SJ',
  PURCHASE_ORDER = 'PO',
  PURCHASE_REQUEST = 'PR',
  PETTY_CASH = 'PC',
  STOCK_OPNAME = 'OPN',
  RETURN = 'RET',
  WASTE = 'WST',
  JOURNAL_ENTRY = 'JE',
  PAYROLL_RUN = 'PRUN',
  PAYMENT_VERIFICATION = 'PV',
  REPLENISHMENT_REQUEST = 'RR',
  GOODS_RECEIPT = 'GR',
}

// ── §4.20 settings keys ────────────────────────────────────────────────────────

/**
 * Every seeded `settings` key (§4.20). `as const` + a derived union — the
 * same discipline as `PermissionKey` in `./rbac` and `ErrorCode` in
 * `./error-codes` — so a hand-typed key at a `GET/PUT /api/settings/:key`
 * call site (~20 agents will do this across Waves 3-5) is a compile error
 * when it doesn't match a real key, rather than a silent 404/undefined read.
 */
const SETTINGS_KEYS = [
  'company.profile',
  'approval.threshold.void',
  'approval.threshold.po',
  'approval.threshold.payment',
  'approval.threshold.opname',
  'hr.geofence_radius_m',
  'hr.late_grace_minutes',
  'hr.overtime',
  'hr.deduction_rates',
  'leave.quotas',
  'payroll.so_shortfall',
  'payroll.statutory',
  'pos.cash_variance_propose_above',
  'coldchain.frozen',
  'auth.offline_credential_ttl_h',
  'offline.selfie_required_above',
  'offline.approval_volume_cap',
  'sync.max_offline_window_h',
  'sync.price_variance_tolerance',
  'pos.qris',
  'wa.enabled',
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];
export const SETTINGS_KEY_LIST: readonly SettingsKey[] = SETTINGS_KEYS;

// ── §3 role rank (for "MGR/OWN may act on any step at or below their level") ──

/** Higher number = broader authority. Used by the approval engine's role-rank override rule (§5). */
export const ROLE_RANK: Readonly<Record<RoleKey, number>> = {
  // Above OWNER by design: the all-access role must be able to act on any
  // approval step, including one whose chain names the owner. A rank EQUAL to
  // owner's would have been the subtler choice, but the override rule is
  // "at or below their level", so equal already grants the same reach — 110
  // just states the intent rather than relying on the comparison's edge.
  [RoleKey.SUPERADMIN]: 110,
  [RoleKey.OWNER]: 100,
  [RoleKey.MANAGER]: 90,
  [RoleKey.FINANCE]: 50,
  [RoleKey.KEPALA_GUDANG]: 50,
  [RoleKey.HR_ADMIN]: 50,
  [RoleKey.SUPERVISOR]: 40,
  [RoleKey.LEADER_OUTLET]: 30,
  [RoleKey.KASIR]: 10,
  [RoleKey.DRIVER]: 10,
};
