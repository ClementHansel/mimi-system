/**
 * Structural `value` validation per `SettingsKey` (CONTRACTS.md §4.20: "PUT
 * /api/settings/:key ... schema-validated per key in packages/shared"). No
 * such per-key JSON-schema validator is exported by `@mimi/shared` today —
 * this is a lightweight, declarative structural check living in M20 itself
 * (the module that owns the endpoint), checked against the exact shapes
 * CONTRACTS.md §4.20's seed-default table documents. `'payroll.statutory'`
 * is deliberately NOT in this map — the raw PUT route rejects that key
 * before ever reaching value validation (`ERR_USE_WIZARD`).
 */
import type { SettingsKey } from '@mimi/shared';

type FieldType = 'string' | 'number' | 'boolean' | 'string|null';

type Schema =
  | { kind: 'object'; fields: Record<string, FieldType> }
  // A list of uniform objects. Added for `hr.tenure_tiers` (D-16), the first
  // settings value that is a JSON array rather than a scalar or a flat object.
  // `minItems` exists because an EMPTY tier list is a valid JSON array and a
  // silent policy change: `tenureAllowance()` returns zero when no tier
  // matches, so saving `[]` would remove every long-service allowance from the
  // next payroll run with no error anywhere.
  | { kind: 'array'; minItems: number; elementFields: Record<string, FieldType> }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' };

const SCHEMAS: Partial<Record<SettingsKey, Schema>> = {
  'company.profile': {
    kind: 'object',
    fields: { name: 'string', address: 'string', city: 'string', logoAttachmentId: 'string|null' },
  },
  'approval.threshold.void': { kind: 'object', fields: { managerAboveIdr: 'string' } },
  'approval.threshold.po': { kind: 'object', fields: { ownerAboveIdr: 'string' } },
  'approval.threshold.payment': { kind: 'object', fields: { ownerAboveIdr: 'string' } },
  'approval.threshold.opname': { kind: 'object', fields: { managerAboveIdr: 'string' } },
  'hr.geofence_radius_m': { kind: 'number' },
  'hr.late_grace_minutes': { kind: 'number' },
  'hr.overtime': { kind: 'object', fields: { ratePerHour: 'string', minMinutes: 'number' } },
  'hr.deduction_rates': {
    kind: 'object',
    fields: {
      perAbsentDay: 'string',
      perLateMinute: 'string',
      sickPaid: 'boolean',
      permissionPaid: 'boolean',
    },
  },
  /**
   * PIN-05 tenure tiers (D-16). `amount` is a `'string'` because Money is a
   * decimal string everywhere in this system — a JSON number would lose the
   * two fixed decimals and reintroduce float rounding into gross pay.
   */
  'hr.tenure_tiers': {
    kind: 'array',
    minItems: 1,
    elementFields: { minYears: 'number', amount: 'string' },
  },
  'leave.quotas': { kind: 'object', fields: { annual: 'number', marriage: 'number' } },
  'payroll.so_shortfall': { kind: 'object', fields: { mode: 'string', splitRule: 'string' } },
  'pos.cash_variance_propose_above': { kind: 'string' },
  'coldchain.frozen': { kind: 'object', fields: { minC: 'string', maxC: 'string' } },
  'auth.offline_credential_ttl_h': { kind: 'number' },
  'offline.selfie_required_above': { kind: 'string' },
  'offline.approval_volume_cap': { kind: 'number' },
  'sync.max_offline_window_h': { kind: 'number' },
  'sync.price_variance_tolerance': { kind: 'object', fields: { pct: 'string' } },
  'pos.qris': { kind: 'object', fields: { mode: 'string' } },
  'wa.enabled': { kind: 'boolean' },

  /**
   * `BrandIdentity` from `packages/shared/src/brand.ts` — the favicon plus the
   * four colours every printed document resolves its `brand.*` tokens against.
   *
   * The colours are declared `'string'`, not a hex pattern, and that is a
   * deliberate limit of this validator rather than an oversight: `FieldType`
   * carries no regex arm, and adding one for a single key would put a second
   * validation vocabulary into a file whose whole value is that it is short
   * and obviously correct. The real defence is downstream and already exists —
   * `resolveDocColor()` (shared) accepts only `#rrggbb` or a `brand.*` token
   * and falls back to `ink` for anything else, so a garbage colour prints in
   * ink instead of throwing mid-render. A document that prints in the wrong
   * colour is recoverable; one that fails to print is not. The Brand panel's
   * own colour picker is what stops a human typing "reddish" in the first
   * place.
   *
   * `faviconAttachmentId` is `'string|null'` for the same reason
   * `company.profile.logoAttachmentId` is: null means "fall back to the
   * shipped icons", and without an explicit null there would be no way to
   * clear a favicon once set. Note there is deliberately NO `logoAttachmentId`
   * here — the company logo stays on `company.profile`, in one place, for the
   * reasons `brand.ts`'s header sets out.
   */
  'brand.identity': {
    kind: 'object',
    fields: {
      faviconAttachmentId: 'string|null',
      primaryColor: 'string',
      accentColor: 'string',
      inkColor: 'string',
      mutedColor: 'string',
    },
  },

  /**
   * `VoucherOfflinePolicy` — `'reject'` (default) or `'accept'`. Declared as a
   * plain `'string'` here and range-checked where it is CONSUMED
   * (`getVoucherOfflinePolicy()` in `modules/voucher/voucher-settings.util.ts`
   * returns `'reject'` for any value it does not recognise), matching how
   * `pos.qris.mode` and `payroll.so_shortfall.mode` already treat their own
   * closed sets. Failing closed at the consumer is what actually matters for
   * this key: a typo must never be read as "accept unverifiable coupons".
   */
  'pos.voucher_offline': { kind: 'string' },
};

function typeMatches(value: unknown, type: FieldType): boolean {
  if (type === 'string|null') return value === null || typeof value === 'string';
  return typeof value === type;
}

/** Returns a human-diagnostic error list — empty means valid. `key`s with no declared schema (should not happen for any real `SettingsKey`) pass through unchecked rather than blocking an otherwise-valid write. */
export function validateSettingValue(key: SettingsKey, value: unknown): string[] {
  const schema = SCHEMAS[key];
  if (!schema) return [];

  if (schema.kind === 'string')
    return typeof value === 'string' ? [] : [`'${key}' must be a string`];
  if (schema.kind === 'number')
    return typeof value === 'number' ? [] : [`'${key}' must be a number`];
  if (schema.kind === 'boolean')
    return typeof value === 'boolean' ? [] : [`'${key}' must be a boolean`];

  if (schema.kind === 'array') {
    if (!Array.isArray(value)) return [`'${key}' must be an array`];
    if (value.length < schema.minItems)
      return [
        `'${key}' must have at least ${schema.minItems} entr${schema.minItems === 1 ? 'y' : 'ies'}`,
      ];
    const errors: string[] = [];
    value.forEach((element, i) => {
      if (typeof element !== 'object' || element === null || Array.isArray(element)) {
        errors.push(`'${key}'[${i}] must be an object`);
        return;
      }
      const el = element as Record<string, unknown>;
      for (const [field, type] of Object.entries(schema.elementFields)) {
        if (!typeMatches(el[field], type)) errors.push(`'${key}'[${i}].${field} must be a ${type}`);
      }
    });
    return errors;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`'${key}' must be an object with fields: ${Object.keys(schema.fields).join(', ')}`];
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [field, type] of Object.entries(schema.fields)) {
    if (!(field in obj)) {
      errors.push(`'${key}.${field}' is required`);
      continue;
    }
    if (!typeMatches(obj[field], type)) {
      errors.push(`'${key}.${field}' must be of type ${type}`);
    }
  }
  return errors;
}
