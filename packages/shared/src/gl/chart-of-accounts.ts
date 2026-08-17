/**
 * Seed chart of accounts — CONTRACTS.md §6.1, transcribed verbatim as data.
 * `is_system = true` for every row here; W1-C seeds these exact codes. Adding
 * an account beyond this list is a normal accounting operation (M17,
 * `accounting.coa.manage`) — this module only fixes the codes the posting
 * rules (`./posting-rules`) depend on being present.
 */
import { AccountType, NormalBalance } from '../enums';

export interface ChartOfAccountsSeed {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
}

export const CHART_OF_ACCOUNTS_SEED: readonly ChartOfAccountsSeed[] = [
  { code: '1000', name: 'Kas Outlet', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1010', name: 'Kas Kecil (Petty Cash)', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1020', name: 'Bank', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1030', name: 'Piutang Platform Online', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1031', name: 'Piutang QRIS', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1032', name: 'Piutang Transfer', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1100', name: 'Persediaan Gudang', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1110', name: 'Persediaan Outlet', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1120', name: 'Persediaan Dalam Perjalanan', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1210', name: 'Piutang Karyawan (Kasbon)', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1220', name: 'Piutang Klaim Karyawan', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '1500', name: 'Aset Tetap', type: AccountType.ASSET, normalBalance: NormalBalance.DEBIT },
  { code: '2000', name: 'Hutang Supplier', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { code: '2100', name: 'Hutang Gaji', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { code: '2110', name: 'Hutang BPJS', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { code: '2120', name: 'Hutang PPh21', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { code: '2200', name: 'Hutang Lainnya', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { code: '3000', name: 'Modal', type: AccountType.EQUITY, normalBalance: NormalBalance.CREDIT },
  { code: '3100', name: 'Laba Ditahan', type: AccountType.EQUITY, normalBalance: NormalBalance.CREDIT },
  { code: '4000', name: 'Pendapatan Penjualan', type: AccountType.REVENUE, normalBalance: NormalBalance.CREDIT },
  { code: '4100', name: 'Pendapatan Lainnya', type: AccountType.REVENUE, normalBalance: NormalBalance.CREDIT },
  { code: '5000', name: 'Beban Pokok Penjualan (HPP)', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '5090', name: 'Penyesuaian Nilai Persediaan', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '5100', name: 'Beban Waste/Rusak/Expired', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6000', name: 'Beban Gaji', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6010', name: 'Beban BPJS (Perusahaan)', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6100', name: 'Beban Operasional Outlet', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6200', name: 'Beban Maintenance', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6300', name: 'Beban Komisi Platform', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
  { code: '6400', name: 'Beban Selisih Stok', type: AccountType.EXPENSE, normalBalance: NormalBalance.DEBIT },
];

export const CHART_OF_ACCOUNTS_BY_CODE: ReadonlyMap<string, ChartOfAccountsSeed> = new Map(
  CHART_OF_ACCOUNTS_SEED.map((a) => [a.code, a]),
);

export function isKnownAccountCode(code: string): boolean {
  return CHART_OF_ACCOUNTS_BY_CODE.has(code);
}
