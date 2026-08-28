/**
 * D-01 — per-agent test databases.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 * Every integration suite in this repo talks to ONE Postgres database. That is
 * fine for one developer and actively misleading for several agents working in
 * parallel: the suites share seeded rows, and a good number of them mutate
 * shared state (closing shifts, adjusting balances, flipping settings). When
 * two runs overlap, tests fail in files neither run touched, and the failures
 * look like real regressions in whatever the reader happens to be working on.
 *
 * That is not hypothetical. It cost a full stash/restore bisect during the
 * 2026-08-28 debt pass to establish that 19 failures came from a concurrent
 * session rather than from the change under review.
 *
 * ── WHY DATABASES, NOT SCHEMAS ───────────────────────────────────────────────
 * The register entry proposed per-agent SCHEMAS. Databases fit better here,
 * for reasons specific to this codebase rather than general preference:
 *
 *   * RLS policies, roles and grants (`app_user`, `mimi_app`, the
 *     `SECURITY DEFINER` helpers) are written unqualified. Per-schema
 *     isolation would mean every connection setting `search_path` correctly,
 *     forever, across ~15 test-support files — and one missed call silently
 *     reads the shared schema, which is the exact failure being fixed.
 *   * `CREATE DATABASE ... TEMPLATE` is a file-level copy. Cloning a fully
 *     migrated, fully seeded database takes about a second; replaying every
 *     migration plus the seed into a fresh schema takes minutes, per agent.
 *   * Nothing in the test code changes. Every connection already resolves
 *     through `POSTGRES_DB` / `DATABASE_URL` / `TEST_DATABASE_URL` /
 *     `DATABASE_MIGRATION_URL`, so pointing an agent at its own database is
 *     environment, not code.
 *
 * ── WHY A SEPARATE TEMPLATE ──────────────────────────────────────────────────
 * `CREATE DATABASE ... TEMPLATE x` fails while anything is connected to `x`,
 * and on a dev box the app holds a pool open against the working database — so
 * cloning from it directly would only work when the stack happened to be down.
 * `mimi_test_template` exists to be connected to by nothing but `template`.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   pnpm db:test:template            # build/refresh the template (slow, rare)
 *   pnpm db:test:clone <agent-name>  # fast per-agent copy; prints its env
 *   pnpm db:test:drop <agent-name>   # tear one down
 *   pnpm db:test:list                # what exists right now
 */
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { loadRepoEnv, migrationConnectionString, describeConnection } from './db-connection';

const TEMPLATE_DB = 'mimi_test_template';
const PREFIX = 'mimi_test_';

/**
 * The identifier goes into DDL that cannot be parameterised, so the input is
 * CONSTRAINED rather than escaped — a rejected name is easier to reason about
 * than a quoted one, and this is a developer tool where a clear refusal beats
 * accepting anything.
 */
function agentDbName(agent: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(agent)) {
    throw new Error(
      `Invalid agent name "${agent}". Letters, digits, '-' and '_' only (max 41 chars) — it becomes a database name.`,
    );
  }
  return `${PREFIX}${agent.toLowerCase().replace(/-/g, '_')}`;
}

/** Connects to `postgres`, never to a database this tool may be about to drop or clone. */
async function adminClient(): Promise<Client> {
  const url = new URL(migrationConnectionString('test-db'));
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function urlForDatabase(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function refreshTemplate(): Promise<void> {
  const base = migrationConnectionString('test-db');
  const admin = await adminClient();
  try {
    // DROP + CREATE rather than migrating in place: the template's whole value
    // is being a KNOWN state, and an incrementally-migrated one drifts from a
    // freshly-created one in precisely the ways hardest to notice.
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const templateUrl = urlForDatabase(base, TEMPLATE_DB);
  console.log(`Building ${TEMPLATE_DB} — ${describeConnection(templateUrl)}`);
  // The REAL tools, so the template cannot diverge from what `pnpm db:migrate`
  // and `pnpm db:seed` actually produce.
  const env = { ...process.env, DATABASE_MIGRATION_URL: templateUrl };
  execFileSync('pnpm', ['db:migrate'], { stdio: 'inherit', env, cwd: '..', shell: true });
  execFileSync('pnpm', ['db:seed'], { stdio: 'inherit', env, cwd: '..', shell: true });
  console.log(`\n✓ ${TEMPLATE_DB} ready. Clone it: pnpm db:test:clone <agent-name>`);
}

async function clone(agent: string): Promise<void> {
  const base = migrationConnectionString('test-db');
  const dbName = agentDbName(agent);
  const admin = await adminClient();
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB]);
    if (exists.rowCount === 0) {
      throw new Error(
        `${TEMPLATE_DB} does not exist. Run 'pnpm db:test:template' once before cloning.`,
      );
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(base, dbName);
  const appUrl = url.replace(/\/\/[^@]+@/, '//mimi_app:mimi_app_secret@');
  console.log(`✓ ${dbName} created from ${TEMPLATE_DB}\n`);
  console.log('Export these before running the integration suite:\n');
  // ALL FOUR. The suites are not consistent about which variable they read,
  // and one missed export silently points that connection back at the shared
  // database — reintroducing the bug while appearing isolated, which is worse
  // than not isolating at all.
  console.log(`  export POSTGRES_DB=${dbName}`);
  console.log(`  export DATABASE_MIGRATION_URL=${url}`);
  console.log(`  export DATABASE_URL=${appUrl}`);
  console.log(`  export TEST_DATABASE_URL=${appUrl}`);
}

async function drop(agent: string): Promise<void> {
  const dbName = agentDbName(agent);
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  console.log(`✓ ${dbName} dropped`);
}

async function list(): Promise<void> {
  const admin = await adminClient();
  try {
    const res = await admin.query<{ datname: string; size: string }>(
      `SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size
         FROM pg_database WHERE datname LIKE $1 ORDER BY datname`,
      [`${PREFIX}%`],
    );
    if (res.rowCount === 0) {
      console.log('No per-agent test databases. Create one: pnpm db:test:clone <agent-name>');
      return;
    }
    for (const row of res.rows) console.log(`  ${row.datname.padEnd(32)} ${row.size}`);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  loadRepoEnv();
  const [command, agent] = process.argv.slice(2);
  switch (command) {
    case 'template':
      return refreshTemplate();
    case 'clone':
      if (!agent) throw new Error('Usage: pnpm db:test:clone <agent-name>');
      return clone(agent);
    case 'drop':
      if (!agent) throw new Error('Usage: pnpm db:test:drop <agent-name>');
      return drop(agent);
    case 'list':
      return list();
    default:
      console.log('Usage: tsx test-db.ts <template|clone|drop|list> [agent-name]');
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
