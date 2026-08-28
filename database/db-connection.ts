/**
 * ONE place that answers "which database does this tool talk to?".
 *
 * ── THE BUG THIS EXISTS TO KILL ──────────────────────────────────────────────
 * Nine tools in this directory — `migrate`, `reset`, `seed`, `seed-history`,
 * `import`, `simulate-org`, `fix-recipe-quantities`, `backup-restore-drill` —
 * each carried their own copy of this line:
 *
 *     process.env.DATABASE_MIGRATION_URL || 'postgresql://mimi:mimi_secret@localhost:5432/mimi'
 *
 * Nothing in this repo loads `.env` into `process.env` for host-run tooling.
 * `.env` is read by DOCKER COMPOSE (for `${VAR}` interpolation) and, on the two
 * supported paths, exported explicitly: `scripts/dev.sh` does `set -a; source
 * .env` before `pnpm db:migrate`, and `scripts/deploy.sh` passes
 * `-e DATABASE_MIGRATION_URL=…` into a one-shot container. Both are correct.
 *
 * But anyone running `pnpm db:migrate` / `db:reset` directly on the host gets
 * NEITHER, so every one of those tools silently fell back to `localhost:5432`
 * — and `.env` on a developer machine may deliberately publish Postgres
 * somewhere else (here: `POSTGRES_PORT=55433`, because "a native Postgres
 * already listens on 5432 on this machine", as `.env` itself says).
 *
 * So the fallback did not point at "the project database, probably". It
 * pointed at A DIFFERENT SERVER THAT HAPPENS TO BE RUNNING. For `migrate` that
 * is a confusing failure. For `reset.ts`, which DROPS THE PUBLIC SCHEMA, it is
 * a loaded gun aimed at whatever unrelated database is on 5432 — and it would
 * only fire on the machines where the fallback was most wrong.
 * `scripts/dev.sh`'s own comment already refused to trust it ("rather than
 * relying on any in-script fallback default staying in sync").
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
 * Resolution order, first hit wins:
 *
 *   1. `DATABASE_MIGRATION_URL` already in the environment. Containers, CI and
 *      `dev.sh`/`deploy.sh` all set it, so THE SERVER SETUPS ARE UNCHANGED —
 *      real environment always beats a file, which is why step 2 never
 *      overrides.
 *   2. the repo-root `.env`, loaded non-destructively, for host-run tooling.
 *      This is the convenience that was missing.
 *   3. assembled from `POSTGRES_*` parts (including `POSTGRES_PORT`) if those
 *      are present, since compose already treats them as the source of truth.
 *   4. NOTHING. It throws, naming the variable and the two supported ways to
 *      set it.
 *
 * Step 4 is the point. A tool that cannot tell which database it is pointed at
 * must stop, not guess: the failure mode of guessing wrong is silent and
 * destructive, while the failure mode of stopping is a message on a terminal.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `database/` sits one level below the repo root, where `.env` lives. */
const REPO_ROOT = dirname(import.meta.dirname ?? __dirname);
const ENV_FILE = join(REPO_ROOT, '.env');

/**
 * Minimal `.env` parser — deliberately not a dependency. This repo has NO
 * `dotenv` anywhere (checked), and adding one to read six keys would be the
 * kind of lockfile churn `xlsx-writer.util.ts` and `lib/export/pdf.ts` already
 * record talking themselves out of.
 *
 * Handles what this project's `.env` actually contains: `KEY=value`, `#`
 * comments, blank lines, optional surrounding quotes, and values containing
 * `:` `@` `/` `=` (connection strings and passwords). It does NOT do variable
 * interpolation or multi-line values — compose does not use them here, and a
 * half-implemented interpolation that silently differs from compose's would be
 * worse than none.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Merge the repo-root `.env` into `process.env` WITHOUT overwriting anything
 * already set.
 *
 * The non-overwrite rule is load-bearing, not politeness: inside a container
 * the real `DATABASE_URL` is injected by compose and points at the `postgres`
 * SERVICE on its internal port, while a `.env` copied into the image would
 * still say `localhost:55433`. Letting the file win would break exactly the
 * server setups this is meant to fit. Missing file is not an error — that is
 * the normal container case.
 */
export function loadRepoEnv(): void {
  let contents: string;
  try {
    contents = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(contents))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Build an owner connection string from the `POSTGRES_*` parts compose also uses. */
function fromPostgresParts(env: NodeJS.ProcessEnv): string | null {
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) return null;
  const host = env.POSTGRES_HOST ?? 'localhost';
  // No `?? 5432` default: the whole failure this file exists to prevent was a
  // confidently-wrong port. If the parts are present, the port is among them.
  const port = env.POSTGRES_PORT;
  if (!port) return null;
  return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
    POSTGRES_PASSWORD,
  )}@${host}:${port}/${POSTGRES_DB}`;
}

class MissingDatabaseUrlError extends Error {
  constructor(tool: string) {
    super(
      `${tool}: DATABASE_MIGRATION_URL is not set, and no .env was found to read it from.\n` +
        `\n` +
        `This tool refuses to guess a connection string. The previous default\n` +
        `(localhost:5432) pointed at whatever Postgres happened to be running,\n` +
        `which on a machine that publishes the project's Postgres elsewhere is a\n` +
        `DIFFERENT database — and some of these tools drop the schema.\n` +
        `\n` +
        `Set it one of the supported ways:\n` +
        `  • host:      set -a; source .env; set +a   (what scripts/dev.sh does)\n` +
        `  • one-off:   DATABASE_MIGRATION_URL=postgresql://user:pass@host:port/db pnpm db:migrate\n` +
        `  • server:    scripts/deploy.sh passes it into the migration container`,
    );
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * The DDL-owning connection every tool in this directory should use.
 *
 * `tool` names the caller in the error, so a failure says which command to fix
 * rather than just naming a variable.
 *
 * NOTE the role this returns is the OWNER (D-21/D-22). It is never the
 * backend's runtime `mimi_app` connection: `mimi_app` deliberately lacks the
 * rights to run DDL, and connecting as an owner from the app would silently
 * bypass FORCE ROW LEVEL SECURITY.
 */
export function migrationConnectionString(tool: string): string {
  if (process.env.DATABASE_MIGRATION_URL) return process.env.DATABASE_MIGRATION_URL;
  loadRepoEnv();
  if (process.env.DATABASE_MIGRATION_URL) return process.env.DATABASE_MIGRATION_URL;
  const assembled = fromPostgresParts(process.env);
  if (assembled) return assembled;
  throw new MissingDatabaseUrlError(tool);
}

/**
 * Host and database only — for a log line that says which server a destructive
 * tool is about to act on, without printing the password into a terminal
 * scrollback or a CI log.
 */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}
