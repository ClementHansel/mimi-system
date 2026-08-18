/**
 * Branch-node local migration runner — ported from `database/migrate.ts`'s
 * approach (BUILD-PLAN W2-F brief: "Reuse `database/migrate.ts`'s approach;
 * do not duplicate the cloud's full schema"). Same `schema_migrations`
 * tracking table, same numbered-file convention, scoped to this app's own
 * `migrations/` directory (§1.1's Tier-2 subset, not the cloud's ~95 tables).
 *
 * Exposed as a library function (`runMigrations`) so `pg-store.ts` can
 * bootstrap the embedded Postgres on startup, plus a thin CLI (`tsx
 * src/store/migrate.ts [--status]`) for manual ops parity with the cloud's
 * tooling.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export interface Migration {
  filename: string;
  version: string;
}

async function ensureMigrationsTable(client: pg.PoolClient | pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedVersions(client: pg.PoolClient | pg.Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((r) => r.version));
}

async function getPendingMigrations(
  client: pg.PoolClient | pg.Client,
  migrationsDir: string,
): Promise<Migration[]> {
  const applied = await getAppliedVersions(client);
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

  const pending: Migration[] = [];
  for (const filename of sqlFiles) {
    const version = filename.replace('.sql', '');
    if (!applied.has(version)) pending.push({ filename, version });
  }
  return pending;
}

async function runMigration(
  client: pg.PoolClient | pg.Client,
  migrationsDir: string,
  migration: Migration,
): Promise<void> {
  const filePath = join(migrationsDir, migration.filename);
  const sql = await readFile(filePath, 'utf-8');
  await client.query(sql);
  await client.query('INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)', [
    migration.version,
    migration.filename,
  ]);
}

/**
 * Applies every pending migration in `migrationsDir` against `client`, in
 * filename order, tracked in `schema_migrations`. Idempotent: re-running
 * against an up-to-date database is a no-op.
 */
export async function runMigrations(
  client: pg.PoolClient | pg.Client,
  migrationsDir: string = join(__dirname, '..', '..', 'migrations'),
): Promise<{ applied: string[] }> {
  await ensureMigrationsTable(client);
  const pending = await getPendingMigrations(client, migrationsDir);
  for (const migration of pending) {
    await runMigration(client, migrationsDir, migration);
  }
  return { applied: pending.map((m) => m.filename) };
}

export async function migrationStatus(
  client: pg.PoolClient | pg.Client,
  migrationsDir: string = join(__dirname, '..', '..', 'migrations'),
): Promise<{ filename: string; applied: boolean }[]> {
  await ensureMigrationsTable(client);
  const applied = await getAppliedVersions(client);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  return files.map((filename) => ({
    filename,
    applied: applied.has(filename.replace('.sql', '')),
  }));
}

async function cli(): Promise<void> {
  const connectionString =
    process.env.BRANCH_NODE_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://mimi:mimi_secret@localhost:5433/mimi_node';
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (process.argv.includes('--status')) {
      const status = await migrationStatus(client);
      for (const s of status)
        console.log(`  ${s.applied ? '✓ Applied' : '○ Pending'}  ${s.filename}`);
      return;
    }
    const { applied } = await runMigrations(client);
    console.log(
      applied.length === 0 ? 'Node database up to date.' : `Applied: ${applied.join(', ')}`,
    );
  } finally {
    await client.end();
  }
}

// Only run the CLI when this file is executed directly (not when imported by pg-store.ts).
if (require.main === module) {
  cli().catch((err) => {
    console.error('[branch-node] migration failed:', err);
    process.exitCode = 1;
  });
}
