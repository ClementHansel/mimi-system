/**
 * Live-DB integration suite for the D-18 statutory payroll wizard
 * (CONTRACTS.md §4.15, shipped under `/api/settings/statutory/*` per this
 * agent's report on the CONTRACTS-path deviation). Runs against the REAL
 * `mimi_app` pool inside `withRollback` — nothing here is ever committed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { closeTestPool, fetchOneUserId, getAppPool, getOwnerPool, withRollback } from '../auth/test-support/live-db';
import { SettingsRepository } from './settings.repository';
import { StatutoryRepository } from './statutory.repository';
import { StatutoryService } from './statutory.service';

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

describe('StatutoryService.status — the wizard readiness check', () => {
  it('reports NOT ready with all four pieces missing on a fresh (unconfigured) install', async () => {
    await withRollback(async (client) => {
      const status = await buildService().status(client);
      expect(status.enabled).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.missing.sort()).toEqual(['bpjs_configs', 'employee_tax_profiles', 'pph21_ptkp', 'pph21_ter_rates']);
    });
  });

  it('becomes ready once BPJS (all 5 programs), TER (all 3 categories), PTKP, and one tax profile exist', async () => {
    await withRollback(async (client) => {
      const service = buildService();

      await service.putBpjs(
        {
          rows: (['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const).map((program) => ({
            program,
            employerPct: '4.000',
            employeePct: '1.000',
            effectiveFrom: '2026-01-01',
          })),
        },
        client,
      );

      await service.putTer(
        {
          effectiveFrom: '2026-01-01',
          rows: [
            { category: 'A', bracketMin: '0.00', bracketMax: '5400000.00', ratePct: '0.000' },
            { category: 'A', bracketMin: '5400000.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            { category: 'B', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            { category: 'C', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
          ],
        },
        client,
      );

      await service.putPtkp({ effectiveFrom: '2026-01-01', rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client);

      await service.putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 0, npwp: null }, CALLER, client);

      const status = await service.status(client);
      expect(status.missing).toEqual([]);
      expect(status.ready).toBe(true);
      expect(status.profileCoverage.withProfile).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('StatutoryService — BPJS effective-dated overlap (ERR_EFFECTIVE_OVERLAP)', () => {
  it('auto-closes the prior open window when a later effectiveFrom is inserted', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await service.putBpjs({ rows: [{ program: 'kesehatan', employerPct: '4.000', employeePct: '1.000', effectiveFrom: '2026-01-01' }] }, client);
      await service.putBpjs({ rows: [{ program: 'kesehatan', employerPct: '4.500', employeePct: '1.000', effectiveFrom: '2027-01-01' }] }, client);

      const rows = await service.listBpjs(client, 'kesehatan');
      const closed = rows.find((r) => r.effectiveFrom === '2026-01-01');
      const open = rows.find((r) => r.effectiveFrom === '2027-01-01');
      expect(closed?.effectiveTo).toBe('2027-01-01');
      expect(open?.effectiveTo).toBeNull();
    });
  });

  it('rejects a new window starting at-or-before the currently open window (ERR_EFFECTIVE_OVERLAP)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await service.putBpjs({ rows: [{ program: 'jht', employerPct: '3.700', employeePct: '2.000', effectiveFrom: '2026-06-01' }] }, client);
      await expect(
        service.putBpjs({ rows: [{ program: 'jht', employerPct: '3.700', employeePct: '2.000', effectiveFrom: '2026-01-01' }] }, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_EFFECTIVE_OVERLAP' } });
    });
  });
});

describe('StatutoryService — PPh21 TER bracket contiguity (ERR_BRACKET_GAP)', () => {
  it('rejects a gap between brackets within one category', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putTer(
          {
            effectiveFrom: '2026-01-01',
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
      const service = buildService();
      await expect(
        service.putTer(
          { effectiveFrom: '2026-01-01', rows: [{ category: 'B', bracketMin: '100.00', bracketMax: null as unknown as string, ratePct: '5.000' }] },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_BRACKET_GAP' } });
    });
  });

  it('accepts a valid contiguous multi-bracket category', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const rows = await service.putTer(
        {
          effectiveFrom: '2026-01-01',
          rows: [
            { category: 'A', bracketMin: '0.00', bracketMax: '5400000.00', ratePct: '0.000' },
            { category: 'A', bracketMin: '5400000.00', bracketMax: '10000000.00', ratePct: '5.000' },
            { category: 'A', bracketMin: '10000000.00', bracketMax: null as unknown as string, ratePct: '15.000' },
          ],
        },
        client,
      );
      expect(rows).toHaveLength(3);
    });
  });
});

describe('StatutoryService — PPh21 Article 17 (ERR_BRACKET_GAP, top bracket must be open-ended)', () => {
  it('rejects a closed top bracket', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putArticle17(
          { effectiveFrom: '2026-01-01', rows: [{ bracketMin: '0.00', bracketMax: '60000000.00', ratePct: '5.000' }] },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_BRACKET_GAP' } });
    });
  });

  it('accepts the real 2022 national schedule shape (5/15/25/30/35, open-ended top)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const rows = await service.putArticle17(
        {
          effectiveFrom: '2027-01-01',
          rows: [
            { bracketMin: '0.00', bracketMax: '60000000.00', ratePct: '5.000' },
            { bracketMin: '60000000.00', bracketMax: '250000000.00', ratePct: '15.000' },
            { bracketMin: '250000000.00', bracketMax: '500000000.00', ratePct: '25.000' },
            { bracketMin: '500000000.00', bracketMax: '5000000000.00', ratePct: '30.000' },
            { bracketMin: '5000000000.00', bracketMax: null as unknown as string, ratePct: '35.000' },
          ],
        },
        client,
      );
      // migration 200 already seeds the 2022 schedule (open-ended) — listArticle17()
      // with no `asOf` filter returns full history, so filter to the NEW window.
      const newRows = rows.filter((r) => r.effectiveFrom === '2027-01-01');
      expect(newRows).toHaveLength(5);
      expect(newRows.find((r) => r.bracketMin === '5000000000.00')?.bracketMax).toBeNull();
      // and the PRE-EXISTING seeded window was auto-closed at the new effectiveFrom.
      const oldRows = rows.filter((r) => r.effectiveFrom === '2022-01-01');
      expect(oldRows.every((r) => r.effectiveTo === '2027-01-01')).toBe(true);
    });
  });
});

describe('StatutoryService.enable — gated by readiness (ERR_STATUTORY_NOT_READY)', () => {
  it('rejects enabling when setup is incomplete', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(service.enable({ confirm: true }, CALLER, client)).rejects.toMatchObject({ response: { code: 'ERR_STATUTORY_NOT_READY' } });
    });
  });

  it('succeeds once ready, records enabledBy/enabledAt, and disable reverts the gate', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await service.putBpjs(
        {
          rows: (['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const).map((program) => ({
            program,
            employerPct: '4.000',
            employeePct: '1.000',
            effectiveFrom: '2026-01-01',
          })),
        },
        client,
      );
      await service.putTer(
        {
          effectiveFrom: '2026-01-01',
          rows: [
            { category: 'A', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            { category: 'B', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
            { category: 'C', bracketMin: '0.00', bracketMax: null as unknown as string, ratePct: '5.000' },
          ],
        },
        client,
      );
      await service.putPtkp({ effectiveFrom: '2026-01-01', rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client);
      await service.putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 0, npwp: null }, CALLER, client);

      const enabled = await service.enable({ confirm: true }, CALLER, client);
      expect(enabled.enabled).toBe(true);
      expect(enabled.enabledAt).toBeTruthy();
      expect(enabled.enabledBy).toBeTruthy();

      const disabled = await service.disable({ reason: 'test teardown' }, CALLER, client);
      expect(disabled.enabled).toBe(false);
    });
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

  it('upserts a valid profile and reads it back', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await service.putPtkp({ effectiveFrom: '2026-01-01', rows: [{ ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' }] }, client);
      const profile = await service.putTaxProfile(employeeId, { ptkpCode: 'TK/0', dependantsCount: 2, npwp: '12.345.678.9-012.345' }, CALLER, client);
      expect(profile.dependantsCount).toBe(2);
      expect(profile.npwp).toBe('12.345.678.9-012.345');
    });
  });
});
