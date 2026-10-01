import { describe, it, expect, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { closePool, withOwnerRollback } from '../test-support/live-db';
import { AnomalyService } from './anomaly.service';
import { defaultThresholds, mergeThresholds, type AnomalyThresholds } from './anomaly-thresholds';
import type { AnomalyDetectorKey, AnomalyResponse } from './anomaly.types';
import {
  becomeAppUser,
  mintItem,
  mintProduct,
  mintShift,
  mintStorageArea,
  pickCleanOutlets,
  pickUser,
  plantAdjustedOpname,
  plantSale,
  plantSaleUsage,
} from './test-support/plant';

/**
 * Live-DB specs for the seven Anomali detectors.
 *
 * Every test plants its own rows inside an OWNER transaction that is rolled
 * back, in a window in 2099 so no seeded row can fall inside it, then asks the
 * real `AnomalyService` for the window. Each asserts BOTH directions: the
 * planted anomaly is flagged, and a normal control planted beside it is not.
 * The detectors then run as `app_user` under real RLS, with the same scope
 * array the controller would pass — the RBAC half.
 */
const svc = new AnomalyService();

async function run(
  client: PoolClient,
  from: string,
  to: string,
  opts: {
    scope?: string[] | null;
    locationId?: string;
    includeReviewed?: boolean;
    th?: Partial<{ [K in keyof AnomalyThresholds]: Partial<AnomalyThresholds[K]> }>;
  } = {},
): Promise<AnomalyResponse> {
  if (opts.th) {
    // Thresholds ride the real settings row, so the override is planted there (rolled back with the rest).
    const merged = mergeThresholds({
      ...defaultThresholds(),
      ...Object.fromEntries(
        Object.entries(opts.th).map(([k, v]) => [
          k,
          { ...(defaultThresholds() as unknown as Record<string, object>)[k], ...v },
        ]),
      ),
    });
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('anomaly.thresholds', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(merged)],
    );
  }
  return svc.getAnomalies(
    client,
    opts.scope === undefined ? null : opts.scope,
    from,
    to,
    opts.locationId,
    opts.includeReviewed ?? false,
  );
}

const det = (r: AnomalyResponse, key: AnomalyDetectorKey) =>
  r.detectors.find((d) => d.key === key)!;

function days(from: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

describe('Anomali detectors (integration, live Postgres)', () => {
  afterAll(async () => {
    await closePool();
  });

  // ── 1. sales_day_outlier ───────────────────────────────────────────────────

  it('sales_day_outlier flags a day at 30x the outlet median and a day under 0.3x, and nothing on the normal days', async () => {
    await withOwnerRollback(async (client) => {
      const [a, b] = await pickCleanOutlets(client, 2);
      const user = await pickUser(client);
      const p = await mintProduct(client, { price: 1000 });
      const shiftA = await mintShift(client, a!, user, '2099-06-01');
      const shiftB = await mintShift(client, b!, user, '2099-06-01');
      const normal = days('2099-06-01', 20); // 06-01 .. 06-20
      for (const [i, day] of normal.entries()) {
        // 900k..1.1M: normal wobble, never near 3x or 0.3x
        await plantSale(client, {
          location: a!,
          shift: shiftA,
          user,
          day,
          lines: [{ product: p, qty: 1000 + (i % 3) * 100, price: 1000 }],
        });
        await plantSale(client, {
          location: b!,
          shift: shiftB,
          user,
          day,
          lines: [{ product: p, qty: 1000 + (i % 4) * 50, price: 1000 }],
        });
      }
      // A: the 507M-vs-17M shape, scaled — 30M against ~1M.
      await plantSale(client, {
        location: a!,
        shift: shiftA,
        user,
        day: '2099-06-21',
        lines: [{ product: p, qty: 30_000, price: 1000 }],
      });
      // B: a day that all but vanished.
      await plantSale(client, {
        location: b!,
        shift: shiftB,
        user,
        day: '2099-06-21',
        lines: [{ product: p, qty: 100, price: 1000 }],
      });

      const r = await run(client, '2099-06-01', '2099-06-21');
      const items = det(r, 'sales_day_outlier').items.filter((i) => [a, b].includes(i.locationId!));
      expect(items.map((i) => `${i.locationId === a ? 'A' : 'B'}:${i.date}`).sort()).toEqual([
        'A:2099-06-21',
        'B:2099-06-21',
      ]);
      const high = items.find((i) => i.locationId === a)!;
      expect(high.detail.direction).toBe('high');
      expect(high.ratio).toBeGreaterThan(25);
      expect(Number(high.actual)).toBe(30_000_000);
      expect(Number(high.expected)).toBeGreaterThan(900_000);
      expect(items.find((i) => i.locationId === b)!.detail.direction).toBe('low');
    });
  });

  it('sales_day_outlier honours the configured thresholds (hi=50 lets the 30x day through)', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const p = await mintProduct(client, { price: 1000 });
      const shift = await mintShift(client, a!, user, '2099-06-01');
      for (const day of days('2099-06-01', 20)) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          lines: [{ product: p, qty: 1000, price: 1000 }],
        });
      }
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-21',
        lines: [{ product: p, qty: 30_000, price: 1000 }],
      });
      const r = await run(client, '2099-06-21', '2099-06-21', {
        th: { sales_day_outlier: { hi: 50 } },
      });
      expect(det(r, 'sales_day_outlier').items.filter((i) => i.locationId === a)).toHaveLength(0);
      const r2 = await run(client, '2099-06-21', '2099-06-21', {
        th: { sales_day_outlier: { hi: 3 } },
      });
      expect(det(r2, 'sales_day_outlier').items.filter((i) => i.locationId === a)).toHaveLength(1);
    });
  });

  it('a supervisor-scoped caller sees only their own outlet, under real RLS as app_user', async () => {
    await withOwnerRollback(async (client) => {
      const [a, b] = await pickCleanOutlets(client, 2);
      const user = await pickUser(client);
      const p = await mintProduct(client, { price: 1000 });
      for (const loc of [a!, b!]) {
        const shift = await mintShift(client, loc, user, '2099-06-01');
        for (const day of days('2099-06-01', 20)) {
          await plantSale(client, {
            location: loc,
            shift,
            user,
            day,
            lines: [{ product: p, qty: 1000, price: 1000 }],
          });
        }
        await plantSale(client, {
          location: loc,
          shift,
          user,
          day: '2099-06-21',
          lines: [{ product: p, qty: 30_000, price: 1000 }],
        });
      }
      // The owner sees both outlets' spikes...
      const asOwner = await run(client, '2099-06-01', '2099-06-21');
      const ownerIds = det(asOwner, 'sales_day_outlier').items.map((i) => i.locationId);
      expect(ownerIds).toContain(a);
      expect(ownerIds).toContain(b);

      // ...a branch-scoped manager, running as app_user with RLS on, sees only their own.
      await becomeAppUser(client, { role: 'manager', userId: user, locationIds: [a!] });
      const scoped = await run(client, '2099-06-01', '2099-06-21', { scope: [a!] });
      const scopedIds = det(scoped, 'sales_day_outlier').items.map((i) => i.locationId);
      expect(scopedIds).toContain(a);
      expect(scopedIds).not.toContain(b);
      // And may not ask for another outlet by id at all.
      await expect(
        run(client, '2099-06-01', '2099-06-21', { scope: [a!], locationId: b! }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  // ── 2. product_qty_outlier ─────────────────────────────────────────────────

  it('product_qty_outlier flags 1,394 of a product that normally sells ~0, not a steady seller nor a small spike', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const sayap = await mintProduct(client, { price: 1000, name: 'ZZANOM Sayap' });
      const steady = await mintProduct(client, { price: 1000, name: 'ZZANOM Steady' });
      const small = await mintProduct(client, { price: 1000, name: 'ZZANOM Small' });
      const shift = await mintShift(client, a!, user, '2099-06-01');
      for (const [i, day] of days('2099-06-01', 20).entries()) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          lines: [
            { product: sayap, qty: i % 5 === 0 ? 2 : 1, price: 1000 },
            { product: steady, qty: 100, price: 1000 },
          ],
        });
      }
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-21',
        lines: [
          { product: sayap, qty: 1394, price: 1000 },
          { product: steady, qty: 120, price: 1000 }, // 1.2x its median: normal
          { product: small, qty: 30, price: 1000 }, // 30 from nothing, but under the 50 floor
        ],
      });
      const r = await run(client, '2099-06-01', '2099-06-21');
      const items = det(r, 'product_qty_outlier').items.filter((i) => i.locationId === a);
      expect(items).toHaveLength(1);
      expect(items[0]!.detail.product).toBe('ZZANOM Sayap');
      expect(Number(items[0]!.actual)).toBe(1394);
      expect(items[0]!.date).toBe('2099-06-21');
    });
  });

  // ── 3. usage_variance ──────────────────────────────────────────────────────

  it('usage_variance flags a recipe that used 48 where the count says 1 (and the period variance), not a close item or a cheap one', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const area = await mintStorageArea(client, a!);
      const tea = await mintItem(client, { avgCost: 100_000, name: 'ZZANOM Tea' });
      const close = await mintItem(client, { avgCost: 100_000, name: 'ZZANOM Close' });
      const cheap = await mintItem(client, { avgCost: 10, name: 'ZZANOM Cheap' });
      // An earlier count (clean: nothing adjusted) so the period starts on 06-01
      // instead of reaching back through seeded history.
      await plantAdjustedOpname(client, {
        location: a!,
        area,
        user,
        day: '2099-06-01',
        lines: [tea, close, cheap].map((item) => ({ item, system: 0, counted: 0 })),
      });
      // Recipe posted usage in the days before the count.
      for (const [item, qty] of [
        [tea, 48],
        [close, 100],
        [cheap, 100],
      ] as const) {
        await plantSaleUsage(client, { location: a!, area, item, qty, day: '2099-06-08' });
      }
      const p = await mintProduct(client, { price: 1000 });
      const shift = await mintShift(client, a!, user, '2099-06-08');
      // Sales over the period: Rp 10M.
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-08',
        lines: [{ product: p, qty: 10_000, price: 1000 }],
      });
      await plantAdjustedOpname(client, {
        location: a!,
        area,
        user,
        day: '2099-06-10',
        lines: [
          { item: tea, system: 0, counted: 47 }, // found 47 MORE than the books: actual use was 1
          { item: close, system: 20, counted: 10 }, // 10 short: actual 110 vs 100, 9%
          { item: cheap, system: 0, counted: 80 }, // 80% off but worth Rp 800
        ],
        adjustments: [
          { item: tea, qty: 47, unitCost: 100_000 },
          { item: close, qty: -10, unitCost: 100_000 },
          { item: cheap, qty: 80, unitCost: 10 },
        ],
      });

      const r = await run(client, '2099-06-01', '2099-06-30');
      const all = det(r, 'usage_variance').items.filter((i) => i.locationId === a);
      const perItem = all.filter((i) => i.metric === 'usage');
      expect(perItem).toHaveLength(1);
      expect(perItem[0]!.detail.item).toBe('ZZANOM Tea');
      expect(Number(perItem[0]!.expected)).toBe(48);
      expect(Number(perItem[0]!.actual)).toBe(1);
      expect(perItem[0]!.detail.variancePct).toBeGreaterThan(97);

      // Period level: +4.7M + -1M + 800 = 3.7M vs 10M of sales (37% > 5%).
      const period = all.filter((i) => i.metric === 'stock_variance');
      expect(period).toHaveLength(1);
      expect(Number(period[0]!.actual)).toBeCloseTo(3_700_800, 0);
      expect(period[0]!.ratio).toBeGreaterThan(30);
    });
  });

  it('usage_variance flags a period whose variance is bigger than the stock still on hand', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const area = await mintStorageArea(client, a!);
      const item = await mintItem(client, { avgCost: 100_000 });
      const p = await mintProduct(client, { price: 1000 });
      const shift = await mintShift(client, a!, user, '2099-06-08');
      await plantAdjustedOpname(client, {
        location: a!,
        area,
        user,
        day: '2099-06-01',
        lines: [{ item, system: 0, counted: 0 }],
      });
      // Sales so large that the % of sales stays under 5%, so only the stock test can fire.
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-08',
        lines: [{ product: p, qty: 1_000_000, price: 1000 }],
      });
      await plantAdjustedOpname(client, {
        location: a!,
        area,
        user,
        day: '2099-06-10',
        lines: [{ item, system: 20, counted: 1 }], // closing stock worth Rp 100k
        adjustments: [{ item, qty: -19, unitCost: 100_000 }], // lost Rp 1.9M, 0.19% of sales
      });
      const r = await run(client, '2099-06-01', '2099-06-30');
      const period = det(r, 'usage_variance').items.filter(
        (i) => i.locationId === a && i.metric === 'stock_variance',
      );
      expect(period).toHaveLength(1);
      expect(period[0]!.detail.overStock).toBe(1);
      expect(period[0]!.severity).toBe('high');
    });
  });

  // ── 4. price_deviation ─────────────────────────────────────────────────────

  it('price_deviation flags an outlet selling a product off its channel price, honouring the NULL -> walk-in fallback', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const priced = await mintProduct(client, {
        price: 10_000,
        priceGofood: 12_000,
        name: 'ZZANOM Priced',
      });
      const fallback = await mintProduct(client, {
        price: 5_000,
        priceGofood: null,
        name: 'ZZANOM Fallback',
      });
      const shift = await mintShift(client, a!, user, '2099-06-01');
      const day = '2099-06-05';
      // 10 clean walk-in lines + 4 sold at 8,000: 4/14 = 28.6% off-price.
      for (let i = 0; i < 10; i++) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          lines: [{ product: priced, qty: 1, price: 10_000 }],
        });
      }
      for (let i = 0; i < 4; i++) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          lines: [{ product: priced, qty: 1, price: 8_000 }],
        });
      }
      // GoFood lines at the GoFood price: NOT a deviation (they would be against the walk-in price).
      for (let i = 0; i < 5; i++) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          channel: 'gofood',
          lines: [{ product: priced, qty: 1, price: 12_000 }],
        });
      }
      // NULL price_gofood falls back to the walk-in price: a GoFood sale at 5,000 is correct.
      for (let i = 0; i < 5; i++) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          channel: 'gofood',
          lines: [{ product: fallback, qty: 1, price: 5_000 }],
        });
      }
      const r = await run(client, '2099-06-01', '2099-06-30');
      const items = det(r, 'price_deviation').items.filter((i) => i.locationId === a);
      expect(items).toHaveLength(1);
      expect(items[0]!.detail.product).toBe('ZZANOM Priced');
      expect(items[0]!.detail.deviating).toBe(4);
      expect(items[0]!.detail.lines).toBe(19); // 14 walk-in + 5 gofood
      expect(Number(items[0]!.actual)).toBe(8000);
      expect(Number(items[0]!.expected)).toBe(10000);
    });
  });

  // ── 5. payroll_outlier ─────────────────────────────────────────────────────

  it('payroll_outlier flags net under 25% of base and deductions over 50% of gross, not an ordinary payslip', async () => {
    await withOwnerRollback(async (client) => {
      const emps = (
        await client.query<{ id: string; location_id: string; name: string }>(
          `SELECT id, location_id, name FROM employees ORDER BY employee_number LIMIT 3`,
        )
      ).rows;
      const [low, heavy, fine] = emps;
      const comp = async (code: string) =>
        (
          await client.query<{ id: string }>(`SELECT id FROM salary_components WHERE code = $1`, [
            code,
          ])
        ).rows[0]!.id;
      const [base, overtime, otherDed] = [
        await comp('base_salary'),
        await comp('overtime'),
        await comp('other_deduction'),
      ];
      const period = (
        await client.query<{ id: string }>(
          `INSERT INTO payroll_periods (period_code, start_date, end_date) VALUES ('2099-06', '2099-06-01', '2099-06-30') RETURNING id`,
        )
      ).rows[0]!.id;
      const run1 = (
        await client.query<{ id: string }>(
          `INSERT INTO payroll_runs (period_id, run_number) VALUES ($1, 'ZZANOM-PRUN-1') RETURNING id`,
          [period],
        )
      ).rows[0]!.id;
      const line = (e: string, c: string, amount: number) =>
        client.query(
          `INSERT INTO payroll_lines (run_id, employee_id, component_id, amount) VALUES ($1,$2,$3,$4)`,
          [run1, e, c, amount],
        );
      // low: base 5M, deductions 4.5M -> net 500k = 10% of base
      await line(low!.id, base, 5_000_000);
      await line(low!.id, otherDed, 4_500_000);
      // heavy: gross 6M, deductions 3.5M (58%) -> net 2.5M = 50% of base: only the deductions rule fires
      await line(heavy!.id, base, 5_000_000);
      await line(heavy!.id, overtime, 1_000_000);
      await line(heavy!.id, otherDed, 3_500_000);
      // fine: base 5M, deductions 100k
      await line(fine!.id, base, 5_000_000);
      await line(fine!.id, otherDed, 100_000);

      const r = await run(client, '2099-06-01', '2099-06-30');
      const items = det(r, 'payroll_outlier').items.filter((i) => i.detail.run === 'ZZANOM-PRUN-1');
      const byEmp = new Map(items.map((i) => [i.detail.employee, i]));
      expect(items).toHaveLength(2);
      expect(byEmp.get(low!.name)!.metric).toBe('net_pay');
      expect(Number(byEmp.get(low!.name)!.actual)).toBe(500_000);
      expect(byEmp.get(low!.name)!.ratio).toBeCloseTo(0.1, 2);
      expect(byEmp.get(heavy!.name)!.metric).toBe('deductions');
      expect(byEmp.get(fine!.name)).toBeUndefined();

      // Scoped to a location other than these employees': nothing.
      const other = (
        await client.query<{ id: string }>(
          `SELECT id FROM locations WHERE id <> ALL($1::uuid[]) LIMIT 1`,
          [[low!.location_id, heavy!.location_id, fine!.location_id]],
        )
      ).rows[0]!.id;
      const scoped = await run(client, '2099-06-01', '2099-06-30', { scope: [other] });
      expect(
        det(scoped, 'payroll_outlier').items.filter((i) => i.detail.run === 'ZZANOM-PRUN-1'),
      ).toHaveLength(0);
    });
  });

  // ── 6. gl_sanity ───────────────────────────────────────────────────────────

  it('gl_sanity flags a cash account in credit and cash that only grows, not a till that banks its takings; and sums only posted lines up to the window end', async () => {
    await withOwnerRollback(async (client) => {
      const [wrong, growing, banked, reversed] = await pickCleanOutlets(client, 4);
      const user = await pickUser(client);
      const acct = async (code: string) =>
        (
          await client.query<{ id: string }>(`SELECT id FROM chart_of_accounts WHERE code = $1`, [
            code,
          ])
        ).rows[0]!.id;
      const [cash, bank, revenue] = [await acct('1000'), await acct('1020'), await acct('4000')];
      const fp = (
        await client.query<{ id: string }>(
          `INSERT INTO fiscal_periods (period_code, start_date, end_date) VALUES ('2099-06', '2099-06-01', '2099-06-30')
           ON CONFLICT (period_code) DO UPDATE SET period_code = EXCLUDED.period_code RETURNING id`,
        )
      ).rows[0]!.id;
      let n = 0;
      const entry = async (
        loc: string,
        date: string,
        lines: { account: string; debit?: number; credit?: number }[],
        status: 'posted' | 'reversed' = 'posted',
      ) => {
        const e = (
          await client.query<{ id: string }>(
            `INSERT INTO journal_entries (entry_number, entry_date, fiscal_period_id, location_id, description, status, posted_by)
             VALUES ($1, $2, $3, $4, 'ZZANOM', $5, $6) RETURNING id`,
            [
              `ZZANOM-JE-${n++}-${Math.random().toString(36).slice(2, 8)}`,
              date,
              fp,
              loc,
              status,
              user,
            ],
          )
        ).rows[0]!.id;
        let no = 1;
        for (const l of lines) {
          await client.query(
            `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, location_id) VALUES ($1,$2,$3,$4,$5,$6)`,
            [e, no++, l.account, l.debit ?? 0, l.credit ?? 0, loc],
          );
        }
      };
      // wrong: cash paid out of an empty till — Kas Outlet ends in credit by 5M.
      await entry(wrong!, '2099-06-03', [
        { account: bank, debit: 5_000_000 },
        { account: cash, credit: 5_000_000 },
      ]);
      // growing: 20 days of cash takings, never a deposit.
      for (const d of days('2099-06-01', 20)) {
        await entry(growing!, d, [
          { account: cash, debit: 1_000_000 },
          { account: revenue, credit: 1_000_000 },
        ]);
      }
      // banked: the same takings, but a deposit on the 18th.
      for (const d of days('2099-06-01', 20)) {
        await entry(banked!, d, [
          { account: cash, debit: 1_000_000 },
          { account: revenue, credit: 1_000_000 },
        ]);
      }
      await entry(banked!, '2099-06-18', [
        { account: bank, debit: 15_000_000 },
        { account: cash, credit: 15_000_000 },
      ]);
      // reversed: a REVERSED entry that would be a wrong-sign balance if it were counted.
      await entry(
        reversed!,
        '2099-06-03',
        [
          { account: bank, debit: 9_000_000 },
          { account: cash, credit: 9_000_000 },
        ],
        'reversed',
      );

      const r = await run(client, '2099-06-01', '2099-06-30');
      const items = det(r, 'gl_sanity').items;
      const at = (loc: string) => items.filter((i) => i.locationId === loc);

      const w = at(wrong!);
      expect(w).toHaveLength(1);
      expect(w[0]!.metric).toBe('balance');
      expect(w[0]!.detail.account).toBe('1000 Kas Outlet');
      expect(Number(w[0]!.actual)).toBe(-5_000_000); // the balance in normal-side terms: negative = on the wrong side

      const g = at(growing!);
      expect(g).toHaveLength(1);
      expect(g[0]!.metric).toBe('cash_growth_days');
      expect(Number(g[0]!.actual)).toBe(19);

      expect(at(banked!)).toHaveLength(0); // deposited on the 18th: last credit -> last debit is 2 days
      expect(at(reversed!)).toHaveLength(0); // status filter decides which lines are summed

      // As of the 2nd: nothing planted for `wrong` exists yet — the window end bounds the lines.
      const early = await run(client, '2099-06-01', '2099-06-02');
      expect(det(early, 'gl_sanity').items.filter((i) => i.locationId === wrong)).toHaveLength(0);
    });
  });

  // ── 7. settlement_gap ──────────────────────────────────────────────────────

  it('settlement_gap says "no settlement recorded" once instead of flagging every day, then flags only the unsettled day once settlements exist', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const p = await mintProduct(client, { price: 1000 });
      const shift = await mintShift(client, a!, user, '2099-06-01');
      const day1 = await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-01',
        lines: [{ product: p, qty: 1000, price: 1000 }],
        payments: [{ method: 'qris', amount: 1_000_000 }],
      });
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-02',
        lines: [{ product: p, qty: 1000, price: 1000 }],
        payments: [{ method: 'qris', amount: 1_000_000 }],
      });
      // Cash takings are not settled by anyone: ignored.
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-03',
        lines: [{ product: p, qty: 1000, price: 1000 }],
      });

      const none = await run(client, '2099-06-01', '2099-06-30');
      const d0 = det(none, 'settlement_gap');
      expect(d0.notice).toBe('no_settlement_recorded');
      expect(d0.items).toHaveLength(0);

      // Settle day 1 in full.
      await client.query(
        `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, amount, status, submitted_by, paid_at, location_id)
         VALUES ('ZZANOM-PV-1', 'sale_payment', $1, 'platform', 1000000, 'paid', $2, now(), $3)`,
        [day1.paymentIds[0], user, a],
      );
      const some = await run(client, '2099-06-01', '2099-06-30');
      const d1 = det(some, 'settlement_gap');
      expect(d1.notice).toBeNull();
      const items = d1.items.filter((i) => i.locationId === a);
      expect(items.map((i) => i.date)).toEqual(['2099-06-02']);
      expect(Number(items[0]!.expected)).toBe(1_000_000);
      expect(Number(items[0]!.actual)).toBe(0);
    });
  });

  // ── cross-cutting ──────────────────────────────────────────────────────────

  it('a detector that throws is reported failed and the others still answer (savepoint isolation)', async () => {
    await withOwnerRollback(async (client) => {
      // Poison ONE detector: payroll reads salary_components; hide it behind a missing column via a bad stored value is
      // not possible, so drop a column the payroll query needs inside this rolled-back transaction.
      await client.query(`ALTER TABLE payroll_periods RENAME COLUMN start_date TO start_date_x`);
      const r = await run(client, '2099-06-01', '2099-06-02');
      expect(det(r, 'payroll_outlier').failed).toBe(true);
      expect(det(r, 'sales_day_outlier').failed).toBe(false);
      expect(det(r, 'gl_sanity').failed).toBe(false);
    });
  });

  it('reviewed findings are hidden by default and shown (with who/when) when includeReviewed is set', async () => {
    await withOwnerRollback(async (client) => {
      const [a] = await pickCleanOutlets(client, 1);
      const user = await pickUser(client);
      const p = await mintProduct(client, { price: 1000 });
      const shift = await mintShift(client, a!, user, '2099-06-01');
      for (const day of days('2099-06-01', 20)) {
        await plantSale(client, {
          location: a!,
          shift,
          user,
          day,
          lines: [{ product: p, qty: 1000, price: 1000 }],
        });
      }
      await plantSale(client, {
        location: a!,
        shift,
        user,
        day: '2099-06-21',
        lines: [{ product: p, qty: 30_000, price: 1000 }],
      });

      const before = await run(client, '2099-06-01', '2099-06-21');
      const item = det(before, 'sales_day_outlier').items.find((i) => i.locationId === a)!;
      expect(item.reviewed).toBe(false);
      const open0 = before.openCount;

      await client.query(
        `INSERT INTO anomaly_reviews (detector, fingerprint, location_id, reviewed_by, note) VALUES ('sales_day_outlier', $1, $2, $3, 'sudah dicek')`,
        [item.fingerprint, a, user],
      );
      const hidden = await run(client, '2099-06-01', '2099-06-21');
      expect(
        det(hidden, 'sales_day_outlier').items.find((i) => i.fingerprint === item.fingerprint),
      ).toBeUndefined();
      expect(det(hidden, 'sales_day_outlier').reviewedCount).toBeGreaterThanOrEqual(1);
      expect(hidden.openCount).toBe(open0 - 1);

      const shown = await run(client, '2099-06-01', '2099-06-21', { includeReviewed: true });
      const again = det(shown, 'sales_day_outlier').items.find(
        (i) => i.fingerprint === item.fingerprint,
      )!;
      expect(again.reviewed).toBe(true);
      expect(again.reviewNote).toBe('sudah dicek');
      expect(again.reviewedAt).not.toBeNull();
      // The same window next week finds the same fingerprint: still hidden.
      expect(shown.openCount).toBe(open0 - 1);
    });
  });
});
