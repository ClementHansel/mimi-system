/**
 * Demo-data wipe — empties the seeded history so a box can take real data,
 * while keeping the system configuration and (by default) every login.
 *
 * Why this exists: `db:reset` drops the whole schema and re-seeds DEMO data,
 * and refuses prod URLs. Moving a box from demo to the client's real data
 * (owner, 2026-09-30: "clean up the live DB and use their data") needs the
 * opposite — keep roles, permissions, settings, chart of accounts, posting
 * rules, approval chains and the user accounts; drop the fabricated sales,
 * stock, logistics, finance and HR history.
 *
 *   Usage:
 *     # look, change nothing (the default): prints what would be emptied
 *     pnpm --filter @mimi/database wipe-demo
 *
 *     # also empty the demo catalog (items, products, recipes, suppliers…)
 *     pnpm --filter @mimi/database wipe-demo -- --catalog
 *
 *     # also empty the demo PEOPLE records (employees, contracts, drivers) —
 *     # logins survive, their employee link is re-made by the real import
 *     pnpm --filter @mimi/database wipe-demo -- --catalog --hr
 *
 *     # apply — the database name must be typed back, so a wrong URL cannot
 *     # wipe the wrong server
 *     pnpm --filter @mimi/database wipe-demo -- --commit --confirm mimi
 *
 * PROPERTIES:
 *
 *  1. EVERY TABLE IS CLASSIFIED. A table in the database that is in none of the
 *     lists below aborts the run. A migration that adds a table must decide
 *     which side it is on; the default is not "silently kept" or "silently
 *     wiped".
 *  2. FOREIGN KEYS ARE READ FROM THE CATALOG, NOT LISTED BY HAND. TRUNCATE
 *     refuses a table that any non-truncated table references — even with no
 *     row pointing at it — and CASCADE would reach into kept tables (users are
 *     referenced by settings and fiscal_periods). So a wiped table referenced by
 *     a kept one is DELETEd instead, after the kept rows' pointers are nulled.
 *     A NOT NULL pointer from a kept table into a wiped one is a classification
 *     error and aborts.
 *  3. ONE TRANSACTION. Half a wipe is worse than none.
 *  4. Runs as the migration role (superuser / BYPASSRLS): every table has FORCE
 *     RLS, and a DELETE filtered to zero rows by a policy would report success.
 *
 * NOT HERE: MinIO objects. Emptying `attachments` orphans them; clear the
 * bucket separately (see database/client-import/README.md).
 */
import pg from 'pg';
import { migrationConnectionString } from './db-connection';

const { Client } = pg;

/** System configuration — migrations own these rows. Never touched. */
const KEEP_SYSTEM = [
  'schema_migrations',
  'tenants',
  'tenant_email_settings',
  'roles',
  'permissions',
  'role_permissions',
  'settings',
  'approval_chain_steps',
  'chart_of_accounts',
  'posting_rules',
  'fiscal_periods',
  'shipment_types',
  'salary_components',
  'pph21_article17_brackets',
  // Statutory rates: seeded, not migrated, but payroll refuses to run without
  // them (ERR_STATUTORY_NOT_READY). Kept until someone enters verified rates.
  'bpjs_configs',
  'pph21_ter_rates',
  'pph21_ptkp',
  'units',
];

/**
 * The people and places the logins hang off. Kept by default: users are scoped
 * to locations through user_locations, and an employee record is what HR,
 * attendance and payroll resolve a login to.
 */
const KEEP_ORG = ['users', 'user_locations', 'locations', 'storage_areas', 'work_shifts'];

/**
 * The HR records behind the logins. Kept unless `--hr`: a demo box's employees
 * are fabricated people, so a real import replaces them — but a box already
 * holding real staff must not lose them to a catalog refresh.
 */
const HR = [
  'employees',
  'employments',
  'employment_contracts',
  'contract_signatures',
  'employee_salary_components',
  'employee_tax_profiles',
  'drivers',
];

/** The demo catalog. Kept unless `--catalog`, because the client's sheet may replace it. */
const CATALOG = [
  'item_categories',
  'items',
  'unit_conversions',
  'product_categories',
  'products',
  'product_package_lines',
  'recipes',
  'recipe_lines',
  'suppliers',
  'supplier_items',
  'supplier_price_history',
  'min_stock_rules',
  'assets',
  'maintenance_schedules',
  'vehicles',
];

/** History and runtime state. Always emptied. */
const WIPE = [
  // POS
  'pos_shifts',
  'sales',
  'sale_lines',
  'sale_payments',
  'void_refunds',
  'online_orders',
  'cash_variance_proposals',
  'voucher_batches',
  'vouchers',
  'voucher_redemptions',
  // stock
  'stock_balances',
  'stock_movements',
  'stock_opname',
  'stock_opname_lines',
  'stock_adjustments',
  'stock_reconciliations',
  'waste_records',
  'returns',
  'return_lines',
  // logistics
  'replenishment_requests',
  'replenishment_request_lines',
  'surat_jalan',
  'sj_drops',
  'sj_lines',
  'sj_seals',
  'sj_temperature_logs',
  'sj_positions',
  'goods_receipts',
  'goods_receipt_lines',
  // purchasing / finance
  'purchase_requests',
  'purchase_request_lines',
  'purchase_orders',
  'po_lines',
  'po_receipts',
  'po_receipt_lines',
  'petty_cash',
  'petty_cash_lines',
  'payment_verifications',
  'journal_entries',
  'journal_lines',
  // HR
  'attendance',
  'leave_requests',
  'shift_assignments',
  'employee_loans',
  'employee_loan_payments',
  'payroll_periods',
  'payroll_runs',
  'payroll_lines',
  // assets
  'maintenance_jobs',
  'service_history',
  // kernel
  'approvals',
  'approval_steps',
  'approval_codes',
  'auth_lockouts',
  'audit_log',
  'notifications',
  'notification_outbox',
  'sessions',
  'attachments',
  'document_counters',
  // "reviewed" marks on dashboard anomalies (migration 271) — about the rows being wiped
  'anomaly_reviews',
  // Designer overrides point at `attachments` (RESTRICT); the resolver falls
  // back to the shipped defaults, so an empty table is a working state.
  'document_templates',
  'chat_conversations',
  'chat_messages',
  'chat_participants',
  // sync / devices — every till must be re-paired afterwards
  'sync_events',
  'sync_batches',
  'sync_cursors',
  'sync_conflicts',
  'device_heartbeats',
  'device_events',
  'devices',
  'discovered_devices',
  'branch_nodes',
  'pairing_tokens',
  'offline_authorizations',
  'offline_credentials',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

interface Fk {
  from: string;
  to: string;
  columns: string[];
  nullable: boolean;
}

async function main(): Promise<void> {
  const commit = hasFlag('commit');
  const wipeCatalog = hasFlag('catalog');
  const wipeHr = hasFlag('hr');

  const client = new Client({ connectionString: migrationConnectionString('db:wipe-demo') });
  await client.connect();

  try {
    const { rows: dbRow } = await client.query<{ db: string }>(`SELECT current_database() AS db`);
    const db = dbRow[0]!.db;
    if (commit && arg('confirm') !== db) {
      console.error(`✗ --commit needs --confirm ${db} (the database name, typed back).`);
      process.exit(2);
    }

    const keep = new Set([
      ...KEEP_SYSTEM,
      ...KEEP_ORG,
      ...(wipeCatalog ? [] : CATALOG),
      ...(wipeHr ? [] : HR),
    ]);
    const wipe = new Set([...WIPE, ...(wipeCatalog ? CATALOG : []), ...(wipeHr ? HR : [])]);

    // 1. Every table classified, and no list names a table that does not exist.
    const { rows: tableRows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );
    const tables = new Set(tableRows.map((r) => r.name));
    const unclassified = [...tables].filter((t) => !keep.has(t) && !wipe.has(t));
    const missing = [...keep, ...wipe].filter((t) => !tables.has(t));
    if (unclassified.length > 0) {
      console.error(
        `✗ Unclassified table(s) — add each to a list in wipe-demo.ts:\n  ${unclassified.join('\n  ')}`,
      );
      process.exit(1);
    }
    if (missing.length > 0) {
      console.log(`  (not in this database, skipped: ${missing.join(', ')})`);
      for (const t of missing) {
        keep.delete(t);
        wipe.delete(t);
      }
    }

    // 2. Foreign keys, from the catalog.
    const { rows: fkRows } = await client.query<Fk>(
      `SELECT src.relname AS "from", dst.relname AS "to",
              array_agg(a.attname::text ORDER BY a.attnum) AS columns,
              bool_and(NOT a.attnotnull) AS nullable
         FROM pg_constraint k
         JOIN pg_class src ON src.oid = k.conrelid
         JOIN pg_class dst ON dst.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'f'
        GROUP BY k.oid, src.relname, dst.relname`,
    );

    const fatal = fkRows.filter((f) => keep.has(f.from) && wipe.has(f.to) && !f.nullable);
    if (fatal.length > 0) {
      console.error('✗ A kept table has a NOT NULL pointer into a wiped one — reclassify:');
      for (const f of fatal) console.error(`  ${f.from}(${f.columns.join(',')}) → ${f.to}`);
      process.exit(1);
    }

    // 3. Split the wipe set: TRUNCATE what nothing outside the set references;
    //    DELETE the rest. Grow the DELETE set to a fixed point, because a table
    //    moved out of the truncate set now counts as "outside" for its referents.
    const del = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const f of fkRows) {
        if (!wipe.has(f.to) || del.has(f.to) || f.from === f.to) continue;
        const fromOutside = keep.has(f.from) || del.has(f.from);
        if (fromOutside) {
          del.add(f.to);
          changed = true;
        }
      }
    }
    const truncate = [...wipe].filter((t) => !del.has(t)).sort();

    // DELETE order: a table is deleted only after every other DELETE-set table
    // that references it.
    const delOrder: string[] = [];
    const remaining = new Set(del);
    while (remaining.size > 0) {
      const next = [...remaining].filter(
        (t) => !fkRows.some((f) => f.to === t && f.from !== t && remaining.has(f.from)),
      );
      if (next.length === 0) {
        console.error(`✗ Foreign-key cycle among: ${[...remaining].join(', ')}`);
        process.exit(1);
      }
      for (const t of next.sort()) {
        delOrder.push(t);
        remaining.delete(t);
      }
    }

    const nullify = fkRows.filter((f) => keep.has(f.from) && wipe.has(f.to));

    await client.query('BEGIN');

    const count = async (t: string) =>
      Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);

    const tiers = [wipeCatalog && 'catalog', wipeHr && 'hr'].filter(Boolean).join(' + ');
    console.log(`\nDatabase: ${db}${tiers ? `   (also: ${tiers})` : ''}\n`);
    console.log('Pointers nulled in kept tables:');
    for (const f of nullify) {
      const where = f.columns.map((c) => `${c} IS NOT NULL`).join(' OR ');
      const set = f.columns.map((c) => `${c} = NULL`).join(', ');
      const res = await client.query(`UPDATE ${f.from} SET ${set} WHERE ${where}`);
      if (res.rowCount)
        console.log(`  ${f.from}.${f.columns.join(',')} → ${f.to}: ${res.rowCount}`);
    }

    // `company.profile.logoAttachmentId` points at attachments inside JSON, so
    // no FK protects it. Drop it when attachments go.
    if (wipe.has('attachments')) {
      const res = await client.query(
        `UPDATE settings SET value = value - 'logoAttachmentId'
          WHERE key = 'company.profile' AND value ? 'logoAttachmentId'`,
      );
      if (res.rowCount) console.log(`  settings company.profile.logoAttachmentId: ${res.rowCount}`);
    }

    console.log('\nEmptied:');
    let total = 0;
    const before = new Map<string, number>();
    for (const t of [...truncate, ...delOrder]) before.set(t, await count(t));

    if (truncate.length > 0) {
      await client.query(`TRUNCATE ${truncate.join(', ')}`);
    }
    for (const t of delOrder) await client.query(`DELETE FROM ${t}`);

    for (const [t, n] of [...before].sort()) {
      total += n;
      if (n > 0) console.log(`  ${t.padEnd(30)} ${n}${del.has(t) ? '  (delete)' : ''}`);
    }
    console.log(`  — ${total} rows in ${before.size} tables`);

    // Nothing may survive in a wiped table.
    for (const t of before.keys()) {
      const n = await count(t);
      if (n !== 0) throw new Error(`${t} still holds ${n} rows after the wipe`);
    }

    if (commit) {
      await client.query('COMMIT');
      // Dashboards read these; TRUNCATE does not refresh them.
      const { rows: mvs } = await client.query<{ name: string }>(
        `SELECT matviewname AS name FROM pg_matviews WHERE schemaname = 'public'`,
      );
      for (const mv of mvs) await client.query(`REFRESH MATERIALIZED VIEW ${mv.name}`);
      console.log(`\n✓ Committed. Refreshed ${mvs.length} materialized view(s).\n`);
    } else {
      await client.query('ROLLBACK');
      console.log('\n✓ Dry run — nothing was written. Re-run with --commit --confirm <db>.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n✗ Wipe failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
