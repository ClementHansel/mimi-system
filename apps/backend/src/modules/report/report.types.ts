import type { RoleKey } from '@mimi/shared';

/** Same shape every other Wave 4 read module builds from `RequestWithDbContext` (see `inventory.service.ts`'s `CallerContext`). */
export interface ReportCallerContext {
  userId: string;
  roleKey: RoleKey;
  /** `RlsContextGuard`'s resolved scope — `null` = central role, unrestricted. */
  locationScope: readonly string[] | null;
}

/**
 * `node-pg` parses `TIMESTAMPTZ` columns into a JS `Date` (there is no
 * global `types.setTypeParser` override anywhere in this backend, confirmed
 * by grep), not a string, despite every report row here being typed
 * `ISODateTime`/`string` for the query-result generic. `res.json()` would
 * silently paper over that (a `Date` serializes to an ISO string through
 * `JSON.stringify`'s own `toJSON()` call) — but the csv writer does not go
 * through `JSON.stringify`, so a `Date` reaching `writeCsv` would render via
 * its own `toString()` (a locale-formatted string, NOT ISO) instead.
 * Normalizing every timestamp field through this helper, once, at the
 * service boundary, keeps json and csv identical rather than csv silently
 * diverging.
 */
export function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
