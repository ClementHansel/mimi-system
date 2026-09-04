import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { readFileSync } from 'node:fs';
import { resolve } from 'path';

/**
 * Every live-DB spec is gated on
 * `describe.skipIf(!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL)`.
 * Nothing loaded those: `.env` lives at the REPO ROOT, vitest's root is
 * `apps/backend`, and this repo has no `dotenv` anywhere — `.env` is read by
 * docker compose, and exported explicitly by `scripts/dev.sh` /
 * `scripts/deploy.sh`.
 *
 * So a plain `pnpm test` SILENTLY SKIPPED 21 files / 88 tests — every RLS
 * policy check, the approval-code integration suite, the cross-kernel specs —
 * and still printed a green "1307 passed". A suite that quietly stops testing
 * row-level security is worse than one that fails, because nobody investigates
 * a pass. With these vars present the same suite runs 121 files / 1395 tests,
 * all passing.
 *
 * Loaded here and handed to workers via `test.env` because `skipIf` is
 * evaluated in the WORKER process, not in this config's process.
 *
 * The non-override rule matters for the same reason it does in
 * `database/db-connection.ts` (the sibling implementation of this parser —
 * kept separate rather than cross-importing between packages for a build-time
 * helper): in CI or a container the real environment is authoritative and a
 * checked-out `.env` must never win.
 */
function repoEnvForTests(): Record<string, string> {
  let contents: string;
  try {
    contents = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Real environment wins — never overwrite what CI or a container set.
    if (process.env[key] !== undefined) continue;
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

const alias = {
  '@mimi/shared': resolve(__dirname, '../../packages/shared/src'),
  '@mimi/shared/': resolve(__dirname, '../../packages/shared/src') + '/',
  '@mimi/sync-protocol': resolve(__dirname, '../../packages/sync-protocol/src'),
  '@mimi/sync-protocol/': resolve(__dirname, '../../packages/sync-protocol/src') + '/',
};

// Live-DB integration suites all share ONE Postgres instance/schema (no per-suite
// database, no transactional rollback across the board — several self-commit via
// `db-tx.ts`'s `withWrite()`). Running them with vitest's default cross-FILE
// parallelism means several files mutate the very same seeded rows (shared "first
// item"/"first location" fixture picks) at the same time, which is what made this
// suite's pass/fail count non-deterministic between identical runs (QA-ISOLATION).
// Force this specific project to a single worker, single file at a time — real
// serialization, not just `--no-file-parallelism` someone has to remember to pass.
// The plain unit-test project below is untouched and stays fully parallel.
// Two naming conventions coexist in this codebase (`*.integration.spec.ts` AND
// `*.integration.test.ts` — e.g. `modules/pos/pos-shift-flow.integration.test.ts`), both of
// which hit the live DB. Both must be captured here or the `.test.ts` ones keep running
// under the parallel "unit" project and racing the live DB (this is exactly how
// `pos-shift-flow.integration.test.ts` surfaced a `stock_balances_pkey` duplicate-key error
// during this investigation — it was never actually a unit test).
// A handful of live-DB specs don't follow the `*.integration.spec|test.ts` naming convention
// at all (grepped for `DATABASE_MIGRATION_URL`/`getOwnerPool`/`live-db` imports across every
// spec/test file to find them) — still real Postgres, still needs serialization.
//
// The list below is REPRODUCIBLE, not curated by memory. Every live-DB spec
// imports `live-db`, `getOwnerPool`, or reads `DATABASE_MIGRATION_URL`, so
// grepping for those three markers across `src` and `test`, minus whatever
// `INTEGRATION_GLOBS` already matches, yields exactly this set. Re-run that grep
// when adding a live-DB spec: a file missing from here silently runs in the
// PARALLEL `unit` project and races the serialized ones.
//
// Not hypothetical. The seven specs added below were racing, and it surfaced as
// `return-gl-posting.spec.ts` failing with `StockInsufficientError ... would
// drive the balance negative` in full runs while passing alone: two files
// bootstrap the SAME (location, storage_area, item) balance via `ensureStock`
// (+100) and reconcile it back to the movement fold in `afterAll`, so run
// concurrently one file's cleanup deletes the other's bootstrap mid-test.
// Serializing is the fix; per-file fixture items would be the other one, at the
// cost of every spec inventing data instead of reading the seed.
const EXTRA_LIVE_DB_SPECS = [
  'src/common/guards/rls-context.guard.live-db.regression.spec.ts',
  'src/kernel/stock-ledger/stock-ledger.property.spec.ts',
  'src/kernel/stock-ledger/reconcile-opname.property.spec.ts',
  'src/modules/inventory/inventory.property.spec.ts',
  'src/modules/purchasing/payment-verifications-fulfilment-rls.spec.ts',
  'src/modules/purchasing/purchase-order-gl-posting.spec.ts',
  'src/modules/accounting/daily-posting.spec.ts',
  'src/modules/pos/pos-online-order-gl-posting.spec.ts',
  'src/modules/stock-opname/stock-opname-gl-posting.spec.ts',
  'src/modules/waste-return/return-gl-posting.spec.ts',
  'src/modules/waste-return/waste-gl-posting.spec.ts',
  // B-08 — boots the WHOLE app and binds a real socket. It must be serialized
  // for a stronger reason than the others: two of these running at once would
  // race for ports and for the same `audit_log` rows they count.
  'test/audit-http.e2e.spec.ts',
  // ── Added 2026-08-28 ────────────────────────────────────────────────────
  // These four were ALREADY live-DB specs and were ALREADY in the wrong
  // project; nobody could tell, because all four gate on
  // `describe.skipIf(!process.env.DATABASE_URL)` and nothing ever set that
  // variable (`.env` sits at the repo root, vitest's root is `apps/backend`).
  // They were skipped, so "runs in the parallel project" had no observable
  // consequence. The moment the env gating was fixed (see `repoEnvForTests`
  // above) they started running — concurrently with the serialized suites they
  // share a database with — and the symptom was one stock-opname test failing
  // per full run, a DIFFERENT one each time, while the whole stock-opname file
  // passed in isolation.
  //
  // The first opens its own `Pool`; the other three compile the real
  // `AppModule`, which stands up the production `DATABASE_POOL`. All four are
  // exactly what the grep described above is meant to catch.
  'src/common/database/system-context.live-db.regression.spec.ts',
  'test/app-boot.spec.ts',
  'test/no-double-api-prefix.spec.ts',
  'test/rbac-endpoint-sweep.spec.ts',
  // PREPAREs every static SQL statement in the source against the live schema.
  // Live-DB, and serialized like the rest: it opens its own owner pool and
  // holds one connection for ~1000 PREPARE/DEALLOCATE round-trips.
  'test/sql-parses.spec.ts',
  // Reads the seeded database and asserts no document sits in a decidable
  // state without an approval chain — the "gagal approve cuti" class.
  'test/decidable-documents-have-chains.spec.ts',
  // Pure source scan, no database — but it lives here so a single `pnpm test`
  // reports it alongside the suites it exists to protect.
  'test/write-endpoint-inventory.spec.ts',
  // Source scan for the DATE-through-UTC shift; no database needed, but it
  // belongs with the suites that protect the same class of defect.
  'test/date-only-through-utc.spec.ts',
];

const INTEGRATION_GLOBS = [
  'src/**/*.integration.spec.ts',
  'src/**/*.integration.test.ts',
  'test/cross-kernel/**/*.spec.ts',
  ...EXTRA_LIVE_DB_SPECS,
];

export default defineConfig({
  plugins: [swc.vite()],
  resolve: { alias },
  test: {
    globals: true,
    root: './',
    env: repoEnvForTests(),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...INTEGRATION_GLOBS, '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration-live-db',
          include: INTEGRATION_GLOBS,
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
          // Vitest's default 5s is a UNIT-test budget and it is the wrong one
          // here. These specs do real Postgres round-trips, and the fast-check
          // property suites (`stock-ledger.property`, `reconcile-opname.property`,
          // `inventory.property`) do ~100 generated cases each, several queries
          // per case; `test/audit-http.e2e.spec.ts` boots the whole app and
          // binds a socket.
          //
          // Alone they finish in ~5s — right at the limit. Under a full
          // `pnpm test`, where `pnpm -r` runs the frontend suite on the same
          // CPUs, they intermittently crossed it and reported
          // `Test timed out in 5000ms`. That reads exactly like a stock-ledger
          // defect and is not one: no assertion ever failed, and the same files
          // pass on a re-run. The serialization above fixes contention INSIDE
          // this project; it cannot do anything about another package's suite
          // running concurrently.
          //
          // A real regression here fails an assertion in milliseconds, so a
          // generous ceiling costs nothing in signal — it only stops a busy
          // machine from being reported as a bug.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
