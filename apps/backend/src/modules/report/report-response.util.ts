import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { can, ERR_FORBIDDEN, RoleKey } from '@mimi/shared';
import { writeCsv } from './csv-writer.util';
import { writeXlsx } from './xlsx-writer.util';

export type ReportFormat = 'json' | 'csv' | 'xlsx';

/**
 * CONTRACTS.md §4.19: "`format=json` needs only the row's read permission;
 * `format=csv|xlsx` additionally requires `report.export`." That is a
 * PER-REQUEST decision keyed on a query param, not a static route
 * permission — `@RequirePermission()`/`PermissionsGuard` only ever check
 * metadata fixed at decoration time, so the extra `report.export` check for
 * csv/xlsx has to run here, inside the handler, once the actual `?format=`
 * value is known. Thrown shape matches `PermissionsGuard`'s own
 * `ForbiddenException({code: ERR_FORBIDDEN, ...})` exactly, so a caller
 * cannot tell "denied by the static route guard" from "denied by this
 * per-format check" — both are the same 403 contract.
 */
export function assertExportPermission(roleKey: RoleKey, format: ReportFormat): void {
  if (format === 'json') return;
  if (!can(roleKey, 'report.export')) {
    throw new ForbiddenException({
      code: ERR_FORBIDDEN,
      message: `Role '${roleKey}' lacks permission: report.export (required for format=${format})`,
      details: { required: ['report.export'], roleKey },
    });
  }
}

export interface CsvShape<T> {
  header: readonly string[];
  toRow: (row: T) => readonly (string | number | boolean | null | undefined)[];
}

/**
 * Shared by both send functions below — csv and xlsx render the SAME rows
 * through the same `CsvShape`, so the two formats can never disagree about
 * what a report contains.
 *
 * D-22b (fixed 2026-08-23): `xlsx` used to throw 501 here on all ten report
 * endpoints, while CONTRACTS §4.19 advertised it. `xlsx-writer.util.ts` is a
 * dependency-free writer built on Node's own `zlib`; see its header for why
 * that beat adding `exceljs` for this particular job, and for the limits it
 * accepts in exchange.
 */
function sendNonJson<T>(
  res: Response,
  format: ReportFormat,
  filenameBase: string,
  rows: T[],
  csv: CsvShape<T>,
): void {
  if (format === 'xlsx') {
    const book = writeXlsx(
      csv.header,
      rows.map((r) => csv.toRow(r)),
      filenameBase,
    );
    res.status(200);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    // `res.send` on a Buffer writes it verbatim; `Content-Length` comes from
    // the Buffer's own length, so no chunked-encoding surprise for Excel.
    res.send(book);
    return;
  }
  // format === 'csv' — direct file-stream attachment (never the `{url}`-via-StorageService
  // option CONTRACTS.md also allows): keeps every export endpoint's behavior identical and
  // simple, consistent with this ticket's explicit instruction.
  const body = writeCsv(
    csv.header,
    rows.map((r) => csv.toRow(r)),
  );
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
  res.send(body);
}

/**
 * Sends a report response whose OWN json shape already IS "one row per
 * record" (sales report groups, stock-usage lines, stock-movements,
 * waste-report rows, online-orders rows) — `format=json` returns `rows`
 * itself, `format=csv` renders the SAME `rows` through `csv`.
 *
 * Requires the controller method to declare `@Res({ passthrough: false })`
 * (Nest's default) — once a handler takes a raw `Response`, Nest disables
 * its own body-sending for that route, so this function (not a `return`)
 * is what actually ends the response, for EVERY format, JSON included.
 */
export function sendReportRows<T>(
  res: Response,
  format: ReportFormat | undefined,
  filenameBase: string,
  rows: T[],
  csv: CsvShape<T>,
): void {
  const effectiveFormat: ReportFormat = format ?? 'json';
  if (effectiveFormat === 'json') {
    res.json(rows);
    return;
  }
  sendNonJson(res, effectiveFormat, filenameBase, rows, csv);
}

/**
 * Sends a report response whose json shape is a SINGLE nested object
 * (shift report, delivery-daily recap, attendance matrix, payroll register,
 * opname variance) — `format=json` returns `jsonBody` as-is; `format=csv`
 * instead renders a SEPARATE flat `csvRows` array (the same nested object
 * walked into "one row per record", since a nested object has no single
 * flat-file rendering of its own). See each controller handler for how it
 * flattens its own particular nested shape.
 */
export function sendReportObject<T>(
  res: Response,
  format: ReportFormat | undefined,
  filenameBase: string,
  jsonBody: unknown,
  csvRows: T[],
  csv: CsvShape<T>,
): void {
  const effectiveFormat: ReportFormat = format ?? 'json';
  if (effectiveFormat === 'json') {
    res.json(jsonBody);
    return;
  }
  sendNonJson(res, effectiveFormat, filenameBase, csvRows, csv);
}
