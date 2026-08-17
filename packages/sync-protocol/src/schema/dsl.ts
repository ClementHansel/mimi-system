/**
 * A minimal, zero-dependency schema DSL: one declaration per field, both the
 * runtime validator AND the TypeScript type derive from it. This exists so
 * `./registry.ts`'s 130+ payload schemas cannot suffer the exact problem this
 * whole registry was commissioned to close — a hand-written TS `interface`
 * drifting from a hand-written runtime check because they're declared twice.
 * Declare a field once; `Infer<>` gives you the type, `validate()` gives you
 * the check.
 *
 * Deliberately not a dependency on zod/io-ts/ajv: this package runs in the
 * browser device tier as well as Node (cloud, branch node), and the schema
 * shapes needed here (money/qty/temp strings, UUIDs, ISO dates, nested
 * objects/arrays, enums) are a small enough set that a hand-rolled ~150-line
 * engine is easier to audit than a dependency, and keeps `@mimi/sync-protocol`
 * dependency-free the way `@mimi/shared` is.
 */
import { parseFixed } from '@mimi/shared';
import type { ISODate, ISODateTime, Money, Qty, Temp, UUID } from '@mimi/shared';

// ── Field schema shapes ───────────────────────────────────────────────────────

export interface StringField { kind: 'string' }
export interface UuidField { kind: 'uuid' }
export interface MoneyField { kind: 'money' }
export interface QtyField { kind: 'qty' }
export interface TempField { kind: 'temp' }
export interface IsoDateField { kind: 'isoDate' }
export interface IsoDateTimeField { kind: 'isoDateTime' }
export interface BooleanField { kind: 'boolean' }
export interface NumberField { kind: 'number' }
export interface LiteralField<V extends string = string> { kind: 'literal'; value: V }
export interface EnumField<V extends readonly string[] = readonly string[]> { kind: 'enum'; values: V }
export interface ArrayField<F extends FieldSchema = FieldSchema> { kind: 'array'; of: F }
export interface ObjectField<F extends Record<string, FieldSchema> = Record<string, FieldSchema>> {
  kind: 'object';
  fields: F;
}
export interface NullableField<F extends FieldSchema = FieldSchema> { kind: 'nullable'; of: F }
export interface OptionalField<F extends FieldSchema = FieldSchema> { kind: 'optional'; of: F }
/** Escape hatch for payload slices this registry deliberately doesn't pin down further (see the report's ambiguous-case list). Accepts anything, including absence. */
export interface UnknownField { kind: 'unknown' }

export type FieldSchema =
  | StringField
  | UuidField
  | MoneyField
  | QtyField
  | TempField
  | IsoDateField
  | IsoDateTimeField
  | BooleanField
  | NumberField
  | LiteralField
  | EnumField
  | ArrayField
  | ObjectField
  | NullableField
  | OptionalField
  | UnknownField;

// ── Builders ───────────────────────────────────────────────────────────────────

export const string = (): StringField => ({ kind: 'string' });
export const uuid = (): UuidField => ({ kind: 'uuid' });
export const money = (): MoneyField => ({ kind: 'money' });
export const qty = (): QtyField => ({ kind: 'qty' });
export const temp = (): TempField => ({ kind: 'temp' });
export const isoDate = (): IsoDateField => ({ kind: 'isoDate' });
export const isoDateTime = (): IsoDateTimeField => ({ kind: 'isoDateTime' });
export const boolean = (): BooleanField => ({ kind: 'boolean' });
export const number = (): NumberField => ({ kind: 'number' });
export function literal<V extends string>(value: V): LiteralField<V> {
  return { kind: 'literal', value };
}
export function enumOf<V extends readonly string[]>(values: V): EnumField<V> {
  return { kind: 'enum', values };
}
export function array<F extends FieldSchema>(of: F): ArrayField<F> {
  return { kind: 'array', of };
}
export function object<F extends Record<string, FieldSchema>>(fields: F): ObjectField<F> {
  return { kind: 'object', fields };
}
export function nullable<F extends FieldSchema>(of: F): NullableField<F> {
  return { kind: 'nullable', of };
}
export function optional<F extends FieldSchema>(of: F): OptionalField<F> {
  return { kind: 'optional', of };
}
export const unknownField = (): UnknownField => ({ kind: 'unknown' });

// ── Type inference (the TS-type half of "declare once") ──────────────────────

// prettier-ignore
export type Infer<F extends FieldSchema> =
  F extends StringField ? string :
  F extends UuidField ? UUID :
  F extends MoneyField ? Money :
  F extends QtyField ? Qty :
  F extends TempField ? Temp :
  F extends IsoDateField ? ISODate :
  F extends IsoDateTimeField ? ISODateTime :
  F extends BooleanField ? boolean :
  F extends NumberField ? number :
  F extends LiteralField<infer V> ? V :
  F extends EnumField<infer V> ? V[number] :
  F extends ArrayField<infer O> ? Infer<O>[] :
  F extends ObjectField<infer Fl> ? { [K in keyof Fl]: Infer<Fl[K]> } :
  F extends NullableField<infer O> ? Infer<O> | null :
  F extends OptionalField<infer O> ? Infer<O> | undefined :
  F extends UnknownField ? unknown :
  never;

// ── Runtime validation (the check-it half of "declare once") ─────────────────

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; issues: readonly ValidationIssue[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(path: string, message: string): ValidationResult {
  return { ok: false, issues: [{ path, message }] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeIssues(results: readonly ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => (r.ok ? [] : r.issues));
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Structural validation only — this is NOT a full JSON-schema engine. It
 * checks: the right JS type; for money/qty/temp, that the string is a valid
 * decimal at the field's scale (reusing `@mimi/shared`'s parse functions —
 * one decimal-string validator, not a second regex-based one); for objects,
 * that every non-optional field is present and itself valid. It does NOT
 * reject unknown extra properties — SYNC-PROTOCOL §2.3's additive-only
 * versioning rule means every consumer MUST ignore fields it doesn't
 * recognize, so this validator mustn't punish a producer for sending a
 * newer, still-compatible payload.
 */
export function validate(schema: FieldSchema, value: unknown, path = '$'): ValidationResult {
  switch (schema.kind) {
    case 'string':
      return typeof value === 'string' ? { ok: true } : fail(path, `expected string, got ${typeOf(value)}`);
    case 'uuid':
      return typeof value === 'string' && UUID_RE.test(value)
        ? { ok: true }
        : fail(path, `expected a UUID string, got ${describeValue(value)}`);
    case 'money':
      return validateDecimalString(value, path, 2, 'Money');
    case 'qty':
      return validateDecimalString(value, path, 3, 'Qty');
    case 'temp':
      return validateDecimalString(value, path, 1, 'Temp');
    case 'isoDate':
      return typeof value === 'string' && ISO_DATE_RE.test(value)
        ? { ok: true }
        : fail(path, `expected 'YYYY-MM-DD', got ${describeValue(value)}`);
    case 'isoDateTime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? { ok: true }
        : fail(path, `expected an ISO-8601 datetime string, got ${describeValue(value)}`);
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : fail(path, `expected boolean, got ${typeOf(value)}`);
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value) ? { ok: true } : fail(path, `expected number, got ${typeOf(value)}`);
    case 'literal':
      return value === schema.value ? { ok: true } : fail(path, `expected literal ${JSON.stringify(schema.value)}, got ${describeValue(value)}`);
    case 'enum':
      return typeof value === 'string' && (schema.values as readonly string[]).includes(value)
        ? { ok: true }
        : fail(path, `expected one of ${JSON.stringify(schema.values)}, got ${describeValue(value)}`);
    case 'array':
      if (!Array.isArray(value)) return fail(path, `expected array, got ${typeOf(value)}`);
      return mergeIssues(value.map((item, i) => validate(schema.of, item, `${path}[${i}]`)));
    case 'object': {
      if (!isPlainObject(value)) return fail(path, `expected object, got ${typeOf(value)}`);
      const results: ValidationResult[] = [];
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        results.push(validate(fieldSchema, value[key], `${path}.${key}`));
      }
      return mergeIssues(results);
    }
    case 'nullable':
      return value === null ? { ok: true } : validate(schema.of, value, path);
    case 'optional':
      return value === undefined ? { ok: true } : validate(schema.of, value, path);
    case 'unknown':
      return { ok: true };
  }
}

function validateDecimalString(value: unknown, path: string, scale: number, label: string): ValidationResult {
  if (typeof value !== 'string') return fail(path, `expected a ${label} decimal string, got ${typeOf(value)}`);
  try {
    parseFixed(value, scale);
    return { ok: true };
  } catch {
    return fail(path, `expected a valid ${label} decimal string at scale ${scale}, got ${describeValue(value)}`);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Bigint-tolerant `JSON.stringify` for describing an unexpected value inside
 * a validation-FAILURE message. A malformed payload is exactly the case this
 * validator exists to report cleanly — it must never itself throw while
 * describing what was wrong (the same `TypeError: Do not know how to
 * serialize a BigInt` this file's other fixes address, just reachable here
 * via a mistyped field rather than a legitimate `clientSeq`).
 */
function describeValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
