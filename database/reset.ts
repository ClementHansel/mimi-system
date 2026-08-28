/**
 * Database Reset Script — Mimi Chicken Operational System
 *
 * Drops the public schema (all tables, views, roles-owned objects within it)
 * and recreates it empty. Run migrate + seed afterwards. Development use only.
 *
 * Usage:
 *   npx tsx database/reset.ts
 *
 * Environment:
 *   DATABASE_MIGRATION_URL - PostgreSQL connection string for the DDL-owning
 *                  (superuser/owner) role — dropping/recreating the schema
 *                  needs owner rights the runtime `mimi_app` role
 *                  (DATABASE_URL) does not have. See D-21/D-22 in
 *                  docs/BUILD-PLAN.md and database/README.md.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { migrationConnectionString } from './db-connection';

const { Client } = pg;

function runStep(label: string, scriptFile: string): void {
  console.log(`\n→ ${label}...\n`);
  const scriptPath = join(import.meta.dirname ?? __dirname, scriptFile);
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\n✗ Step failed: ${label}\n`);
    process.exit(result.status ?? 1);
  }
}

async function reset(): Promise<void> {
  const connectionString = migrationConnectionString('db:reset');

  // Safety check: refuse to run on production-like URLs
  if (connectionString.includes('production') || connectionString.includes('prod')) {
    console.error('✗ Refusing to reset a production database!');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log('\n⚠ Resetting database (dropping public schema)...\n');

    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO public;
    `);

    console.log('  ✓ Schema dropped and recreated');
  } catch (error) {
    console.error('\n✗ Reset failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }

  // End-to-end: schema is empty at this point — bring it all the way back up.
  runStep('Applying migrations', 'migrate.ts');
  runStep('Loading seed data', 'seed.ts');

  console.log('\n✓ Reset complete: schema recreated, migrated, and seeded.\n');
}

reset();
