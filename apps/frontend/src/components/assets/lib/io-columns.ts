/**
 * Export (and, for the register, round-trip import) columns for F09
 * `assets`'s three tabs.
 *
 * `assetIoColumns` mirrors the bulk importer's `assets` entity
 * header-for-header (`apps/backend/src/modules/import/import-schema.ts`),
 * same convention as `components/purchasing/lib/io-columns.ts` and
 * `components/hr/lib/io-columns.ts`. `io-columns.test.ts` pins the header
 * list against the same literals since the coupling crosses a package
 * boundary the compiler cannot see.
 *
 * TWO COLUMNS NEED A NAME→CODE LOOKUP THE LIST ENDPOINT DOESN'T PROVIDE.
 * `AssetDto` (`apps/backend/src/modules/asset/assets.service.ts`'s `map()`,
 * used for both the list AND the single-asset fetch) only ever puts
 * `locationName`/`assignedToName` on the wire — never `location_id` or
 * `assigned_to`, even though both exist in the row it reads from. The
 * importer's `location` and `assigned_to` columns need a location CODE and
 * an employee_number respectively, neither of which this module can read off
 * an `Asset`. So `assetIoColumns` is a FACTORY: the caller resolves both
 * lookups once (a `/locations` fetch and, permission allowing, a
 * `/hr/employees` fetch) and hands in name→code / name→employee_number maps.
 * A name absent from the lookup (no location/employee of that exact name,
 * or two employees sharing a name — a real possibility this join cannot
 * disambiguate) exports a BLANK cell rather than a guess: `location` is
 * required by the importer, so a blank surfaces as a visible "unrecognized"
 * row in the import preview; `assigned_to` is optional, so a blank just
 * drops the PIC assignment silently, which is the safe direction to fail in
 * for a field nobody is required to fill in. Getting this right for every
 * case would need `AssetDto` to carry `locationId`/`assignedToEmployeeId` —
 * flagged for the architect, not worked around by guessing here.
 *
 * `MAINTENANCE_DUE_EXPORT_COLUMNS`/`MAINTENANCE_JOB_EXPORT_COLUMNS` are
 * REPORTS, not round-trip files (same reasoning as
 * `components/outlet/lib/outlet-export-columns.ts`): due reminders are
 * scheduler-derived, and a job's own proof-photo/verify workflow
 * (FR-PMS-02/04) is exactly what a bulk importer would bypass, so neither is
 * an import-schema entity and neither gets import wiring here.
 *
 * Money stays a verbatim decimal string (CONTRACTS §0) — `purchase_price`,
 * `cost` — no `Rp`, no thousands separator, never `Number()`.
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import type { Asset, DueItem, Job } from './types';

/**
 * `assets` — `asset_number,name,category,location,serial_number,brand,
 * model,purchase_date,purchase_price,assigned_to`.
 */
export function assetIoColumns(
  locationCodeByName: Map<string, string>,
  employeeNumberByName: Map<string, string>,
): CsvColumn<Asset>[] {
  return [
    { key: 'assetNumber', header: 'asset_number' },
    { key: 'name', header: 'name' },
    { key: 'category', header: 'category' },
    {
      key: 'locationName',
      header: 'location',
      format: (r) => locationCodeByName.get(r.locationName) ?? '',
    },
    { key: 'serialNumber', header: 'serial_number', format: (r) => r.serialNumber ?? '' },
    { key: 'brand', header: 'brand', format: (r) => r.brand ?? '' },
    { key: 'model', header: 'model', format: (r) => r.model ?? '' },
    { key: 'purchaseDate', header: 'purchase_date', format: (r) => r.purchaseDate ?? '' },
    { key: 'purchasePrice', header: 'purchase_price', format: (r) => r.purchasePrice ?? '' },
    {
      key: 'assignedToName',
      header: 'assigned_to',
      format: (r) => (r.assignedToName ? (employeeNumberByName.get(r.assignedToName) ?? '') : ''),
    },
  ];
}

/** `Jatuh Tempo` tab — due/overdue reminders. Export only, see this file's header. */
export const MAINTENANCE_DUE_EXPORT_COLUMNS: CsvColumn<DueItem>[] = [
  { key: 'assetName', header: 'aset' },
  { key: 'name', header: 'jadwal' },
  { key: 'locationName', header: 'lokasi' },
  { key: 'dueDate', header: 'jatuh_tempo', format: (r) => fmtDate(r.dueDate) },
  { key: 'overdue', header: 'terlambat', format: (r) => (r.overdue ? 'ya' : 'tidak') },
];

/** `Tugas Maintenance` tab — every job. Export only, see this file's header. */
export const MAINTENANCE_JOB_EXPORT_COLUMNS: CsvColumn<Job>[] = [
  { key: 'jobNumber', header: 'no_tugas' },
  { key: 'assetName', header: 'aset' },
  { key: 'type', header: 'jenis' },
  { key: 'status', header: 'status' },
  { key: 'dueDate', header: 'jatuh_tempo', format: (r) => (r.dueDate ? fmtDate(r.dueDate) : '') },
  { key: 'assignedToName', header: 'ditugaskan_ke', format: (r) => r.assignedToName ?? '' },
  {
    key: 'completedAt',
    header: 'selesai',
    format: (r) => (r.completedAt ? fmtDateTime(r.completedAt) : ''),
  },
  { key: 'cost', header: 'biaya', format: (r) => r.cost ?? '' },
  { key: 'proofUrls', header: 'jumlah_bukti_foto', format: (r) => r.proofUrls.length },
];
