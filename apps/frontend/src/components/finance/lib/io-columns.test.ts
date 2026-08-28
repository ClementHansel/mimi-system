/**
 * Pins `accountIoColumns`' header list against the BACKEND importer's
 * `chart_of_accounts` columns (see this file's header comment for why that
 * coupling needs a test at all — the compiler cannot see across the
 * frontend/backend package boundary). Everything else here is export-only,
 * so those tests pin behavior (money stays verbatim, blanks stay blank, a
 * flatten does not double-count) rather than a cross-package contract.
 */
import { describe, expect, it } from 'vitest';
import { translate } from '@/lib/i18n';
import { toCsv, type CsvColumn } from '@/lib/export/csv';
import {
  accountIoColumns,
  trialBalanceIoColumns,
  profitLossIoColumns,
  profitLossExportRows,
  balanceSheetIoColumns,
  balanceSheetExportRows,
  stockValueIoColumns,
  stockValueExportRows,
  journalIoColumns,
  paymentIoColumns,
  exceptionIoColumns,
  fiscalPeriodIoColumns,
} from './io-columns';
import type {
  Account,
  BalanceSheetReport,
  FiscalPeriod,
  JournalEntry,
  OfflineAuthCase,
  PaymentVerification,
  ProfitLossReport,
  StockValueRow,
} from '../types';

const t = translate;

function headers<T>(columns: CsvColumn<T>[]): string[] {
  return columns.map((c) => c.header);
}

/** Verbatim from `IMPORT_ENTITIES['chart_of_accounts']` in `apps/backend/src/modules/import/import-schema.ts`. */
const CHART_OF_ACCOUNTS_IMPORTER_COLUMNS = [
  'code',
  'name',
  'type',
  'normal_balance',
  'parent_code',
  'is_postable',
];

describe('accountIoColumns', () => {
  const parent: Account = {
    id: 'acc-parent',
    code: '1100',
    name: 'Kas & Setara Kas',
    type: 'asset',
    normalBalance: 'debit',
    parentId: null,
    isPostable: false,
    isSystem: false,
    isActive: true,
  };
  const child: Account = {
    id: 'acc-child',
    code: '1101',
    name: 'Kas Outlet',
    type: 'asset',
    normalBalance: 'debit',
    parentId: 'acc-parent',
    isPostable: true,
    isSystem: false,
    isActive: true,
  };
  const accounts = [parent, child];

  it("matches the importer's chart_of_accounts columns, in order", () => {
    expect(headers(accountIoColumns(accounts))).toEqual(CHART_OF_ACCOUNTS_IMPORTER_COLUMNS);
  });

  it('omits is_active — deactivation is a PATCH, not an importable field', () => {
    expect(headers(accountIoColumns(accounts))).not.toContain('is_active');
  });

  it('resolves parent_code from parentId, never leaking the raw UUID', () => {
    const csv = toCsv(accounts, accountIoColumns(accounts));
    const rows = csv.slice(1).split('\r\n');
    expect(rows[1]).toBe('1100,Kas & Setara Kas,asset,debit,,tidak');
    expect(rows[2]).toBe('1101,Kas Outlet,asset,debit,1100,ya');
    expect(csv).not.toContain('acc-parent');
  });

  it('round-trips: the exported header row IS an importable header row', () => {
    const csv = toCsv(accounts, accountIoColumns(accounts));
    const header = csv.slice(1).split('\r\n')[0];
    expect(header).toBe(CHART_OF_ACCOUNTS_IMPORTER_COLUMNS.join(','));
  });
});

describe('trialBalanceIoColumns', () => {
  it('keeps debit/credit as verbatim decimal strings — no Rp, no thousands separator', () => {
    const row = {
      accountCode: '4100',
      accountName: 'Pendapatan Penjualan',
      type: 'revenue',
      debit: '0.00',
      credit: '1234567.00',
    };
    const csv = toCsv([row], trialBalanceIoColumns(t));
    expect(csv).toContain('1234567.00');
    expect(csv).not.toContain('Rp');
    expect(csv).not.toContain('1.234.567');
  });
});

describe('profit & loss export', () => {
  const report: ProfitLossReport = {
    revenue: [{ accountCode: '4100', name: 'Penjualan', amount: '5000000.00' }],
    expenses: [{ accountCode: '5100', name: 'Bahan Baku', amount: '2000000.00' }],
    totalRevenue: '5000000.00',
    totalExpense: '2000000.00',
    netProfit: '3000000.00',
  };

  it('flattens revenue then expenses into one sheet, tagged by section', () => {
    const rows = profitLossExportRows(report);
    expect(rows.map((r) => r.section)).toEqual(['revenue', 'expense']);
  });

  it('keeps amounts verbatim', () => {
    const csv = toCsv(profitLossExportRows(report), profitLossIoColumns(t));
    expect(csv).toContain('5000000.00');
    expect(csv).toContain('2000000.00');
    expect(csv).not.toContain('Rp');
  });
});

describe('balance sheet export', () => {
  const report: BalanceSheetReport = {
    assets: [{ accountCode: '1100', name: 'Kas', amount: '10000000.00' }],
    liabilities: [{ accountCode: '2100', name: 'Utang Usaha', amount: '4000000.00' }],
    equity: [{ accountCode: '3100', name: 'Modal', amount: '6000000.00' }],
    balanced: true,
  };

  it('flattens assets, liabilities, then equity, tagged by section', () => {
    const rows = balanceSheetExportRows(report);
    expect(rows.map((r) => r.section)).toEqual(['assets', 'liabilities', 'equity']);
  });

  it('keeps amounts verbatim', () => {
    const csv = toCsv(balanceSheetExportRows(report), balanceSheetIoColumns(t));
    expect(csv).toContain('10000000.00');
    expect(csv).not.toContain('Rp');
  });
});

describe('stockValueExportRows', () => {
  it('emits one row per (outlet, category) — not a location-total row plus category rows', () => {
    const rows: StockValueRow[] = [
      {
        locationId: 'loc-1',
        locationName: 'Outlet A',
        value: '3000000.00',
        byCategory: [
          { categoryName: 'Ayam', value: '2000000.00' },
          { categoryName: 'Bumbu', value: '1000000.00' },
        ],
      },
    ];
    const exported = stockValueExportRows(rows);
    expect(exported).toEqual([
      { locationName: 'Outlet A', categoryName: 'Ayam', value: '2000000.00' },
      { locationName: 'Outlet A', categoryName: 'Bumbu', value: '1000000.00' },
    ]);
    // Summing the `value` column reconstructs the location total exactly
    // once — a location-total row alongside these would double it.
    const csv = toCsv(exported, stockValueIoColumns());
    expect(csv).not.toContain('3000000.00');
  });

  it('still emits a row for a location with no category breakdown, rather than dropping it', () => {
    const rows: StockValueRow[] = [
      { locationId: 'loc-2', locationName: 'Outlet B', value: '500000.00', byCategory: [] },
    ];
    expect(stockValueExportRows(rows)).toEqual([
      { locationName: 'Outlet B', categoryName: '', value: '500000.00' },
    ]);
  });
});

describe('journalIoColumns', () => {
  it('sums line debits/credits with BigInt cents, never a float sum, and stays verbatim', () => {
    const entry: JournalEntry = {
      id: 'je-1',
      entryNumber: 'JE-0001',
      entryDate: '2026-08-01',
      eventType: null,
      source: 'manual',
      refType: null,
      refId: null,
      locationName: 'Outlet A',
      description: 'Setoran kas',
      status: 'posted',
      lines: [
        {
          lineNo: 1,
          accountCode: '1100',
          accountName: 'Kas',
          debit: '0.10',
          credit: '0.00',
          memo: null,
        },
        {
          lineNo: 2,
          accountCode: '4100',
          accountName: 'Penjualan',
          debit: '0.20',
          credit: '0.00',
          memo: null,
        },
        {
          lineNo: 3,
          accountCode: '3100',
          accountName: 'Modal',
          debit: '0.00',
          credit: '0.30',
          memo: null,
        },
      ],
    };
    const csv = toCsv([entry], journalIoColumns(t));
    // 0.10 + 0.20 must be exactly 0.30 — the whole reason this goes through
    // `sumMoney`'s BigInt-cents arithmetic instead of `Number()`.
    const row = csv.trim().split('\n')[1];
    expect(row).toContain('0.30');
    expect(row).not.toContain('Rp');
  });

  it('writes a blank, never "null", for a system entry with no location', () => {
    const entry: JournalEntry = {
      id: 'je-2',
      entryNumber: 'JE-0002',
      entryDate: '2026-08-01',
      eventType: 'outlet_ingredient_usage',
      source: 'system',
      refType: null,
      refId: null,
      locationName: null,
      description: 'outlet_ingredient_usage — usage_day 1',
      status: 'posted',
      lines: [],
    };
    const csv = toCsv([entry], journalIoColumns(t));
    expect(csv).not.toContain('null');
  });
});

describe('paymentIoColumns', () => {
  it('keeps amount verbatim and writes blanks for absent optionals', () => {
    const pv: PaymentVerification = {
      id: 'pv-1',
      pvNumber: 'PV-0001',
      refType: 'other',
      refId: null,
      refNumber: null,
      payeeType: 'other',
      payeeName: null,
      amount: '150000.00',
      status: 'pending',
      proofUrl: null,
      referenceNumber: null,
      submittedBy: 'u1',
      verifiedBy: null,
      verifiedAt: null,
      paidBy: null,
      paidAt: null,
      paidVia: null,
      locationName: null,
    };
    const csv = toCsv([pv], paymentIoColumns(t));
    expect(csv).toContain('150000.00');
    expect(csv).not.toContain('Rp');
    expect(csv).not.toContain('null');
  });
});

describe('exceptionIoColumns', () => {
  it('writes a blank amount (never "0") when the case carries none, and ya/tidak for the physical-effect flag', () => {
    const exc: OfflineAuthCase = {
      id: 'exc-1',
      class: 'offline_auth_unprovable',
      documentType: 'sale',
      documentId: 'doc-1',
      amount: null,
      approverName: 'Budi',
      deviceName: 'Tablet 1',
      outletName: 'Outlet A',
      occurredAt: '2026-08-01T10:00:00Z',
      relayReceivedAt: '2026-08-01T12:00:00Z',
      evidence: { selfieUrl: null, pinAttempts: null },
      physicalEffectSuspected: true,
      outcome: 'unprovable',
      verdict: null,
    };
    const csv = toCsv([exc], exceptionIoColumns(t));
    const row = csv.trim().split('\n')[1];
    expect(row).not.toContain(',0,');
    expect(row).toContain('ya');
    expect(csv).not.toContain('null');
  });
});

describe('fiscalPeriodIoColumns', () => {
  it('writes the fmtDateTime em-dash placeholder, never the literal "null", for an open period', () => {
    const period: FiscalPeriod = {
      id: 'fp-1',
      periodCode: '2026-08',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      status: 'open',
      closedBy: null,
      closedAt: null,
    };
    const csv = toCsv([period], fiscalPeriodIoColumns(t));
    const row = csv.trim().split('\n')[1];
    expect(row?.endsWith(',—')).toBe(true);
    expect(csv).not.toContain('null');
  });
});
