import { describe, it, expect, afterAll } from 'vitest';
import { OverviewService } from './services/overview.service';
import { closePool, withOwnerRollback } from './test-support/live-db';

/**
 * The dashboard's profit estimate walks sale_lines through recipe_lines at
 * items.avg_cost. `recipe_lines.qty` is per ONE execution of the recipe and
 * `recipes.yield_qty` is how many portions that execution makes (the POS
 * usage posting divides by it — `recipe-usage.util.ts`). The estimate used to
 * multiply `sl.qty * rl.qty` and never divide, so a recipe written per 10
 * portions was costed 10x.
 *
 * Found importing the client's April 2026 data, whose recipes are stored per
 * 100 portions because NUMERIC(14,3) cannot hold "1/1100 box of frying fat per
 * portion" without a 10% rounding error.
 *
 * The date is far in the future so no seeded sale falls in the window; the
 * matview is refreshed inside the (rolled-back) transaction so the revenue
 * tile sees exactly this one sale, and profitEstimate = 5.000 - COGS.
 */
describe('Dashboard overview — estimated COGS honours recipe yield (integration, live Postgres)', () => {
  const DAY = '2099-06-15';

  afterAll(async () => {
    await closePool();
  });

  it('one portion of a yield-10 recipe whose single line is 10 x Rp 1.000 costs Rp 1.000, not Rp 10.000', async () => {
    const profit = await withOwnerRollback(async (client) => {
      const outlet = (
        await client.query<{ id: string }>(
          `SELECT id FROM locations WHERE type = 'outlet' AND is_active ORDER BY code LIMIT 1`,
        )
      ).rows[0]!.id;
      const user = (
        await client.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at LIMIT 1`)
      ).rows[0]!.id;
      const unit = (
        await client.query<{ id: string }>(`SELECT id FROM units ORDER BY code LIMIT 1`)
      ).rows[0]!.id;
      const category = (
        await client.query<{ id: string }>(
          `INSERT INTO product_categories (name) VALUES ('ZZTEST yield') RETURNING id`,
        )
      ).rows[0]!.id;
      const item = (
        await client.query<{ id: string }>(
          `INSERT INTO items (sku, name, base_unit_id, storage_type, avg_cost)
           VALUES ('ZZTEST-YIELD', 'ZZTEST yield item', $1, 'dry', 1000) RETURNING id`,
          [unit],
        )
      ).rows[0]!.id;
      const product = (
        await client.query<{ id: string }>(
          `INSERT INTO products (code, name, category_id, price) VALUES ('ZZTEST-YIELD', 'ZZTEST yield', $1, 5000) RETURNING id`,
          [category],
        )
      ).rows[0]!.id;
      const recipe = (
        await client.query<{ id: string }>(
          `INSERT INTO recipes (product_id, yield_qty) VALUES ($1, 10) RETURNING id`,
          [product],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO recipe_lines (recipe_id, item_id, unit_id, qty) VALUES ($1, $2, $3, 10)`,
        [recipe, item, unit],
      );
      const shift = (
        await client.query<{ id: string }>(
          `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, status, client_id)
           VALUES ('ZZTEST-YIELD-S', $1, $2, $3::date + time '09:00', 'open', gen_random_uuid()) RETURNING id`,
          [outlet, user, DAY],
        )
      ).rows[0]!.id;
      const sale = (
        await client.query<{ id: string }>(
          `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, subtotal, total, paid_amount, occurred_at)
           VALUES ('ZZTEST-YIELD-R', gen_random_uuid(), $1, $2, $3, 5000, 5000, 5000,
                   ($4::date + time '12:00') AT TIME ZONE 'Asia/Makassar') RETURNING id`,
          [outlet, shift, user, DAY],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO sale_lines (sale_id, product_id, qty, unit_price, line_total) VALUES ($1, $2, 1, 5000, 5000)`,
        [sale, product],
      );
      await client.query(`REFRESH MATERIALIZED VIEW mv_sales_daily`); // revenue for DAY stays 0 unless this sees the sale
      const o = await new OverviewService().getOverview(client, null, DAY, DAY);
      return { revenue: o.revenue, profit: o.profitEstimate };
    });

    // revenue 5.000 (the matview refresh inside the transaction sees the sale), COGS 1 x 10 / 10 x 1.000
    expect(profit.revenue).toBe('5000.00');
    expect(profit.profit).toBe('4000.00');
  }, 30_000);
});
