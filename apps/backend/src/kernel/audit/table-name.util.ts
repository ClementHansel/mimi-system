/**
 * Best-effort mapping from `@Audited({ entityType })` (a human entity name,
 * e.g. `'replenishment_request'`) to the Postgres table it is stored in
 * (e.g. `replenishment_requests`) — used ONLY to fetch a "before" snapshot
 * for the diff; never used for the "after" snapshot (that comes from the
 * handler's own response body — see `audit.interceptor.ts`).
 *
 * `entityType` and the real table name usually differ only by English
 * pluralization (CONTRACTS.md's own `@Audited()` example uses the singular
 * `'replenishment_request'` for a row that lives in `replenishment_requests`),
 * but a few CONTRACTS.md tables are irregular (`stock_opname` is NOT
 * pluralized; `settings` is a keyed config table, not really "auditable" by
 * id). Rather than hand-maintain an exhaustive map that Wave 3/4 modules
 * would have to remember to keep in sync (which is exactly the per-module
 * coupling D-09 exists to avoid), this tries the entityType literally FIRST
 * (covers irregular/singular tables), then a naive pluralization. Whichever
 * relation actually exists in the DB wins; if neither does, the caller
 * degrades to `before = null` rather than failing the request — a "before"
 * diff is a nice-to-have enrichment, never a gate on the mutation itself.
 */
export function candidateTableNames(entityType: string): string[] {
  const candidates: string[] = [entityType];

  let plural: string;
  if (entityType.endsWith('s')) {
    plural = entityType; // already looks plural — no second candidate needed
  } else if (/[^aeiou]y$/i.test(entityType)) {
    plural = entityType.slice(0, -1) + 'ies';
  } else if (/(x|z|ch|sh)$/i.test(entityType)) {
    plural = entityType + 'es';
  } else {
    plural = entityType + 's';
  }

  if (!candidates.includes(plural)) candidates.push(plural);
  return candidates;
}
