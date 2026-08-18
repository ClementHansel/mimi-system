/**
 * Live-DB integration suite for the D-18 statutory payroll wizard
 * (CONTRACTS.md §4.15, shipped under `/api/settings/statutory/*` per this
 * agent's report on the CONTRACTS-path deviation). Runs against the REAL
 * `mimi_app` pool.
 *
 * BE-TXN-ROLLBACK: every mutating `StatutoryService` method now wraps its
 * writes in `withWrite` (real `BEGIN...COMMIT`) — see `settings/db-tx.ts`'s
 * doc comment. That `COMMIT` ends whatever transaction `withRollback` opened
 * and reverts `SET LOCAL ROLE`/session GUCs with it (Postgres reverts ALL
 * transaction-local state at COMMIT, not only at ROLLBACK) — so a test that
 * chains two mutating calls (or a mutating call followed by a plain read) on
 * ONE `withRollback` connection now fails `permission denied for table ...`
 * on the second call. Every multi-step test below therefore opens a
 * SEPARATE `asRequest`/`withRollback` connection per mutating call — exactly
 * `stock-opname`'s regression-suite shape (see
 * `stock-opname/test-support/live-db.ts`'s `asRequest` doc comment) — and,
 * because these writes now genuinely commit REAL rows in
 * `bpjs_configs`/`pph21_ter_rates`/`pph21_ptkp`/`employee_tax_profiles`/
 * `settings['payroll.statutory']`, every such test cleans its own rows up in
 * a `finally` block so a second run of this suite (or a later test in the
 * same run) never collides with `ERR_EFFECTIVE_OVERLAP` on stale data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { asRequest, closeTestPool, fetchOneUserId, getAppPool, getOwnerPool, withRollback } from '../auth/test-support/live-db';
import { SettingsRepository } from './settings.repository';
import { StatutoryRepository } from './statutory.repository';
import { StatutoryService } from './statutory.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';

function buildService(): StatutoryService {
  const pool = getAppPool();
  const events = new SyncEventsRepository(pool);
  const syncEmit = new SyncEmitService(events, new ConflictDetectorService(events, new SyncConflictsRepository()));
  return new StatutoryService(new StatutoryRepository(), new SettingsRepository(), syncEmit);
}

let CALLER: { sub: string };
let employeeId: string;

beforeAll(async () => {
  const owner = await fetchOneUserId('owner');
  CALLER = { sub: owner.id };
  const res = await getOwnerPool().query<{ id: string }>(`SELECT id FROM employees LIMIT 1`);
  if (!res.rows[0]) throw new Error('Test fixture requires at least one seeded employee');
  employeeId = res.rows[0].id;
});

afterAll(async () => {
  await closeTestPool();
});

/** Deletes every row this suite's committed writes could have created for a given effectiveFrom marker. */
async function cleanupStatutoryRows(effectiveFrom: string): Promise<void> {
  const owner = getOwnerPool();
  await owner.query(`DELETE FROM bpjs_configs WHERE effective_from = $1`, [effectiveFrom]);
  await owner.query(`DELETE FROM pph21_ter_rates WHERE effective_from = $1`, [effectiveFrom]);
  await owner.query(`DELETE FROM pph21_ptkp WHERE effective_from = $1`, [effectiveFrom]);
  await owner.query(`DELETE FROM pph21_article17_brackets WHERE effective_from = $1`, [effectiveFrom]);
  // `closeXxx` only ever moves a PRE-EXISTING open window's `effective_to` forward to this
  // marker — reverting it to NULL restores whatever window this suite's write closed.
  await owner.query(`UPDATE bpjs_configs SET effective_to = NULL WHERE effective_to = $1`, [effectiveFrom]);
  await owner.query(`UPDATE pph21_ter_rates SET effective_to = NULL WHERE effective_to = $1`, [effectiveFrom]);
  await owner.query(`UPDATE pph21_ptkp SET effective_to = NULL WHERE effective_to = $1`, [effectiveFrom]);
  await owner.query(`UPDATE pph21_article17_brackets SET effective_to = NULL WHERE effective_to = $1`, [effectiveFrom]);
}

async function resetTaxProfile(): Promise<void> {
  await getOwnerPool().query(`DELETE FROM employee_tax_profiles WHERE employee_id = $1`, [employeeId]);
}

async function resetStatutoryGate(): Promise<void> {
  await getOwnerPool().query(
    `UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb, updated_by = NULL WHERE key = 'payroll.statutory'`,
  );
}

/**
 * Empties the four statutory tables the readiness check counts, INSIDE the
 * caller's rollback transaction so nothing is destroyed for real.
 *
 * Needed since the seed began installing statutory config (PTKP, TER, BPJS and
 * a tax profile per employee) so PPh21 can actually be exercised on a demo
 * box. These tests assert the behaviour of an UNCONFIGURED install, which is
 * now a state no seeded environment is in — so the state has to be arranged
 * rather than assumed. Doing it on the transaction-scoped client means the
 * ROLLBACK in `withRollback` puts the seeded rows straight back.
 */
async function emptyStatutoryTablesInTx(client: PoolClient): Promise<void> {
  await client.query('DELETE FROM employee_tax_profiles');
  await client.query('DELETE FROM bpjs_configs');
  await client.query('DELETE FROM pph21_ter_rates');
  await client.query('DELETE FROM pph21_ptkp');
}

describe('StatutoryService.status — the wizard readiness check', () => {
  it('reports NOT ready with all four pieces missing on a fresh (unconfigured) install', async () => {
    await withRollback(async (client) => {
      await emptyStatutoryTablesInTx(client);
      const status = await buildService().status(client);
      expect(status.enabled).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.missing.sort()).toEqual(['bpjs_configs', 'employee_tax_profiles', 'pph21_ptkp', 'pph21_ter_rates']);
    });
  });

  it('becomes ready once BPJS (all 5 programs), TER (all 3 categories), PTKP, and one tax profile exist', async () => {
    const effectiveFrom = '2091-01-01';
    try {
      await asRequest((client) =>
        buildService().putBpjs(
          {
            rows: (['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const).map((program) => ({
              program,
              employerPct: '4.000',
              employeePct: '1.000',
              effectiveFrom,
            })),
          },
          client,
        ),
      );

      await asRequest((client) =>
        buildService().putTer(
          {
            effectiveFrom,
            rows: [
              { category: 'A', bracketMin: '0.00', bracketMax: '5400000.00', ratePct: '0.000' },
              { category: 'A', bracketMin: '5400000.00', bracketMax: null as unknown as string, ratePct: '5.000' },
              { category: 'B', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
              { category: 'C', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            ],
          },
          client,
        ),
      );

      await asRequest((client) => buildService().putPtkp({ effectiveFrom, rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client));

      await asRequest((client) => buildService().putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 0, npwp: null }, CALLER, client));

      const status = await withRollback((client) => buildService().status(client));
      expect(status.missing).toEqual([]);
      expect(status.ready).toBe(true);
      expect(status.profileCoverage.withProfile).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
      await resetTaxProfile();
    }
  });
});

describe('StatutoryService — BPJS effective-dated overlap (ERR_EFFECTIVE_OVERLAP)', () => {
  it('auto-closes the prior open window when a later effectiveFrom is inserted', async () => {
    const first = '2092-01-01';
    const second = '2093-01-01';
    try {
      await asRequest((client) => buildService().putBpjs({ rows: [{ program: 'kesehatan', employerPct: '4.000', employeePct: '1.000', effectiveFrom: first }] }, client));
      await asRequest((client) => buildService().putBpjs({ rows: [{ program: 'kesehatan', employerPct: '4.500', employeePct: '1.000', effectiveFrom: second }] }, client));

      const rows = await withRollback((client) => buildService().listBpjs(client, 'kesehatan'));
      const closed = rows.find((r) => r.effectiveFrom === first);
      const open = rows.find((r) => r.effectiveFrom === second);
      expect(closed?.effectiveTo).toBe(second);
      expect(open?.effectiveTo).toBeNull();
    } finally {
      await cleanupStatutoryRows(first);
      await cleanupStatutoryRows(second);
    }
  });

  it('rejects a new window starting at-or-before the currently open window (ERR_EFFECTIVE_OVERLAP)', async () => {
    const effectiveFrom = '2094-06-01';
    try {
      await asRequest((client) => buildService().putBpjs({ rows: [{ program: 'jht', employerPct: '3.700', employeePct: '2.000', effectiveFrom }] }, client));
      await withRollback(async (client) => {
        await expect(
          buildService().putBpjs({ rows: [{ program: 'jht', employerPct: '3.700', employeePct: '2.000', effectiveFrom: '2094-01-01' }] }, client),
        ).rejects.toMatchObject({ response: { code: 'ERR_EFFECTIVE_OVERLAP' } });
      });
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
    }
  });
});

describe('StatutoryService — PPh21 TER bracket contiguity (ERR_BRACKET_GAP)', () => {
  it('rejects a gap between brackets within one category', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putTer(
          {
            effectiveFrom: '2095-01-01',
            rows: [
              { category: 'A', bracketMin: '0.00', bracketMax: '5000000.00', ratePct: '0.000' },
              // gap: next bracket should start at 5000000.00, starts at 6000000.00 instead
              { category: 'A', bracketMin: '6000000.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_BRACKET_GAP' } });
    });
  });

  it('rejects a category not starting at 0', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putTer(
          { effectiveFrom: '2095-01-01', rows: [{ category: 'B', bracketMin: '100.00', bracketMax: null as unknown as string, ratePct: '5.000' }] },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_BRACKET_GAP' } });
    });
  });

  it('accepts a valid contiguous multi-bracket category', async () => {
    const effectiveFrom = '2096-01-01';
    try {
      const rows = await asRequest((client) =>
        buildService().putTer(
          {
            effectiveFrom,
            rows: [
              { category: 'A', bracketMin: '0.00', bracketMax: '5400000.00', ratePct: '0.000' },
              { category: 'A', bracketMin: '5400000.00', bracketMax: '10000000.00', ratePct: '5.000' },
              { category: 'A', bracketMin: '10000000.00', bracketMax: null as unknown as string, ratePct: '15.000' },
            ],
          },
          client,
        ),
      );
      // `putTer` returns every row for the categories it touched, not just the
      // ones this call wrote — and the seed now ships a full TER ladder — so
      // assert on THIS write's own effective window rather than the table total.
      expect(rows.filter((r) => r.effectiveFrom === effectiveFrom)).toHaveLength(3);
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
    }
  });
});

describe('StatutoryService — PPh21 Article 17 (ERR_BRACKET_GAP, top bracket must be open-ended)', () => {
  it('rejects a closed top bracket', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putArticle17(
          { effectiveFrom: '2097-01-01', rows: [{ bracketMin: '0.00', bracketMax: '60000000.00', ratePct: '5.000' }] },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_BRACKET_GAP' } });
    });
  });

  it('accepts the real 2022 national schedule shape (5/15/25/30/35, open-ended top)', async () => {
    const effectiveFrom = '2098-01-01';
    try {
      const rows = await asRequest((client) =>
        buildService().putArticle17(
          {
            effectiveFrom,
            rows: [
              { bracketMin: '0.00', bracketMax: '60000000.00', ratePct: '5.000' },
              { bracketMin: '60000000.00', bracketMax: '250000000.00', ratePct: '15.000' },
              { bracketMin: '250000000.00', bracketMax: '500000000.00', ratePct: '25.000' },
              { bracketMin: '500000000.00', bracketMax: '5000000000.00', ratePct: '30.000' },
              { bracketMin: '5000000000.00', bracketMax: null as unknown as string, ratePct: '35.000' },
            ],
          },
          client,
        ),
      );
      // migration 200 already seeds the 2022 schedule (open-ended) — listArticle17()
      // with no `asOf` filter returns full history, so filter to the NEW window.
      const newRows = rows.filter((r) => r.effectiveFrom === effectiveFrom);
      expect(newRows).toHaveLength(5);
      expect(newRows.find((r) => r.bracketMin === '5000000000.00')?.bracketMax).toBeNull();
      // and the PRE-EXISTING seeded window was auto-closed at the new effectiveFrom.
      const oldRows = rows.filter((r) => r.effectiveFrom === '2022-01-01');
      expect(oldRows.every((r) => r.effectiveTo === effectiveFrom)).toBe(true);
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
    }
  });
});

describe('StatutoryService.enable — gated by readiness (ERR_STATUTORY_NOT_READY)', () => {
  it('rejects enabling when setup is incomplete', async () => {
    await withRollback(async (client) => {
      await emptyStatutoryTablesInTx(client);
      await expect(buildService().enable({ confirm: true }, CALLER, client)).rejects.toMatchObject({ response: { code: 'ERR_STATUTORY_NOT_READY' } });
    });
  });

  it('succeeds once ready, records enabledBy/enabledAt, and disable reverts the gate', async () => {
    const effectiveFrom = '2099-01-01';
    try {
      await asRequest((client) =>
        buildService().putBpjs(
          {
            rows: (['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const).map((program) => ({
              program,
              employerPct: '4.000',
              employeePct: '1.000',
              effectiveFrom,
            })),
          },
          client,
        ),
      );
      await asRequest((client) =>
        buildService().putTer(
          {
            effectiveFrom,
            rows: [
              { category: 'A', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
              { category: 'B', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
              { category: 'C', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            ],
          },
          client,
        ),
      );
      await asRequest((client) => buildService().putPtkp({ effectiveFrom, rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client));
      await asRequest((client) => buildService().putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 0, npwp: null }, CALLER, client));

      // BE-TXN-ROLLBACK regression: `enable`/`disable` now really commit — the whole point of
      // this test. Each is its own connection; the assertion reads the return value of that
      // SAME call (not a later read on the same connection), which is safe.
      const enabled = await asRequest((client) => buildService().enable({ confirm: true }, CALLER, client));
      expect(enabled.enabled).toBe(true);
      expect(enabled.enabledAt).toBeTruthy();
      expect(enabled.enabledBy).toBeTruthy();

      const disabled = await asRequest((client) => buildService().disable({ reason: 'test teardown' }, CALLER, client));
      expect(disabled.enabled).toBe(false);
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
      await resetTaxProfile();
      await resetStatutoryGate();
    }
  });
});

describe('StatutoryService — employee tax profile', () => {
  it('404s for an unknown employee', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().getTaxProfile('00000000-0000-0000-0000-000000000000', client),
      ).rejects.toMatchObject({ response: { code: 'ERR_NOT_FOUND' } });
    });
  });

  it('rejects a ptkpCode that is not currently effective', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putTaxProfile(employeeId, { ptkpCode: 'NOT/A/CODE', dependantsCount: 0, npwp: null }, CALLER, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('upserts a valid profile and reads it back — verified via a SEPARATE connection', async () => {
    const effectiveFrom = '2100-01-01';
    try {
      await asRequest((client) => buildService().putPtkp({ effectiveFrom, rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client));
      const profile = await asRequest((client) =>
        buildService().putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 2, npwp: '12.345.678.9-012.345' }, CALLER, client),
      );
      expect(profile.dependantsCount).toBe(2);
      expect(profile.npwp).toBe('12.345.678.9-012.345');

      // A GENUINELY separate connection/transaction — never sees the write's connection's
      // uncommitted state, only what it actually COMMITted.
      const reread = await withRollback((client) => buildService().getTaxProfile(employeeId, client));
      expect(reread.dependantsCount).toBe(2);
      expect(reread.npwp).toBe('12.345.678.9-012.345');
    } finally {
      await cleanupStatutoryRows(effectiveFrom);
      await resetTaxProfile();
    }
  });
});
