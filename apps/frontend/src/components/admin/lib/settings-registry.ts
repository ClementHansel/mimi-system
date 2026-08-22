/**
 * What each setting MEANS, in the owner's language, and how it may be edited.
 *
 * Owner, 2026-08-21: "redesign this and the detail modal. this is confusing for
 * normal user." The old screen listed the raw key (`approval.threshold.opname`),
 * the developer's English description ("Stock opname manager escalation
 * threshold (§5.4)"), and — the part that made it unusable — NO VALUE AT ALL.
 * Editing opened a JSON textarea, so the only safe way to raise an approval
 * limit was to already know the wire shape.
 *
 * This registry is the missing layer: per key, which SECTION it belongs to,
 * what to call it, what changing it actually does, and a FIELD SPEC so the UI
 * can render a money box or a minutes box instead of braces.
 *
 * Three deliberate choices:
 *
 *  1. Unknown keys are NOT hidden. A setting added by a later migration falls
 *     back to its raw key and the JSON editor — visible and editable, just
 *     unstyled. Hiding it would mean a new setting silently becomes
 *     unreachable from the UI.
 *  2. Structured settings that already have a dedicated screen
 *     (`approval.mode`, `payroll.statutory`) are marked `managedElsewhere`, so
 *     this screen points at that screen instead of offering a raw edit the
 *     server may reject (`ERR_USE_WIZARD`).
 *  3. Money and temperature travel as decimal STRINGS (CONTRACTS §0). The field
 *     specs say so, so an editor never turns "2000000.00" into a float and back
 *     into "2000000.0000000001".
 */

/** Where a setting appears. Order here is the order on screen. */
export const SETTING_SECTIONS = [
  'approval',
  'attendance',
  'payroll',
  'pos',
  'coldchain',
  'sync',
  'company',
  'other',
] as const;

export type SettingSection = (typeof SETTING_SECTIONS)[number];

/** One editable field inside a setting's value. */
export type SettingField =
  /** The whole value IS this scalar (`hr.late_grace_minutes` = 5). */
  | { kind: 'number'; unit: 'minutes' | 'hours' | 'metres' | 'days' | 'count' | 'percent' }
  | { kind: 'money' }
  | { kind: 'boolean' }
  | { kind: 'text' }
  /** A named field inside an object value (`{ managerAboveIdr: "..." }`). */
  | {
      kind: 'object';
      fields: {
        path: string;
        labelKey: string;
        field: Exclude<SettingField, { kind: 'object' }>;
        optional?: boolean;
      }[];
    };

export interface SettingSpec {
  section: SettingSection;
  /** i18n key for the human name. */
  labelKey: string;
  /** i18n key for "what happens when you change this". */
  helpKey: string;
  field: SettingField;
  /**
   * Has its own screen (approval modes, the payroll-statutory wizard). This one
   * is read-only here and links there.
   */
  managedElsewhere?: { hrefTab: string; noteKey: string };
}

/** Scalar field kinds — everything except the composite `object`. */
type ScalarField = Exclude<SettingField, { kind: 'object' }>;

// Typed as ScalarField, not SettingField: these are used BOTH as a whole
// value's shape and as a field inside an object, and the nested position only
// accepts scalars (an object inside an object has no editor).
const money = (): ScalarField => ({ kind: 'money' });
const num = (unit: Extract<SettingField, { kind: 'number' }>['unit']): ScalarField => ({
  kind: 'number',
  unit,
});

/**
 * One entry per row in `settings` as of migration 229. Keys not listed here
 * still render — see choice (1) in the header.
 */
export const SETTING_REGISTRY: Record<string, SettingSpec> = {
  // ── Persetujuan: the four money lines that decide who has to sign ──────────
  'approval.threshold.void': {
    section: 'approval',
    labelKey: 'admin.settings.spec.void.label',
    helpKey: 'admin.settings.spec.void.help',
    field: {
      kind: 'object',
      fields: [
        {
          path: 'managerAboveIdr',
          labelKey: 'admin.settings.spec.field.managerAbove',
          field: money(),
        },
      ],
    },
  },
  'approval.threshold.opname': {
    section: 'approval',
    labelKey: 'admin.settings.spec.opname.label',
    helpKey: 'admin.settings.spec.opname.help',
    field: {
      kind: 'object',
      fields: [
        {
          path: 'managerAboveIdr',
          labelKey: 'admin.settings.spec.field.managerAbove',
          field: money(),
        },
      ],
    },
  },
  'approval.threshold.po': {
    section: 'approval',
    labelKey: 'admin.settings.spec.po.label',
    helpKey: 'admin.settings.spec.po.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'ownerAboveIdr', labelKey: 'admin.settings.spec.field.ownerAbove', field: money() },
      ],
    },
  },
  'approval.threshold.payment': {
    section: 'approval',
    labelKey: 'admin.settings.spec.payment.label',
    helpKey: 'admin.settings.spec.payment.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'ownerAboveIdr', labelKey: 'admin.settings.spec.field.ownerAbove', field: money() },
      ],
    },
  },
  'approval.mode': {
    section: 'approval',
    labelKey: 'admin.settings.spec.approvalMode.label',
    helpKey: 'admin.settings.spec.approvalMode.help',
    field: { kind: 'text' },
    // D-23 has its own screen with the per-document-type switches; editing the
    // raw object here would bypass the guard rails it puts around turning an
    // approval chain OFF.
    managedElsewhere: {
      hrefTab: 'approvalModes',
      noteKey: 'admin.settings.spec.approvalMode.elsewhere',
    },
  },

  // ── Absensi & jam kerja ───────────────────────────────────────────────────
  'hr.geofence_radius_m': {
    section: 'attendance',
    labelKey: 'admin.settings.spec.geofence.label',
    helpKey: 'admin.settings.spec.geofence.help',
    field: num('metres'),
  },
  'hr.late_grace_minutes': {
    section: 'attendance',
    labelKey: 'admin.settings.spec.lateGrace.label',
    helpKey: 'admin.settings.spec.lateGrace.help',
    field: num('minutes'),
  },
  'leave.quotas': {
    section: 'attendance',
    labelKey: 'admin.settings.spec.leaveQuotas.label',
    helpKey: 'admin.settings.spec.leaveQuotas.help',
    field: {
      kind: 'object',
      fields: [
        {
          path: 'annual',
          labelKey: 'admin.settings.spec.field.annualLeave',
          field: num('days'),
        },
        {
          path: 'marriage',
          labelKey: 'admin.settings.spec.field.marriageLeave',
          field: num('days'),
        },
      ],
    },
  },

  // ── Penggajian ────────────────────────────────────────────────────────────
  'hr.overtime': {
    section: 'payroll',
    labelKey: 'admin.settings.spec.overtime.label',
    helpKey: 'admin.settings.spec.overtime.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'ratePerHour', labelKey: 'admin.settings.spec.field.ratePerHour', field: money() },
        {
          path: 'minMinutes',
          labelKey: 'admin.settings.spec.field.minMinutes',
          field: num('minutes'),
        },
      ],
    },
  },
  'hr.deduction_rates': {
    section: 'payroll',
    labelKey: 'admin.settings.spec.deductions.label',
    helpKey: 'admin.settings.spec.deductions.help',
    field: {
      kind: 'object',
      fields: [
        {
          path: 'perLateMinute',
          labelKey: 'admin.settings.spec.field.perLateMinute',
          field: money(),
        },
        {
          path: 'sickPaid',
          labelKey: 'admin.settings.spec.field.sickPaid',
          field: { kind: 'boolean' },
        },
        {
          path: 'permissionPaid',
          labelKey: 'admin.settings.spec.field.permissionPaid',
          field: { kind: 'boolean' },
        },
        // `perAbsentDay` is an enum-ish rule name ('daily_rate'), not a number.
        // Left as text rather than invented into a dropdown whose options
        // nobody has defined.
        {
          path: 'perAbsentDay',
          labelKey: 'admin.settings.spec.field.perAbsentDay',
          field: { kind: 'text' },
        },
      ],
    },
  },
  'payroll.statutory': {
    section: 'payroll',
    labelKey: 'admin.settings.spec.statutory.label',
    helpKey: 'admin.settings.spec.statutory.help',
    field: { kind: 'text' },
    // The server rejects a raw PUT here with ERR_USE_WIZARD.
    managedElsewhere: {
      hrefTab: 'payroll',
      noteKey: 'admin.settings.spec.statutory.elsewhere',
    },
  },
  'payroll.so_shortfall': {
    section: 'payroll',
    labelKey: 'admin.settings.spec.soShortfall.label',
    helpKey: 'admin.settings.spec.soShortfall.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'mode', labelKey: 'admin.settings.spec.field.mode', field: { kind: 'text' } },
        {
          path: 'splitRule',
          labelKey: 'admin.settings.spec.field.splitRule',
          field: { kind: 'text' },
        },
      ],
    },
  },

  // ── Kasir / POS ───────────────────────────────────────────────────────────
  'pos.cash_variance_propose_above': {
    section: 'pos',
    labelKey: 'admin.settings.spec.cashVariance.label',
    helpKey: 'admin.settings.spec.cashVariance.help',
    field: money(),
  },
  'pos.qris': {
    section: 'pos',
    labelKey: 'admin.settings.spec.qris.label',
    helpKey: 'admin.settings.spec.qris.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'mode', labelKey: 'admin.settings.spec.field.mode', field: { kind: 'text' } },
      ],
    },
  },
  'offline.selfie_required_above': {
    section: 'pos',
    labelKey: 'admin.settings.spec.selfieAbove.label',
    helpKey: 'admin.settings.spec.selfieAbove.help',
    field: money(),
  },
  'offline.approval_volume_cap': {
    section: 'pos',
    labelKey: 'admin.settings.spec.offlineCap.label',
    helpKey: 'admin.settings.spec.offlineCap.help',
    field: num('count'),
  },
  'auth.offline_credential_ttl_h': {
    section: 'pos',
    labelKey: 'admin.settings.spec.offlineTtl.label',
    helpKey: 'admin.settings.spec.offlineTtl.help',
    field: num('hours'),
  },

  // ── Rantai dingin ─────────────────────────────────────────────────────────
  'coldchain.frozen': {
    section: 'coldchain',
    labelKey: 'admin.settings.spec.coldchain.label',
    helpKey: 'admin.settings.spec.coldchain.help',
    field: {
      kind: 'object',
      fields: [
        { path: 'minC', labelKey: 'admin.settings.spec.field.minC', field: { kind: 'text' } },
        { path: 'maxC', labelKey: 'admin.settings.spec.field.maxC', field: { kind: 'text' } },
      ],
    },
  },

  // ── Sinkronisasi ──────────────────────────────────────────────────────────
  'sync.max_offline_window_h': {
    section: 'sync',
    labelKey: 'admin.settings.spec.offlineWindow.label',
    helpKey: 'admin.settings.spec.offlineWindow.help',
    field: num('hours'),
  },
  'sync.price_variance_tolerance': {
    section: 'sync',
    labelKey: 'admin.settings.spec.priceVariance.label',
    helpKey: 'admin.settings.spec.priceVariance.help',
    field: {
      kind: 'object',
      fields: [{ path: 'pct', labelKey: 'admin.settings.spec.field.pct', field: num('percent') }],
    },
  },
  'wa.enabled': {
    section: 'sync',
    labelKey: 'admin.settings.spec.waEnabled.label',
    helpKey: 'admin.settings.spec.waEnabled.help',
    field: { kind: 'boolean' },
  },

  // ── Perusahaan ────────────────────────────────────────────────────────────
  'company.profile': {
    section: 'company',
    labelKey: 'admin.settings.spec.company.label',
    helpKey: 'admin.settings.spec.company.help',
    field: {
      kind: 'object',
      fields: [
        {
          path: 'name',
          labelKey: 'admin.settings.spec.field.companyName',
          field: { kind: 'text' },
        },
        { path: 'address', labelKey: 'admin.settings.spec.field.address', field: { kind: 'text' } },
        { path: 'city', labelKey: 'admin.settings.spec.field.city', field: { kind: 'text' } },
      ],
    },
  },
};

export function specFor(key: string): SettingSpec | undefined {
  return SETTING_REGISTRY[key];
}

/** Section a key belongs to; unknown keys land in `other` rather than vanishing. */
export function sectionFor(key: string): SettingSection {
  return SETTING_REGISTRY[key]?.section ?? 'other';
}

/**
 * Reads a dotted path out of a setting's value. Returns '' for anything
 * missing, so a field the server has not populated renders as empty rather
 * than as "undefined".
 */
export function valueAt(value: unknown, path: string): string {
  if (value === null || typeof value !== 'object') return '';
  const raw = (value as Record<string, unknown>)[path];
  if (raw === null || raw === undefined) return '';
  return String(raw);
}
