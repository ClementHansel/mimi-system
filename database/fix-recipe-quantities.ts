/**
 * Recompute `recipe_lines.qty` from a realistic food-cost target.
 *
 * ## Why this exists
 *
 * `seed.ts` used to roll each recipe line as a random 0.5–3.0 kg of an
 * ingredient PER PORTION. Nothing rejected it: no constraint says a recipe has
 * to be physically possible. But a Kerupuk ended up containing 2.3 kg of flour,
 * every product cost nine to fifteen times what it sold for, and the owner's
 * dashboard reported a loss of four billion rupiah on a chain that is
 * profitable. Every margin, COGS and profit figure in the system was nonsense,
 * and none of it looked broken — the numbers were simply wrong.
 *
 * `seed.ts` now derives quantities from price (see `recipeLineQty` there), but
 * its inserts are `ON CONFLICT DO NOTHING`, which is right for a seed and
 * useless for a correction: re-running it leaves existing rows exactly as
 * wrong as they were. Hence this one-off, which is safe to re-run and applies
 * the same rule to rows that already exist.
 *
 * ## The rule
 *
 * A quick-service fried-chicken operation runs a food cost near a third of the
 * menu price. Take that share, split it across the recipe's ingredients, and
 * convert each share to a weight using that ingredient's own `avg_cost`.
 * Deriving from price rather than assigning weights means the result stays
 * believable if items are ever re-priced.
 *
 * The split is EVEN across ingredients, which is the honest limit of this fix:
 * it makes total cost per product realistic, not the relative proportion of
 * chicken to flour to oil. Getting that right needs per-ingredient culinary
 * weighting that no data here provides. Margins are now believable; a recipe is
 * still not a recipe you could cook from.
 *
 * Usage:
 *   npx tsx database/fix-recipe-quantities.ts            # apply
 *   npx tsx database/fix-recipe-quantities.ts --dry-run  # report, write nothing
 *
 * Environment: DATABASE_MIGRATION_URL — the DDL-owning role, as with seed.ts.
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const FOOD_COST_RATIO = 0.33;

/** Same derivation as `seed.ts`'s `recipeLineQty`, kept in step deliberately. */
function targetQty(
  price: number,
  ingredientCount: number,
  avgCost: number,
  yieldQty: number,
  jitterSeed: string,
): number {
  if (!Number.isFinite(avgCost) || avgCost <= 0) return 0.02 * yieldQty;
  const hash = createHash('md5').update(jitterSeed).digest()[0] ?? 0;
  const jitter = 0.85 + (hash / 255) * 0.3;
  const targetCost = (price * FOOD_COST_RATIO * jitter) / Math.max(1, ingredientCount);
  return Math.max(0.001, targetCost / avgCost) * yieldQty;
}

interface LineRow {
  line_id: string;
  product_name: string;
  price: string;
  yield_qty: string;
  item_name: string;
  avg_cost: string;
  current_qty: string;
  ingredient_count: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const connectionString =
    process.env.DATABASE_MIGRATION_URL || 'postgresql://mimi:mimi_secret@localhost:5432/mimi';
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query<LineRow>(`
      SELECT rl.id AS line_id,
             p.name AS product_name,
             p.price::text AS price,
             r.yield_qty::text AS yield_qty,
             i.name AS item_name,
             i.avg_cost::text AS avg_cost,
             rl.qty::text AS current_qty,
             COUNT(*) OVER (PARTITION BY r.id)::text AS ingredient_count
        FROM recipe_lines rl
        JOIN recipes r ON r.id = rl.recipe_id
        JOIN products p ON p.id = r.product_id
        JOIN items i ON i.id = rl.item_id
       ORDER BY p.name, i.name
    `);

    console.log(`\nRecipe quantity correction — ${dryRun ? 'DRY RUN' : 'applying'}\n`);
    console.log(`  ${res.rows.length} recipe lines\n`);

    let changed = 0;
    const samples: string[] = [];
    for (const row of res.rows) {
      const next = targetQty(
        Number(row.price),
        Number(row.ingredient_count),
        Number(row.avg_cost),
        Number(row.yield_qty) || 1,
        row.product_name + row.item_name,
      );
      const rounded = Number(next.toFixed(3));
      if (Math.abs(rounded - Number(row.current_qty)) < 0.0005) continue;
      changed += 1;
      if (samples.length < 6) {
        samples.push(
          `  ${row.product_name} / ${row.item_name}: ${row.current_qty} -> ${rounded.toFixed(3)} kg`,
        );
      }
      await client.query(`UPDATE recipe_lines SET qty = $2 WHERE id = $1`, [
        row.line_id,
        rounded.toFixed(3),
      ]);
    }

    for (const line of samples) console.log(line);
    console.log(`\n  ${changed} lines ${dryRun ? 'would change' : 'changed'}`);

    // Report the resulting margins so the caller can see whether the numbers
    // are actually believable now, rather than trusting that they are.
    const check = await client.query<{ name: string; price: string; cost: string; pct: string }>(`
      SELECT p.name,
             p.price::text AS price,
             ROUND(SUM(rl.qty * i.avg_cost) / NULLIF(r.yield_qty, 0), 2)::text AS cost,
             ROUND(100 * SUM(rl.qty * i.avg_cost) / NULLIF(r.yield_qty, 0) / NULLIF(p.price, 0), 1)::text AS pct
        FROM products p
        JOIN recipes r ON r.product_id = p.id
        JOIN recipe_lines rl ON rl.recipe_id = r.id
        JOIN items i ON i.id = rl.item_id
       GROUP BY p.id, p.name, p.price, r.yield_qty
       ORDER BY 4 DESC NULLS LAST
       LIMIT 5
    `);
    console.log('\n  Highest food-cost products after this change:');
    for (const r of check.rows) {
      console.log(`    ${r.name}: harga ${r.price}, HPP ${r.cost} (${r.pct}%)`);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back.\n');
    } else {
      await client.query('COMMIT');
      console.log('\nCommitted.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
