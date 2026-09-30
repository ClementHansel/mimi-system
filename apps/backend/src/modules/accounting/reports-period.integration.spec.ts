import { describe, it, expect, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { ReportsService } from './reports.service';

/**
 * Trial balance and balance sheet must respect the period / as-of date.
 *
 * Both used to put the filter on a LEFT JOIN to journal_entries while SUM ran
 * over every journal_line, matched or not, so every period returned the
 * all-time totals. The balance sheet also never carried the profit that sits
 * in the revenue/expense accounts (nothing closes them into 3100), so it read
 * "Tidak Seimbang" the moment a sale was posted. Found when the client's April
 * 2026 data went in: March and April trial balances were identical, and the
 * balance sheet was short by exactly the April net profit.
 *
 * Entries are planted in 2099 inside a transaction that is always rolled back.
 */
const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;
const pool = new Pool({ connectionString: OWNER_URL, max: 2 });

async function withOwnerRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

async function post(
  c: PoolClient,
  period: string,
  date: string,
  amount: number,
  n: number,
): Promise<void> {
  const fp = (
    await c.query<{ id: string }>(
      `INSERT INTO fiscal_periods (period_code, start_date, end_date, status)
       VALUES ($1, date_trunc('month', $2::date), (date_trunc('month', $2::date) + interval '1 month - 1 day')::date, 'open')
       ON CONFLICT (period_code) DO UPDATE SET period_code = EXCLUDED.period_code RETURNING id`,
      [period, date],
    )
  ).rows[0]!.id;
  const je = (
    await c.query<{ id: string }>(
      `INSERT INTO journal_entries (entry_number, entry_date, fiscal_period_id, source, description, status)
       VALUES ($1, $2, $3, 'manual', 'ZZTEST period filter', 'posted') RETURNING id`,
      [`ZZTEST/${period}/${n}`, date, fp],
    )
  ).rows[0]!.id;
  await c.query(
    `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
     SELECT $1::uuid, 1, id, $2::numeric, 0 FROM chart_of_accounts WHERE code = '1000'
     UNION ALL
     SELECT $1::uuid, 2, id, 0, $2::numeric FROM chart_of_accounts WHERE code = '4000'`,
    [je, amount],
  );
}

const line = (
  rows: { accountCode: string; amount?: string; debit?: string; credit?: string }[],
  code: string,
) => rows.find((r) => r.accountCode === code);

describe('Accounting reports honour the period (integration, live Postgres)', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('trial balance for a period sums only that period, and the balance sheet cuts off at asOf and balances', async () => {
    const reports = new ReportsService();
    const result = await withOwnerRollback(async (c) => {
      await post(c, '2099-01', '2099-01-15', 100, 1);
      await post(c, '2099-02', '2099-02-15', 50, 2);
      const tb = await reports.trialBalance(c, '2099-01');
      const bsBefore = await reports.balanceSheet(c, '2098-12-31');
      const bsJan = await reports.balanceSheet(c, '2099-01-31');
      return { tb, bsBefore, bsJan };
    });

    // only January's entry, nothing from February or from any real data
    expect(result.tb.rows.map((r) => [r.accountCode, r.debit, r.credit])).toEqual([
      ['1000', '100.00', '0.00'],
      ['4000', '0.00', '100.00'],
    ]);

    const cash = (bs: typeof result.bsJan) => Number(line(bs.assets, '1000')?.amount ?? 0);
    expect(cash(result.bsJan) - cash(result.bsBefore)).toBe(100); // not 150: February is after asOf
    expect(result.bsJan.balanced).toBe(true);
    expect(result.bsBefore.balanced).toBe(true);
  }, 30_000);
});
