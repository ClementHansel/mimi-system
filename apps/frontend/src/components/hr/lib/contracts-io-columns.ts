/**
 * Export (and round-trip import) columns for `employment_contracts` — mirrors
 * `apps/backend/src/modules/import/import-schema.ts`'s entity of the same
 * name header-for-header, same convention `components/hr/lib/io-columns.ts`
 * already documents for `employees`/`work_shifts`: the realistic bulk edit is
 * "export what exists, fix it in a spreadsheet, import it back", and that
 * only works if an exported file is a valid import file.
 *
 * NO `status` COLUMN AND NO SIGNATURE COLUMN — deliberately, matching the
 * importer exactly. Exporting `status`/`employeeSigned`/`companySignerCount`
 * as a REPORT column would be reasonable on its own, but putting them in
 * these SAME `CsvColumn`s (the ones `MasterDataIo` also feeds to the
 * importer) would mean a re-imported file carries a `status`/signature
 * column the importer's header check would then reject as "unknown column" —
 * or worse, if the importer ever silently accepted it, would be exactly the
 * forged-signature/forged-activation path §3 of the W7 follow-up ticket
 * rules out. `ContractsPanel`'s on-screen table shows both; this file's
 * columns only ever carry what the importer also accepts.
 */
import type { CsvColumn } from '@/lib/export/csv';
import type { Contract } from './types';

/** A contract row enriched with the two importer columns the list endpoint carries under different keys — see `contractIoColumns` below. */
export interface ContractExportRow extends Contract {
  employeeNumber: string;
}

/**
 * A FACTORY, not a plain array — the importer's `location` column is a
 * location CODE and `Contract` only carries `locationId`/`locationName` on
 * the wire, same reasoning `employeeIoColumns` (`io-columns.ts`) already
 * gives for the identical shape. An id absent from the map exports a blank
 * cell rather than guessing.
 */
export function contractIoColumns(
  locationCodeById: Map<string, string>,
): CsvColumn<ContractExportRow>[] {
  return [
    { key: 'contractNumber', header: 'contract_number' },
    { key: 'employeeNumber', header: 'employee' },
    { key: 'contractType', header: 'contract_type' },
    { key: 'position', header: 'position' },
    {
      key: 'locationId',
      header: 'location',
      format: (r) => (r.locationId ? (locationCodeById.get(r.locationId) ?? '') : ''),
    },
    { key: 'baseSalary', header: 'base_salary', format: (r) => r.baseSalary ?? '' },
    { key: 'startDate', header: 'start_date' },
    { key: 'endDate', header: 'end_date', format: (r) => r.endDate ?? '' },
    { key: 'signedAt', header: 'signed_at', format: (r) => r.signedAt ?? '' },
    { key: 'notes', header: 'notes', format: (r) => r.notes ?? '' },
  ];
}
