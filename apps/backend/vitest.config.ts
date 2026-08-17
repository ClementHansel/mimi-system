import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'path';

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
const EXTRA_LIVE_DB_SPECS = [
  'src/common/guards/rls-context.guard.live-db.regression.spec.ts',
  'src/kernel/stock-ledger/stock-ledger.property.spec.ts',
  'src/modules/inventory/inventory.property.spec.ts',
  'src/modules/purchasing/payment-verifications-fulfilment-rls.spec.ts',
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
        },
      },
    ],
  },
});
