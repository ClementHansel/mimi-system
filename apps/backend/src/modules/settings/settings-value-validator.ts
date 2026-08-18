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
