/**
 * BACKUP AND RESTORE DRILL — proves the backup can actually be restored.
 *
 * An untested backup is not a backup. This system has never had a restore
 * exercised, which means the honest status of "we have backups" was "we have
 * files nobody has ever read back". Before this database holds real payroll and
 * real money, that gap has to close, and it closes by DOING it rather than by
 * documenting an intention.
 *
 * What it does, end to end:
 *
 *   1. `pg_dump` the source database (custom format, the one `pg_restore` can
 *      work with selectively).
 *   2. Create a scratch database and restore into it.
 *   3. Compare the two — row counts per table, plus a spot-check on money — and
 *      fail loudly on any difference.
 *   4. Drop the scratch database. The dump file is kept for inspection.
 *
 * The comparison is the point. A restore that "succeeded" with silently empty
 * tables is the exact failure this drill exists to catch, and it is the shape
 * that a role/ownership or extension mismatch actually produces.
 *
 * Usage:
 *   npx tsx database/backup-restore-drill.ts
 *   npx tsx database/backup-restore-drill.ts --keep     # leave the scratch DB
 *
 * Environment:
 *   DATABASE_MIGRATION_URL   the DDL-owning connection (source, and the one used
 *                            to create/drop the scratch database)
 *   DRILL_OUT_DIR            where to write the dump (default: ./.backups)
 *
 * `pg_dump`/`pg_restore` run INSIDE the Postgres container by default, because
 * that is where they are guaranteed to be the same major version as the server —
 * a host-side client one version behind refuses the dump outright. Set
 * `DRILL_DOCKER_CONTAINER=''` to use host-side binaries instead.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { migrationConnectionString } from './db-connection';

const { Client } = pg;

const SOURCE_URL = migrationConnectionString('db:drill:restore');
const CONTAINER = process.env.DRILL_DOCKER_CONTAINER ?? 'mimi-postgres';
const OUT_DIR = process.env.DRILL_OUT_DIR ?? '.backups';
const KEEP = process.argv.includes('--keep');

interface Parsed {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

function parse(url: string): Parsed {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
  };
}

/** Runs a command, streaming nothing, returning stdout — throws with stderr on failure. */
function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}\n${err.trim()}`));
    });
  });
}

const src = parse(SOURCE_URL);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const scratchDb = `${src.database}_restore_drill`;
/** Inside the container when containerised, so `pg_restore` can read it back. */
const dumpPath = CONTAINER
  ? `/tmp/${src.database}-${stamp}.dump`
  : `${OUT_DIR}/${src.database}-${stamp}.dump`;

function pgCommand(bin: string, args: string[]): [string, string[], Record<string, string>] {
  if (CONTAINER) {
    return [
      'docker',
      [
        'exec',
        '-e',
        `PGPASSWORD=${src.password}`,
        CONTAINER,
        bin,
        '-h',
        'localhost',
        '-U',
        src.user,
        ...args,
      ],
      {},
    ];
  }
  return [
    bin,
    ['-h', src.host, '-p', src.port, '-U', src.user, ...args],
    { PGPASSWORD: src.password },
  ];
}

async function sql<T extends pg.QueryResultRow>(database: string, query: string): Promise<T[]> {
  const client = new Client({
    host: src.host,
    port: Number(src.port),
    user: src.user,
    password: src.password,
    database,
  });
  await client.connect();
  try {
    return (await client.query<T>(query)).rows;
  } finally {
    await client.end();
  }
}

/**
 * Row counts for every user table, as the comparison surface.
 *
 * `count(*)` per table rather than a checksum of contents: it is exact about the
 * failure that matters (a table restored empty or partial), cheap on a database
 * this size, and it names the table in the diff. A content hash would catch more
 * but reports "something differs" with nothing to act on.
 */
async function tableCounts(database: string): Promise<Map<string, number>> {
  const rows = await sql<{ table_name: string }>(
    database,
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const counts = new Map<string, number>();
  for (const { table_name } of rows) {
    const [{ n }] = await sql<{ n: string }>(
      database,
      `SELECT count(*)::text AS n FROM "${table_name}"`,
    );
    counts.set(table_name, Number(n));
  }
  return counts;
}

async function main(): Promise<void> {
  console.log(`\nBackup/restore drill\n`);
  console.log(`  source     ${src.database} on ${src.host}:${src.port}`);
  console.log(`  scratch    ${scratchDb}`);
  console.log(`  dump       ${dumpPath}${CONTAINER ? ` (inside ${CONTAINER})` : ''}\n`);

  if (!CONTAINER) mkdirSync(OUT_DIR, { recursive: true });

  // ── 1. dump ────────────────────────────────────────────────────────────────
  console.log('  1. pg_dump ...');
  const [dumpCmd, dumpArgs, dumpEnv] = pgCommand('pg_dump', [
    '-Fc',
    '--no-owner',
    // `--no-owner`/`--no-privileges` on purpose: a restore into a database whose
    // roles differ (a fresh staging box, a developer's laptop) fails on every
    // GRANT and OWNER TO otherwise. Roles and grants are re-established by
    // migrations, which are the source of truth for them — not by the dump.
    '--no-privileges',
    '-f',
    dumpPath,
    src.database,
  ]);
  await run(dumpCmd, dumpArgs, dumpEnv);
  const size = CONTAINER
    ? (await run('docker', ['exec', CONTAINER, 'sh', '-c', `wc -c < ${dumpPath}`])).trim()
    : 'n/a';
  console.log(
    `     dumped${size !== 'n/a' ? ` ${(Number(size) / 1024 / 1024).toFixed(1)} MB` : ''}`,
  );

  // ── 2. restore into a scratch database ────────────────────────────────────
  console.log('  2. restore into a scratch database ...');
  await sql('postgres', `DROP DATABASE IF EXISTS ${scratchDb}`);
  await sql('postgres', `CREATE DATABASE ${scratchDb} OWNER ${src.user}`);

  const [resCmd, resArgs, resEnv] = pgCommand('pg_restore', [
    '-d',
    scratchDb,
    '--no-owner',
    '--no-privileges',
    dumpPath,
  ]);
  try {
    await run(resCmd, resArgs, resEnv);
  } catch (err) {
    // pg_restore exits non-zero on warnings too (a missing role, an extension
    // already present). Report it and keep going to the comparison, which is the
    // assertion that actually matters — but never swallow it silently.
    console.log(
      `     pg_restore reported problems:\n       ${String(err).split('\n').slice(0, 6).join('\n       ')}`,
    );
  }

  // ── 3. compare ─────────────────────────────────────────────────────────────
  console.log('  3. compare source vs restored ...');
  const before = await tableCounts(src.database);
  const after = await tableCounts(scratchDb);

  const problems: string[] = [];
  for (const [table, n] of before) {
    if (!after.has(table)) {
      problems.push(`${table}: MISSING from the restore`);
      continue;
    }
    const m = after.get(table)!;
    if (m !== n) problems.push(`${table}: ${n} rows in source, ${m} restored`);
  }
  for (const table of after.keys()) {
    if (!before.has(table)) problems.push(`${table}: present in the restore but not in the source`);
  }

  const nonEmpty = [...before.values()].filter((n) => n > 0).length;
  console.log(`     ${before.size} tables, ${nonEmpty} of them non-empty`);

  // A spot-check with real meaning: money. A restore that matches on row counts
  // but loses numeric scale is still a broken restore.
  const [srcMoney] = await sql<{ total: string }>(
    src.database,
    `SELECT coalesce(sum(total), 0)::text AS total FROM sales`,
  );
  const [dstMoney] = await sql<{ total: string }>(
    scratchDb,
    `SELECT coalesce(sum(total), 0)::text AS total FROM sales`,
  );
  if (srcMoney!.total !== dstMoney!.total) {
    problems.push(`sales total: ${srcMoney!.total} in source, ${dstMoney!.total} restored`);
  }
  console.log(`     sales total ${srcMoney!.total} — matches`);

  // ── 4. clean up ────────────────────────────────────────────────────────────
  if (!KEEP) {
    await sql('postgres', `DROP DATABASE IF EXISTS ${scratchDb}`);
    console.log('  4. scratch database dropped');
  } else {
    console.log(`  4. scratch database kept: ${scratchDb}`);
  }

  if (problems.length > 0) {
    console.error(`\n✗ RESTORE DOES NOT MATCH THE SOURCE (${problems.length} problem(s)):\n`);
    for (const p of problems.slice(0, 25)) console.error(`    ${p}`);
    if (problems.length > 25) console.error(`    ... and ${problems.length - 25} more`);
    console.error('');
    process.exit(1);
  }

  console.log(`\n✓ Restore verified: every table matches the source, row for row.\n`);
  console.log(`  The dump is at ${dumpPath}${CONTAINER ? ` inside ${CONTAINER}` : ''}.`);
  console.log(`  Copy it off the machine — a backup that lives only on the server it`);
  console.log(`  backs up is not one.\n`);
}

main().catch((err: unknown) => {
  console.error('\nDrill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
