/**
 * Applies the org model to an ALREADY-SEEDED database — the demo box, or a dev
 * database you do not want to reset.
 *
 * The model itself lives in `org-model.ts` and is also called by `seed.ts`, so a
 * freshly seeded database already IS this org and running this against one is a
 * no-op. This exists for the other case: a database with real transaction
 * history that predates a change to the crews, the regions or the roles.
 *
 * Usage:
 *   npx tsx database/simulate-org.ts            # apply
 *   npx tsx database/simulate-org.ts --dry-run  # report the plan, write nothing
 *
 * Environment: DATABASE_MIGRATION_URL — the DDL-owning role. Like `seed.ts`,
 * this writes to every table without setting any `app.*` session variable, so it
 * must NOT run as `mimi_app` (D-21/D-22).
 */

import pg from 'pg';
import { applyOrgModel, describeOrg, CREW, SHIFTS, DEMO_PASSWORD, DEMO_PIN } from './org-model.js';
import { migrationConnectionString } from './db-connection';

const { Client } = pg;

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const connectionString =
    migrationConnectionString('db:simulate:org');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    console.log(`\nOrg model — ${dryRun ? 'DRY RUN, nothing will be written' : 'applying'}\n`);
    console.log(`  crew per shift   ${CREW.map((c) => c.position).join(' + ')}`);
    console.log(`  shifts           ${SHIFTS.join(', ')}\n`);

    const result = await applyOrgModel(client);
    console.log('Result\n');
    for (const line of result.summary) console.log(`  - ${line}`);

    // Reported BEFORE the commit-or-rollback below, deliberately: a dry run has
    // to describe the org it WOULD produce, not the one it is about to roll back
    // to. Reporting afterwards printed the old shape under a heading that said
    // "Result", which is worse than printing nothing.
    await describeOrg(client);

    if (dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log(
      `\n  Login: any username above / "${DEMO_PASSWORD}"` +
        `  (PIN "${DEMO_PIN}" for owner, manager, supervisor, kasir, gudang)`,
    );
    console.log('  Crew usernames read <slot>_<outlet>_<shift>, e.g. spv_bpp01_p, koki2_smd03_m');
    if (dryRun) console.log('\nDRY RUN — rolled back, nothing was written.');
    console.log('');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('\nOrg model failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
