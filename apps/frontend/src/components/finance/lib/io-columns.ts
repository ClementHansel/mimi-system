/**
 * Export (and, for one entity, import) columns for F07 finance's six tabs.
 *
 * ONE ENTITY HERE ROUND-TRIPS: `accountIoColumns` mirrors the bulk importer's
 * `chart_of_accounts` entity header-for-header
 * (`apps/backend/src/modules/import/import-schema.ts`), the same convention
 * `components/admin/lib/io-columns.ts` and
 * `components/purchasing/lib/io-columns.ts` use — "export what exists, fix it
 * in a spreadsheet, import it back" only works if the exported file is a
 * valid import file, and the importer upserts on `code` so a round trip
 * updates rather than duplicating. `io-columns.test.ts` pins that header list
 * against the same literals since the coupling crosses a package boundary the
 * compiler cannot check.
 *
 * `is_active` is deliberately absent from `accountIoColumns` even though the
 * table shows it: deactivating an account is a `PATCH .../isActive`
 * (`ChartOfAccountsPanel`'s edit modal), not a field the importer accepts —
 * exporting it would turn a round trip into a silent data-loss step the next
 * time someone re-imports the file.
 *
 * EVERYTHING ELSE HERE IS EXPORT-ONLY, and deliberately so — see each
 * function's comment for why import would be actively wrong for that tab
 * (double-entry, fiscal-period locks, the append-only exception queue).
 *
 * Money stays a VERBATIM decimal string (CONTRACTS §0): no `Rp`, no
 * thousands separator, never `Number()`. The trial-balance columns used to
 * run debit/credit through `formatMoney`, which prints `Rp1.234.567` — fixed
 * here while this file was being written, since a spreadsheet cannot total a
 * column that has a currency symbol and thousands dots baked into the string.
 * Timestamps go through `fmtDate`/`fmtDateTime` so they read in WITA (D-11).
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import { sumMoney } from './money';
import type {
  Account,
  BalanceSheetReport,
  FiscalPeriod,
  JournalEntry,
  OfflineAuthCase,
  PaymentVerification,
  PLLine,
  ProfitLossReport,
  StockValueRow,
  TrialBalanceReport,
} from '../types';

type TrialBalanceRow = TrialBalanceReport['rows'][number];
type T = (key: string, params?: Record<string, string | number>) => string;

/** How the importer's `boolean` kind wants a value written (`ya`/`tidak`). */
function bool(value: boolean): string {
  return value ? 'ya' : 'tidak';
}

/** `Money | null` -> the decimal string, or blank. Never the literal `"null"`. */
function dec(value: string | null | undefined): string {
  return value ?? '';
}

/**
 * `chart_of_accounts` — `code,name,type,normal_balance,parent_code,is_postable`.
 *
 * `parent_code` is the one column that cannot be read straight off an
 * `Account` (the wire shape only carries `parentId`, a UUID the importer
 * would reject outright — it resolves `parent_code` against
 * `chart_of_accounts.code`). `ChartOfAccountsPanel` already holds the full
 * account list it is rendering, so that same list is threaded through here
 * to resolve id -> code once per export rather than once per row.
 */
export function accountIoColumns(accounts: Account[]): CsvColumn<Account>[] {
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  return [
    { key: 'code', header: 'code' },
    { key: 'name', header: 'name' },
    { key: 'type', header: 'type' },
    { key: 'normalBalance', header: 'normal_balance' },
    {
      key: 'parentId',
      header: 'parent_code',
      format: (r) => (r.parentId ? (codeById.get(r.parentId) ?? '') : ''),
    },
    { key: 'isPostable', header: 'is_postable', format: (r) => bool(r.isPostable) },
  ];
}

/** `Laporan` / Neraca Saldo (trial balance) — one row per account in the period. */
export function trialBalanceIoColumns(t: T): CsvColumn<TrialBalanceRow>[] {
  return [
    { key: 'accountCode', header: 'Kode Akun' },
    { key: 'accountName', header: 'Nama Akun' },
    { key: 'type', header: 'Tipe Akun', format: (r) => t(`finance.accountType.${r.type}`) },
    { key: 'debit', header: 'Debit' },
    { key: 'credit', header: 'Kredit' },
  ];
}

/** A P&L or balance-sheet line, tagged with which section it came from. */
export interface SectionedLine extends PLLine {
  section: string;
}

/**
 * `Laporan` / Laba Rugi (profit & loss) — `revenue` and `expenses` flattened
 * into one sheet with a `Bagian` column, rather than two separate exports:
 * the report is one document on screen (with a net-profit figure that only
 * makes sense read against both halves), so the export stays one document too.
 */
export function profitLossIoColumns(t: T): CsvColumn<SectionedLine>[] {
  return [
    {
      key: 'section',
      header: 'Bagian',
      format: (r) =>
        t(r.section === 'revenue' ? 'finance.reports.revenue' : 'finance.reports.expenses'),
    },
    { key: 'accountCode', header: 'Kode Akun' },
    { key: 'name', header: 'Nama Akun' },
    { key: 'amount', header: 'Jumlah' },
  ];
}

export function profitLossExportRows(report: ProfitLossReport): SectionedLine[] {
  return [
    ...report.revenue.map((l) => ({ ...l, section: 'revenue' })),
    ...report.expenses.map((l) => ({ ...l, section: 'expense' })),
  ];
}

/** `Laporan` / Neraca (balance sheet) — assets/liabilities/equity, same flattening reasoning as P&L above. */
export function balanceSheetIoColumns(t: T): CsvColumn<SectionedLine>[] {
  return [
    {
      key: 'section',
      header: 'Bagian',
      format: (r) =>
        t(
          r.section === 'assets'
            ? 'finance.reports.assets'
            : r.section === 'liabilities'
              ? 'finance.reports.liabilities'
              : 'finance.reports.equity',
        ),
    },
    { key: 'accountCode', header: 'Kode Akun' },
    { key: 'name', header: 'Nama Akun' },
    { key: 'amount', header: 'Jumlah' },
  ];
}

export function balanceSheetExportRows(report: BalanceSheetReport): SectionedLine[] {
  return [
    ...report.assets.map((l) => ({ ...l, section: 'assets' })),
    ...report.liabilities.map((l) => ({ ...l, section: 'liabilities' })),
    ...report.equity.map((l) => ({ ...l, section: 'equity' })),
  ];
}

/** One (outlet, category) pair from the stock-value report. */
export interface StockValueExportRow {
  locationName: string;
  categoryName: string;
  value: string;
}

export function stockValueIoColumns(): CsvColumn<StockValueExportRow>[] {
  return [
    { key: 'locationName', header: 'Outlet' },
    { key: 'categoryName', header: 'Kategori' },
    { key: 'value', header: 'Nilai' },
  ];
}

/**
 * Flattened one row per (outlet, category) — NOT one row per outlet plus one
 * row per category, which is the classic double-count trap (see
 * `outlet-export-columns.ts`'s header comment): summing the `value` column
 * naively would then count every outlet's total twice. A location with no
 * category breakdown still gets one row (category blank) so its value is not
 * silently dropped from the sheet.
 */
export function stockValueExportRows(rows: StockValueRow[]): StockValueExportRow[] {
  return rows.flatMap((r) =>
    r.byCategory.length > 0
      ? r.byCategory.map((c) => ({
          locationName: r.locationName,
          categoryName: c.categoryName,
          value: c.value,
        }))
      : [{ locationName: r.locationName, categoryName: '', value: r.value }],
  );
}

/**
 * `Jurnal` — journal entries. EXPORT ONLY: importing journal entries would
 * let a CSV row post a debit/credit pair that skips the balance check, the
 * fiscal-period lock, and everything else `POST /accounting/journal` enforces
 * server-side — there is no "bulk edit the ledger" workflow that is ever safe.
 *
 * `Total Debit`/`Total Kredit` are computed from `r.lines` with `sumMoney`
 * (`BigInt` cents, never a float sum) rather than read off a pre-aggregated
 * field — the list endpoint returns each entry's full line set, so the totals
 * here are exact, not estimated.
 */
export function journalIoColumns(t: T): CsvColumn<JournalEntry>[] {
  return [
    { key: 'entryNumber', header: 'No. Jurnal' },
    { key: 'entryDate', header: 'Tanggal', format: (r) => fmtDate(r.entryDate) },
    { key: 'description', header: 'Deskripsi' },
    {
      key: 'source',
      header: 'Sumber',
      format: (r) =>
        t(r.source === 'manual' ? 'finance.journal.sourceManual' : 'finance.journal.sourceSystem'),
    },
    { key: 'status', header: 'Status', format: (r) => t(`status.journalEntry.${r.status}`) },
    { key: 'locationName', header: 'Lokasi', format: (r) => r.locationName ?? '' },
    { key: 'lines', header: 'Total Debit', format: (r) => sumMoney(r.lines.map((l) => l.debit)) },
    {
      key: 'lines',
      header: 'Total Kredit',
      format: (r) => sumMoney(r.lines.map((l) => l.credit)),
    },
  ];
}

/**
 * `Verifikasi Pembayaran` — payment verifications. EXPORT ONLY: the
 * pending -> verified -> paid ladder is a deliberate, permission-gated,
 * proof-carrying workflow (FR-ACCT-01..04); a bulk import could not carry a
 * proof attachment or an approver identity, so it could only ever create rows
 * stuck at `pending` or, worse, invite skipping the verification step.
 */
export function paymentIoColumns(t: T): CsvColumn<PaymentVerification>[] {
  return [
    { key: 'pvNumber', header: 'No. PV' },
    { key: 'refType', header: 'Jenis Referensi', format: (r) => t(`finance.refType.${r.refType}`) },
    {
      key: 'payeeType',
      header: 'Jenis Penerima',
      format: (r) => t(`finance.payeeType.${r.payeeType}`),
    },
    { key: 'payeeName', header: 'Penerima', format: (r) => r.payeeName ?? '' },
    { key: 'amount', header: 'Jumlah' },
    { key: 'status', header: 'Status', format: (r) => t(`status.payment.${r.status}`) },
    { key: 'locationName', header: 'Lokasi', format: (r) => r.locationName ?? '' },
    { key: 'referenceNumber', header: 'No. Referensi', format: (r) => r.referenceNumber ?? '' },
    { key: 'verifiedBy', header: 'Diverifikasi Oleh', format: (r) => r.verifiedBy ?? '' },
    { key: 'verifiedAt', header: 'Diverifikasi Pada', format: (r) => fmtDateTime(r.verifiedAt) },
    { key: 'paidBy', header: 'Dibayar Oleh', format: (r) => r.paidBy ?? '' },
    { key: 'paidAt', header: 'Dibayar Pada', format: (r) => fmtDateTime(r.paidAt) },
    { key: 'paidVia', header: 'Dibayar Via', format: (r) => r.paidVia ?? '' },
  ];
}

/**
 * `Antrean Pengecualian` — the D-17 offline-authorization exception queue.
 * EXPORT ONLY: these rows exist because something could not be re-verified
 * automatically; a CSV import into a fraud-control queue would be a way to
 * inject or dismiss cases without going through `POST .../verdict`
 * (`accounting.exceptions.service`'s reviewer/reason trail).
 */
export function exceptionIoColumns(t: T): CsvColumn<OfflineAuthCase>[] {
  return [
    {
      key: 'class',
      header: 'Kelas',
      format: (r) =>
        t(
          r.class === 'offline_auth_failed'
            ? 'finance.exceptions.classFailed'
            : 'finance.exceptions.classUnprovable',
        ),
    },
    { key: 'outcome', header: 'Hasil', format: (r) => t(`status.offlineAuthOutcome.${r.outcome}`) },
    { key: 'documentType', header: 'Jenis Dokumen' },
    { key: 'documentId', header: 'ID Dokumen' },
    { key: 'amount', header: 'Jumlah', format: (r) => dec(r.amount) },
    { key: 'approverName', header: 'Disetujui Oleh' },
    { key: 'deviceName', header: 'Perangkat' },
    { key: 'outletName', header: 'Outlet' },
    { key: 'occurredAt', header: 'Waktu Kejadian', format: (r) => fmtDateTime(r.occurredAt) },
    {
      key: 'relayReceivedAt',
      header: 'Diterima Relay Pada',
      format: (r) => fmtDateTime(r.relayReceivedAt),
    },
    {
      key: 'physicalEffectSuspected',
      header: 'Diduga Berdampak Fisik',
      format: (r) => bool(r.physicalEffectSuspected),
    },
    {
      key: 'verdict',
      header: 'Verdict',
      format: (r) => (r.verdict ? t(`finance.exceptions.verdict.${r.verdict}`) : ''),
    },
    {
      key: 'evidence',
      header: 'Percobaan PIN',
      format: (r) => r.evidence.pinAttempts ?? '',
    },
  ];
}

/**
 * `Periode Fiskal` — fiscal periods. EXPORT ONLY: opening/closing/relocking a
 * period is a guarded state transition (`POST .../close`, `.../reopen`) that
 * checks every journal entry in range, not a field a spreadsheet row could
 * set — CONTRACTS §4.17's whole point is that a closed period cannot be
 * quietly reopened by an import.
 */
export function fiscalPeriodIoColumns(t: T): CsvColumn<FiscalPeriod>[] {
  return [
    { key: 'periodCode', header: 'Kode Periode' },
    { key: 'startDate', header: 'Mulai', format: (r) => fmtDate(r.startDate) },
    { key: 'endDate', header: 'Selesai', format: (r) => fmtDate(r.endDate) },
    { key: 'status', header: 'Status', format: (r) => t(`status.fiscalPeriod.${r.status}`) },
    { key: 'closedAt', header: 'Ditutup Pada', format: (r) => fmtDateTime(r.closedAt) },
  ];
}
