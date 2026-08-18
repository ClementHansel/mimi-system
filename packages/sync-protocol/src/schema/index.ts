/**
 * The public surface of the payload schema registry: `PAYLOAD_SCHEMAS` (data),
 * `PayloadDataFor<K>` (the TS type half), and `validatePayloadData` (the
 * runtime-check half) — both derived from the same schema declarations in
 * `./registry`, so they cannot diverge from each other the way a hand-written
 * interface and a hand-written validator could.
 */
import { validate, type Infer, type ValidationResult, type ObjectField } from './dsl';
import { PAYLOAD_SCHEMAS } from './registry';

// Deliberately NOT a blanket `export * from './dsl'`: the DSL's builder
// functions (`string()`, `number()`, `object()`, `array()`, ...) are
// registry-construction plumbing, not consumer-facing API — their names are
// generic enough that re-exporting them from `@mimi/sync-protocol`'s public
// barrel would be an easy, silent collision for any consumer importing
// alongside other utilities. Only the schema TYPES and the runtime
// validator — what a consumer actually needs — cross this boundary.
export type {
  FieldSchema,
  StringField,
  UuidField,
  MoneyField,
  QtyField,
  TempField,
  IsoDateField,
  IsoDateTimeField,
  BooleanField,
  NumberField,
  LiteralField,
  EnumField,
  ArrayField,
  ObjectField,
  NullableField,
  OptionalField,
  UnknownField,
  Infer,
  ValidationIssue,
  ValidationResult,
} from './dsl';
export { validate as validateAgainstFieldSchema } from './dsl';
export * from './registry';

/** Every registered `"<entity>.<op>"` key. */
export type PayloadSchemaKey = keyof typeof PAYLOAD_SCHEMAS;

export const PAYLOAD_SCHEMA_KEYS: readonly PayloadSchemaKey[] = Object.keys(
  PAYLOAD_SCHEMAS,
) as PayloadSchemaKey[];

/** The TypeScript type of `payload.data` for a given registered `(entity, op)` key — e.g. `PayloadDataFor<'sales.completed'>`. */
export type PayloadDataFor<K extends PayloadSchemaKey> = Infer<(typeof PAYLOAD_SCHEMAS)[K]>;

/** Splits `"<entity>.<op>"` back into its parts (payload schema keys use the same separator as the registry's own key format). */
export function toPayloadSchemaKey(entity: string, op: string): string {
  return `${entity}.${op}`;
}

/** The registered schema for `(entity, op)`, or `undefined` if none exists (either an unknown pair, or a class-D/X/T entity that legitimately has no wire schema). */
export function getPayloadSchema(entity: string, op: string): ObjectField | undefined {
  const key = toPayloadSchemaKey(entity, op);
  return Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, key)
    ? (PAYLOAD_SCHEMAS as Record<string, ObjectField>)[key]
    : undefined;
}

export function isRegisteredPayloadKey(entity: string, op: string): boolean {
  return getPayloadSchema(entity, op) !== undefined;
}

/**
 * Validates `data` (a `payload.data` value already parsed from JSON) against
 * the registered schema for `(entity, op)`. This is what W2-D (cloud ingest)
 * and W2-E (device apply) should call instead of a defensive try/catch around
 * field access — an unregistered `(entity, op)` is reported as its own issue
 * rather than silently passing (that would defeat the whole point: a typo'd
 * or renamed field should fail loudly, not slip through as "no schema, so
 * nothing to check").
 */
export function validatePayloadData(entity: string, op: string, data: unknown): ValidationResult {
  const schema = getPayloadSchema(entity, op);
  if (!schema) {
    return {
      ok: false,
      issues: [{ path: '$', message: `No payload schema registered for "${entity}.${op}"` }],
    };
  }
  return validate(schema, data);
}
