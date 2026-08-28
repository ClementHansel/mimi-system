/**
 * Export (and round-trip import) columns for the `salary_components` master
 * list — `SalaryComponentsPanel`'s own file, deliberately NOT folded into
 * `./io-columns.ts` (another agent owns that file this round).
 *
 * `code,name,type,calc_method,default_amount`, in that exact order, mirrors
 * the bulk importer's `salary_components` entity header-for-header
 * (`apps/backend/src/modules/import/import-schema.ts`) — same convention as
 * `employeeIoColumns`/`workShiftIoColumns` in `./io-columns.ts`: the
 * realistic bulk edit is "export what exists, fix it in a spreadsheet,
 * import it back", which only works if an exported file is a valid import
 * file. The importer upserts on `code` (the natural key), so a round trip
 * updates rather than duplicating.
 *
 * `default_amount` stays a verbatim decimal STRING (CONTRACTS §0) — never
 * `Number()`, never `Rp`-prefixed, never thousands-grouped. `CsvColumn`'s
 * `cellText` already turns `null`/`undefined` into an empty cell, never the
 * literal text "null"/"undefined", so a component with no default amount
 * exports as a blank `default_amount` cell — exactly what the importer's own
 * `default_amount` column treats as "not set" (it is the one optional column
 * on this entity).
 */
import type { CsvColumn } from '@/lib/export/csv';
import type { PayrollComponent } from './types';

export const SALARY_COMPONENT_IO_COLUMNS: CsvColumn<PayrollComponent>[] = [
  { key: 'code', header: 'code' },
  { key: 'name', header: 'name' },
  { key: 'type', header: 'type' },
  { key: 'calcMethod', header: 'calc_method' },
  { key: 'defaultAmount', header: 'default_amount', format: (r) => r.defaultAmount ?? '' },
];
