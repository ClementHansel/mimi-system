/**
 * `pg` parses a Postgres `DATE` column into a JS `Date` at LOCAL midnight —
 * see `modules/hr/pg-date.util.ts`'s doc comment for the full rationale (this
 * app pins `process.env.TZ = 'Asia/Makassar'`, D-11). A UTC-based formatter
 * would shift the calendar date backward by one day. Duplicated here (rather
 * than importing HR's copy) to keep `modules/asset/**` self-contained per
 * this ticket's file-ownership boundary.
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

export function pgDateToIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return pgDateToIso(value);
}
