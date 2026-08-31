import {
  ERR_DUPLICATE,
  ERR_REFERENCED,
  ERR_VALIDATION,
  ERR_FORBIDDEN,
  type ErrorCode,
} from '@mimi/shared';

/**
 * SQLSTATE → CONTRACTS §0 error shape.
 *
 * WHY THIS FILE EXISTS. Before it, any database error that a service had not
 * pre-checked fell through `AllExceptionsFilter`'s last branch and was served
 * as `{ statusCode: 500, code: ERR_INTERNAL, message: <the driver's own text> }`.
 * The frontend then put that text in a toast, so saving a supplier whose code
 * already existed told the user:
 *
 *     duplicate key value violates unique constraint "suppliers_code_key"
 *
 * That is wrong three times over: it is English, it is the schema's vocabulary
 * rather than the form's, and 500 says "we broke" about a refusal the user can
 * fix by typing a different code. It also leaks table and constraint names to
 * any caller.
 *
 * So a recognized SQLSTATE now becomes a real status and a stable `code`, with
 * the machine detail in `details` (never in `message`) for the frontend to
 * build a sentence from. The user-facing words live in the frontend's i18n
 * keyed by `code`; nothing here is user-facing, per this package's
 * English-identifiers-only rule.
 *
 * A service that can say something MORE specific still should — pre-checking a
 * duplicate and throwing `ConflictException` names the field with certainty
 * instead of parsing it out of a constraint name. This is the safety net under
 * the paths that don't, not a licence to stop pre-checking.
 */

/** The subset of `pg`'s error surface this mapper reads. */
export interface PgErrorLike {
  code: string;
  constraint?: string;
  column?: string;
  table?: string;
  detail?: string;
}

export interface MappedPgError {
  statusCode: number;
  code: ErrorCode;
  /** Machine detail only — `{ constraint, entity, field }`. Never user-facing text. */
  details: Record<string, string>;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';
const INVALID_TEXT_REPRESENTATION = '22P02';
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
const STRING_DATA_RIGHT_TRUNCATION = '22001';
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * `true` for anything shaped like a `pg` error. `pg` sets `code` to the
 * five-character SQLSTATE; a plain `Error` has no `code`, and Node's own
 * errors use word codes (`ENOENT`, `ECONNREFUSED`), so the length-and-shape
 * check is what keeps those out.
 */
export function isPgError(err: unknown): err is PgErrorLike {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Split a Postgres constraint name into the entity and field a user would
 * recognize. Postgres' own default for a unique constraint is
 * `<table>_<column...>_key`, and this repo's hand-named ones follow
 * `ux_/uq_/uniq_<table>_<column...>`; both reduce to the same two parts.
 *
 * `suppliers_code_key`            → `{ entity: 'suppliers', field: 'code' }`
 * `ux_contract_signatures_employee` → `{ entity: 'contract', field: 'signatures_employee' }`
 *
 * The second line is the honest limit of this: without the catalog we cannot
 * know where the table name stops in a multi-word name. That is exactly why
 * `details` carries `constraint` too, and why the frontend treats a field it
 * does not recognize as "no field" and falls back to the generic sentence
 * rather than printing a guess at a column name.
 */
export function parseConstraint(constraint: string | undefined): {
  entity?: string;
  field?: string;
} {
  if (!constraint) return {};
  const name = constraint
    .replace(/^(ux|uq|uniq|unique|fk|idx)_/, '')
    .replace(/_(key|unique|fkey)$/, '');
  const parts = name.split('_').filter(Boolean);
  if (parts.length < 2) return { entity: parts[0] };
  return { entity: parts[0], field: parts.slice(1).join('_') };
}

/**
 * Map a `pg` error to a status + stable code, or `null` for a SQLSTATE that is
 * genuinely a fault on our side (deadlock, syntax error, connection loss) —
 * those keep falling through to 500/`ERR_INTERNAL`, which is what they are.
 */
export function mapPgError(err: PgErrorLike): MappedPgError | null {
  const details: Record<string, string> = {};
  if (err.constraint) details.constraint = err.constraint;
  if (err.table) details.table = err.table;
  if (err.column) details.column = err.column;
  const { entity, field } = parseConstraint(err.constraint);
  if (entity) details.entity = entity;
  if (field) details.field = field;

  switch (err.code) {
    case UNIQUE_VIOLATION:
    case EXCLUSION_VIOLATION:
      return { statusCode: 409, code: ERR_DUPLICATE, details };
    case FOREIGN_KEY_VIOLATION:
      return { statusCode: 409, code: ERR_REFERENCED, details };
    case NOT_NULL_VIOLATION:
      // `column` is the field the user left blank; it is more reliable than a
      // constraint name here because Postgres reports it directly.
      if (err.column) details.field = err.column;
      return { statusCode: 422, code: ERR_VALIDATION, details };
    case CHECK_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
    case NUMERIC_VALUE_OUT_OF_RANGE:
    case STRING_DATA_RIGHT_TRUNCATION:
      return { statusCode: 422, code: ERR_VALIDATION, details };
    case INSUFFICIENT_PRIVILEGE:
      // Includes an RLS policy refusing the row. A caller reaching a row they
      // are not scoped to is a 403, not a server fault — and must never come
      // back describing a policy or a table.
      return { statusCode: 403, code: ERR_FORBIDDEN, details: {} };
    default:
      return null;
  }
}

/**
 * The `message` served for a mapped database error. Deliberately terse and
 * NOT the driver's text: `ApiErrorShape.message` is a developer-facing
 * fallback (CONTRACTS §0) that the frontend must not print, but it still
 * travels over the wire to any caller, so it carries the SQLSTATE and nothing
 * about our schema. The original error, with its full text, is logged by the
 * filter.
 */
export function pgErrorMessage(err: PgErrorLike): string {
  return `Database constraint violation (SQLSTATE ${err.code})`;
}
