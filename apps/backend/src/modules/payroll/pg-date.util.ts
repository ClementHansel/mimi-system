/**
 * `pg` parses a Postgres `DATE` column into a JS `Date` at LOCAL midnight —
 * see `modules/hr/pg-date.util.ts`'s header for the full explanation (this
 * module keeps its own copy rather than importing across module boundaries,
 * matching the repo's existing per-module convention).
 */
export function pgDateToIso(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return value as string;
}
