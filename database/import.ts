/**
 * Master-data importer — CSV in, upserts out, dry run by default.
 *
 * The path from "demo box" to "real Mimi Chicken data" (owner, 2026-08-22:
 * demo now, prod later). Loads the master data that has to exist before anyone
 * can transact: units, item categories, outlets, items, menu products and their
 * recipes.
 *
 *   Usage:
 *     # look, change nothing (the default)
 *     pnpm --filter @mimi/database import -- --dir ./import-samples
 *
 *     # apply, all-or-nothing
 *     pnpm --filter @mimi/database import -- --dir ./import-samples --commit
 *
 *     # one entity only
 *     pnpm --filter @mimi/database import -- --dir ./data --only items --commit
 *
 * Files are `<entity>.csv` in `--dir`; a missing file is skipped, not an error,
 * so a directory holding only `items.csv` is a valid items-only import.
 *
 * FOUR DELIBERATE PROPERTIES:
 *
 *  1. DRY RUN BY DEFAULT — prints exactly what it would insert and update.
 *  2. ONE TRANSACTION — `--commit` wraps every entity in a single transaction.
 *     A half-applied import of interdependent master data (items referencing
 *     units that did not land) is worse than no import.
 *  3. VALIDATE EVERYTHING FIRST, including foreign keys resolved against the
 *     live database, before any write. So "unit `kg` not found" surfaces in the
 *     dry run, not halfway through the real one.
 *  4. IDEMPOTENT — upsert on the natural key a human already uses. Re-running
 *     the same file is a no-op, which is what makes a correction cycle
 *     (import, spot a mistake, fix the sheet, import again) safe.
 *
 * NOT HERE, ON PURPOSE: employees and users. Those need a role, a location
 * scope, a password and — for anyone who approves anything — a PIN, which are
 * decisions per person rather than columns in a sheet. They come next, with
 * their own confirmation step.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ENTITIES, parseCsv, validate, type EntityDef, type RowError } from './import-schema.js';
import { migrationConnectionString } from './db-connection';

const { Client } = pg;

interface Plan {
  entity: string;
  inserts: number;
  updates: number;
  /** Recipes report replaced products rather than rows. */
  detail?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function printHelp(): void {
  console.log('\nMaster-data importer — CSV in, upserts out.\n');
  console.log('  --dir <path>     directory holding <entity>.csv files (required)');
  console.log('  --only <entity>  import just one entity');
  console.log('  --commit         actually write (default is a dry run)');
  console.log('  --help           this text\n');
  console.log('Entities, in the order they are processed:\n');
  for (const e of ENTITIES) console.log(`  ${e.name.padEnd(16)} ${e.note}`);
  console.log('');
}

async function main(): Promise<void> {
  if (hasFlag('help') || process.argv.length <= 2) {
    printHelp();
    return;
  }
  const dir = arg('dir');
  if (!dir) {
    console.error('✗ --dir is required (see --help)');
    process.exit(2);
  }
  const only = arg('only');
  const commit = hasFlag('commit');

  const connectionString =
    migrationConnectionString('db:import');
  const client = new Client({ connectionString });
  await client.connect();

  const errors: RowError[] = [];
  const plans: Plan[] = [];

  try {
    await client.query('BEGIN');

    for (const entity of ENTITIES) {
      if (only && entity.name !== only) continue;

      let text: string;
      try {
        text = await readFile(join(dir, `${entity.name}.csv`), 'utf8');
      } catch {
        continue; // no file for this entity — not an error
      }

      const csv = parseCsv(text);
      const { rows, errors: rowErrors } = validate(entity, csv);
      errors.push(...rowErrors);

      // The rows that DID validate are still applied, even when siblings
      // failed — not to write them (any error rolls the whole run back) but to
      // surface foreign-key problems in the SAME pass as the format problems.
      // Skipping here meant a user fixed three enum typos, re-ran, and only
      // then learned that a unit was missing: exactly the one-error-per-run
      // loop this tool's second rule says it will not impose.
      const plan =
        entity.name === 'recipes'
          ? await applyRecipes(client, rows, errors)
          : await applyEntity(client, entity, rows, errors);
      plans.push(plan);
    }

    if (errors.length > 0) {
      // Nothing is written when anything is wrong, even the entities that were
      // themselves fine: a partial master-data load is the failure mode this
      // tool exists to avoid.
      await client.query('ROLLBACK');
      report(plans, errors, false);
      process.exit(1);
    }

    if (commit) {
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
    report(plans, errors, commit);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n✗ Import failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

/**
 * Upserts one entity's rows, resolving foreign keys by the human name the sheet
 * uses. Runs inside the caller's transaction, so a dry run gets REAL insert and
 * update counts from a database that then rolls back — the plan is measured,
 * not predicted.
 */
async function applyEntity(
  client: pg.Client,
  entity: EntityDef,
  rows: { line: number; values: Record<string, string | null> }[],
  errors: RowError[],
): Promise<Plan> {
  let inserts = 0;
  let updates = 0;

  for (const row of rows) {
    const values = { ...row.values };

    // Foreign keys arrive as names/codes; resolve or complain with the line.
    if (entity.name === 'items') {
      const unitCode = values.base_unit!;
      const unit = await client.query<{ id: string }>(
        `SELECT id FROM units WHERE lower(code) = lower($1)`,
        [unitCode],
      );
      if (!unit.rows[0]) {
        errors.push({
          entity: entity.name,
          line: row.line,
          column: 'base_unit',
          message: `unit "${unitCode}" does not exist — add it to units.csv or create it first`,
        });
        continue;
      }
      values.base_unit_id = unit.rows[0].id;

      if (values.category) {
        const category = await client.query<{ id: string }>(
          `SELECT id FROM item_categories WHERE lower(name) = lower($1)`,
          [values.category],
        );
        if (!category.rows[0]) {
          errors.push({
            entity: entity.name,
            line: row.line,
            column: 'category',
            message: `category "${values.category}" does not exist — add it to item_categories.csv`,
          });
          continue;
        }
        values.category_id = category.rows[0].id;
      }
    }

    // Menu category, same shape as an item's: the sheet carries a NAME, the
    // column is a FK since migration 247. Unlike items it is required, because
    // `products.category_id` is NOT NULL — so an omitted column is an error
    // with a line number rather than a null that the insert would reject with a
    // constraint message naming no row.
    if (entity.name === 'products') {
      if (!values.category) {
        errors.push({
          entity: entity.name,
          line: row.line,
          column: 'category',
          message: 'category is required — every product belongs to a menu category',
        });
        continue;
      }
      const category = await client.query<{ id: string }>(
        `SELECT id FROM product_categories WHERE lower(name) = lower($1)`,
        [values.category],
      );
      if (!category.rows[0]) {
        errors.push({
          entity: entity.name,
          line: row.line,
          column: 'category',
          message: `menu category "${values.category}" does not exist — create it under Master Data first`,
        });
        continue;
      }
      values.category_id = category.rows[0].id;
    }

    const { sql, params } = upsertFor(entity, values);
    const res = await client.query<{ inserted: boolean }>(sql, params);
    if (res.rows[0]?.inserted) inserts++;
    else updates++;
  }

  return { entity: entity.name, inserts, updates };
}

/**
 * `xmax = 0` is the standard Postgres trick for "this row was INSERTed, not
 * UPDATEd, by this upsert" — it lets the dry run report inserts and updates
 * separately without a second query per row.
 */
function upsertFor(
  entity: EntityDef,
  values: Record<string, string | null>,
): { sql: string; params: unknown[] } {
  const columnsByEntity: Record<string, string[]> = {
    units: ['code', 'name'],
    item_categories: ['name', 'sort_order'],
    locations: [
      'code',
      'name',
      'type',
      'city',
      'address',
      'phone',
      'latitude',
      'longitude',
      'geofence_radius_m',
    ],
    items: [
      'sku',
      'name',
      'category_id',
      'base_unit_id',
      'storage_type',
      'is_sellable',
      'shelf_life_days',
      'barcode',
    ],
    products: ['code', 'name', 'category_id', 'price', 'sort_order'],
  };

  const columns = columnsByEntity[entity.name]!;
  const params = columns.map((c) => values[c] ?? null);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  // Never overwrite the natural key with itself, and never blank a column the
  // sheet left empty — an import that omits `phone` must not erase the phone
  // number somebody already typed into the UI.
  const updates = columns
    .filter((c) => c !== entity.naturalKey)
    .map((c) => `${c} = COALESCE(EXCLUDED.${c}, ${entity.table}.${c})`)
    .join(', ');

  return {
    sql: `INSERT INTO ${entity.table} (${columns.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT (${entity.naturalKey}) DO UPDATE SET ${updates}
          RETURNING (xmax = 0) AS inserted`,
    params,
  };
}

/**
 * Recipes are replaced per product, not merged per line: a sheet listing three
 * ingredients for PRD001 means "PRD001 has exactly these three". Merging would
 * make a removed ingredient impossible to express.
 */
async function applyRecipes(
  client: pg.Client,
  rows: { line: number; values: Record<string, string | null> }[],
  errors: RowError[],
): Promise<Plan> {
  const byProduct = new Map<string, { line: number; values: Record<string, string | null> }[]>();
  for (const row of rows) {
    const code = row.values.product_code!;
    const list = byProduct.get(code) ?? [];
    list.push(row);
    byProduct.set(code, list);
  }

  let replaced = 0;
  for (const [code, lines] of byProduct) {
    const product = await client.query<{ id: string }>(
      `SELECT id FROM products WHERE lower(code) = lower($1)`,
      [code],
    );
    if (!product.rows[0]) {
      errors.push({
        entity: 'recipes',
        line: lines[0]!.line,
        column: 'product_code',
        message: `product "${code}" does not exist — add it to products.csv`,
      });
      continue;
    }
    const productId = product.rows[0].id;

    const resolved: { itemId: string; unitId: string; qty: string }[] = [];
    let ok = true;
    for (const row of lines) {
      const item = await client.query<{ id: string }>(
        `SELECT id FROM items WHERE lower(sku) = lower($1)`,
        [row.values.item_sku],
      );
      if (!item.rows[0]) {
        errors.push({
          entity: 'recipes',
          line: row.line,
          column: 'item_sku',
          message: `item "${row.values.item_sku}" does not exist — add it to items.csv`,
        });
        ok = false;
        continue;
      }
      const unit = await client.query<{ id: string }>(
        `SELECT id FROM units WHERE lower(code) = lower($1)`,
        [row.values.unit],
      );
      if (!unit.rows[0]) {
        errors.push({
          entity: 'recipes',
          line: row.line,
          column: 'unit',
          message: `unit "${row.values.unit}" does not exist`,
        });
        ok = false;
        continue;
      }
      resolved.push({ itemId: item.rows[0].id, unitId: unit.rows[0].id, qty: row.values.qty! });
    }
    if (!ok) continue;

    // A recipe is TWO tables: `recipes` (one row per product, carrying the
    // yield) and `recipe_lines` (the ingredients). The header row is upserted so
    // an existing recipe keeps its id — anything referencing it stays valid —
    // and only the lines are replaced.
    const yieldQty = lines.find((l) => l.values.yield_qty)?.values.yield_qty ?? '1.000';
    const recipe = await client.query<{ id: string }>(
      `INSERT INTO recipes (product_id, yield_qty) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET yield_qty = EXCLUDED.yield_qty, updated_at = NOW()
       RETURNING id`,
      [productId, yieldQty],
    );
    const recipeId = recipe.rows[0]!.id;

    await client.query(`DELETE FROM recipe_lines WHERE recipe_id = $1`, [recipeId]);
    for (const line of resolved) {
      await client.query(
        `INSERT INTO recipe_lines (recipe_id, item_id, unit_id, qty) VALUES ($1,$2,$3,$4)`,
        [recipeId, line.itemId, line.unitId, line.qty],
      );
    }
    replaced++;
  }

  return {
    entity: 'recipes',
    inserts: 0,
    updates: replaced,
    detail: `${replaced} product recipe(s) replaced`,
  };
}

function report(plans: Plan[], errors: RowError[], committed: boolean): void {
  console.log('');
  if (plans.length === 0 && errors.length === 0) {
    console.log('Nothing to do — no matching <entity>.csv files in that directory.\n');
    return;
  }

  for (const plan of plans) {
    const summary = plan.detail ?? `${plan.inserts} new, ${plan.updates} updated`;
    console.log(`  ${plan.entity.padEnd(16)} ${summary}`);
  }

  if (errors.length > 0) {
    console.log(`\n✗ ${errors.length} problem(s) — NOTHING was written:\n`);
    for (const e of errors.slice(0, 50)) {
      const where = e.column
        ? `${e.entity}.csv:${e.line} [${e.column}]`
        : `${e.entity}.csv:${e.line}`;
      console.log(`  ${where}  ${e.message}`);
    }
    if (errors.length > 50) console.log(`  … and ${errors.length - 50} more`);
    console.log('');
    return;
  }

  console.log(
    committed
      ? '\n✓ Committed.\n'
      : '\n✓ Dry run — nothing was written. Re-run with --commit to apply.\n',
  );
}

main();
