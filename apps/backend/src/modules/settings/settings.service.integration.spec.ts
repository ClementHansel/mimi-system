/**
 * Live-DB integration suite for M20 `settings` (CONTRACTS.md §4.20) —
 * generic settings get/set, the `ERR_USE_WIZARD` gate, and approval-chain
 * management. Runs against the REAL `mimi_app` pool, real RLS/grant path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalDocumentType, ApprovalMode } from '@mimi/shared';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import {
  closeTestPool,
  fetchOneUserId,
  getAppPool,
  resetSettingValue,
  withRollback,
} from '../auth/test-support/live-db';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

function buildService(): SettingsService {
  const pool = getAppPool();
  const events = new SyncEventsRepository(pool);
  const syncEmit = new SyncEmitService(
    events,
    new ConflictDetectorService(events, new SyncConflictsRepository()),
  );
  return new SettingsService(new SettingsRepository(), syncEmit);
}

let CALLER: { sub: string };

beforeAll(async () => {
  const owner = await fetchOneUserId('owner');
  CALLER = { sub: owner.id };
});

// Every test below runs the service inside `withRollback` (auth's live-db
// harness). That discards a write ONLY if the service method never calls
// `withWrite` (BE-TXN-ROLLBACK) itself — `putOne`/`putApprovalChain`/
// `putApprovalMode` all do, and `withWrite`'s `COMMIT` ends `withRollback`'s
// own transaction for real (Postgres BEGIN doesn't nest), so those DO
// survive. This `hr.late_grace_minutes` reset is the generic safety net for
// that specific key; any OTHER settings key/chain a test here mutates needs
// its own restore in a `finally` (see `putApprovalMode`'s tests below, and
// "accepts a threshold-only change..." above, for the pattern).
afterEach(async () => {
  await resetSettingValue('hr.late_grace_minutes', 5);
});

afterAll(async () => {
  await closeTestPool();
});

describe('SettingsService — generic get/set', () => {
  it('lists seeded settings and reads one by key', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const all = await service.list(undefined, client);
      expect(all.length).toBeGreaterThan(15);
      const one = await service.getOne('hr.late_grace_minutes', client);
      expect(one.key).toBe('hr.late_grace_minutes');
    });
  });

  it('filters by prefix', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const rows = await service.list('approval.threshold.', client);
      expect(rows.length).toBe(4);
      expect(rows.every((r) => r.key.startsWith('approval.threshold.'))).toBe(true);
    });
  });

  it('404s on an unknown key', async () => {
    await withRollback(async (client) => {
      await expect(buildService().getOne('not.a.real.key', client)).rejects.toMatchObject({
        response: { code: 'ERR_NOT_FOUND' },
      });
    });
  });

  it('PUT updates a real key, validates its shape, and emits settings.updated without throwing', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const updated = await service.putOne('hr.late_grace_minutes', { value: 10 }, CALLER, client);
      expect(updated.value).toBe(10);
    });
  });

  it('rejects a malformed value against its declared schema (ERR_VALIDATION)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putOne('hr.late_grace_minutes', { value: 'not-a-number' }, CALLER, client),
      ).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION' },
      });
      await expect(
        service.putOne(
          'coldchain.frozen',
          { value: { minC: '-25.0' /* missing maxC */ } },
          CALLER,
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('D-16 hr.tenure_tiers — the first ARRAY-valued setting: shape-checked per element, and never emptied', async () => {
    await withRollback(async (client) => {
      const service = buildService();

      const updated = await service.putOne(
        'hr.tenure_tiers',
        {
          value: [
            { minYears: 10, amount: '900000.00' },
            { minYears: 2, amount: '150000.00' },
          ],
        },
        CALLER,
        client,
      );
      expect(updated.value).toEqual([
        { minYears: 10, amount: '900000.00' },
        { minYears: 2, amount: '150000.00' },
      ]);

      // Not an array at all — the shape every other key in this map has.
      await expect(
        service.putOne('hr.tenure_tiers', { value: { minYears: 1 } }, CALLER, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });

      // `amount` as a JSON number. Money is a decimal string everywhere in
      // this system; accepting 500000 here would put a float into gross pay
      // and lose the two fixed decimals on the way back out.
      await expect(
        service.putOne(
          'hr.tenure_tiers',
          { value: [{ minYears: 1, amount: 500000 }] },
          CALLER,
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });

      // A per-element check, not just a check of the first entry — a bad tier
      // buried at index 2 is exactly the one a reviewer skims past.
      await expect(
        service.putOne(
          'hr.tenure_tiers',
          {
            value: [
              { minYears: 5, amount: '500000.00' },
              { minYears: 3, amount: '300000.00' },
              { minYears: 'one', amount: '100000.00' },
            ],
          },
          CALLER,
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });

      // THE EMPTY ARRAY. `[]` is valid JSON and a valid array, and it silently
      // removes every long-service allowance from the next payroll run —
      // `tenureAllowance()` returns zero when no tier matches, so nothing
      // errors and nobody is told. Refused outright; clearing the policy has
      // to be a deliberate act, not a save with a deleted row.
      await expect(
        service.putOne('hr.tenure_tiers', { value: [] }, CALLER, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('THE D-18 GATE: raw PUT on payroll.statutory is always ERR_USE_WIZARD, regardless of value shape', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putOne('payroll.statutory', { value: { enabled: true } }, CALLER, client),
      ).rejects.toMatchObject({
        response: { code: 'ERR_USE_WIZARD' },
      });
    });
  });
});

describe('SettingsService — approval chains', () => {
  it('lists the seeded chains including the two-step void_refund escalation', async () => {
    await withRollback(async (client) => {
      const chains = await buildService().listApprovalChains(client);
      const voidChain = chains.find((c) => c.documentType === 'void_refund');
      expect(voidChain?.steps.map((s) => s.approverRole)).toEqual(['supervisor', 'manager']);
    });
  });

  it("rejects changing step 1's fixed approver role", async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putApprovalChain(
          'void_refund',
          {
            steps: [
              {
                stepNo: 1,
                approverRole: 'manager' as never,
                minAmount: undefined,
                maxAmount: undefined,
              },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('rejects a non-sequential step numbering', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putApprovalChain(
          'void_refund',
          {
            steps: [
              {
                stepNo: 1,
                approverRole: 'supervisor' as never,
                minAmount: undefined,
                maxAmount: undefined,
              },
              {
                stepNo: 3,
                approverRole: 'manager' as never,
                minAmount: '200000.00',
                maxAmount: undefined,
              },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  // QA-ATTENDANCE-LEAK: `putApprovalChain` calls `withWrite` (BE-TXN-ROLLBACK) — its `COMMIT`
  // fires on THIS SAME connection/transaction `withRollback` opened (Postgres has no notion of a
  // "nested" BEGIN; the inner `COMMIT` ends the outer transaction for real), so this write survives
  // `withRollback`'s own `ROLLBACK` (which then just runs against no open transaction, a no-op).
  // This test's header comment above ("no write here is ever actually committed") is therefore
  // wrong for THIS method specifically — reproduced by two consecutive full-suite runs with no
  // reset between them: the second run's `auth.service.integration.spec.ts` saw the void_refund
  // step 2 threshold as the 250000.00 THIS test committed on the first run, not the seeded
  // 200000.00 (migration 069) it expected. Restored in `finally`, matching `putApprovalMode`'s own
  // tests just below (which already got this right).
  it('accepts a threshold-only change to an existing chain (step 1 role unchanged)', async () => {
    try {
      const updated = await withRollback((client) =>
        buildService().putApprovalChain(
          'void_refund',
          {
            steps: [
              {
                stepNo: 1,
                approverRole: 'supervisor' as never,
                minAmount: undefined,
                maxAmount: undefined,
              },
              {
                stepNo: 2,
                approverRole: 'manager' as never,
                minAmount: '250000.00',
                maxAmount: undefined,
              },
            ],
          },
          client,
        ),
      );
      expect(updated.steps[1]?.minAmount).toBe('250000.00');
    } finally {
      await withRollback((client) =>
        buildService().putApprovalChain(
          'void_refund',
          {
            steps: [
              {
                stepNo: 1,
                approverRole: 'supervisor' as never,
                minAmount: undefined,
                maxAmount: undefined,
              },
              {
                stepNo: 2,
                approverRole: 'manager' as never,
                minAmount: '200000.00',
                maxAmount: undefined,
              },
            ],
          },
          client,
        ),
      );
    }
  });

  it('rejects an unknown document type', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putApprovalChain(
          'not_a_real_document_type',
          {
            steps: [
              {
                stepNo: 1,
                approverRole: 'owner' as never,
                minAmount: undefined,
                maxAmount: undefined,
              },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });
});

describe('SettingsService — D-23 per-document-type approval modes', () => {
  it('defaults all 12 document types to manual with no settings row seeded (self-seeding — no migration needed)', async () => {
    await withRollback(async (client) => {
      const modes = await buildService().getApprovalModes(client);
      expect(modes).toHaveLength(Object.values(ApprovalDocumentType).length);
      expect(modes.every((m) => m.mode === ApprovalMode.MANUAL)).toBe(true);
    });
  });

  // BE-TXN-ROLLBACK: `putApprovalMode` now really commits (`withWrite`), which ends the
  // transaction `withRollback` opened and reverts `SET LOCAL ROLE`/session GUCs — a later
  // read on the SAME connection would fail `permission denied`. The write and its
  // verifying read are therefore two SEPARATE connections, exactly the shape
  // `stock-opname`'s regression suite established. Since this genuinely commits a shared
  // `approval.mode` settings row, it's restored in `finally` (SETTINGS-LEAK).
  it("PUT persists a single document type's mode, self-seeding the settings row, and leaves every other type untouched — verified via a SEPARATE connection", async () => {
    try {
      const updated = await withRollback((client) =>
        buildService().putApprovalMode(
          ApprovalDocumentType.VOID_REFUND,
          { mode: ApprovalMode.OFF },
          CALLER,
          client,
        ),
      );
      expect(updated).toEqual({
        documentType: ApprovalDocumentType.VOID_REFUND,
        mode: ApprovalMode.OFF,
      });

      const modes = await withRollback((client) => buildService().getApprovalModes(client));
      const voidRefund = modes.find((m) => m.documentType === ApprovalDocumentType.VOID_REFUND);
      const waste = modes.find((m) => m.documentType === ApprovalDocumentType.WASTE);
      expect(voidRefund?.mode).toBe(ApprovalMode.OFF);
      expect(waste?.mode).toBe(ApprovalMode.MANUAL); // untouched by the void_refund-only write
    } finally {
      await withRollback((client) =>
        buildService().putApprovalMode(
          ApprovalDocumentType.VOID_REFUND,
          { mode: ApprovalMode.MANUAL },
          CALLER,
          client,
        ),
      );
    }
  });

  it('a mode change is itself auditable data: the settings row records who changed it and when — read back on a SEPARATE connection', async () => {
    try {
      await withRollback((client) =>
        buildService().putApprovalMode(
          ApprovalDocumentType.PAYROLL_RUN,
          { mode: ApprovalMode.WHATSAPP },
          CALLER,
          client,
        ),
      );
      const row = await withRollback((client) =>
        client.query<{ updated_by: string; updated_at: Date }>(
          `SELECT updated_by, updated_at FROM settings WHERE key = 'approval.mode'`,
        ),
      );
      expect(row.rows[0]?.updated_by).toBe(CALLER.sub);
      expect(row.rows[0]?.updated_at).toBeInstanceOf(Date);
    } finally {
      await withRollback((client) =>
        buildService().putApprovalMode(
          ApprovalDocumentType.PAYROLL_RUN,
          { mode: ApprovalMode.MANUAL },
          CALLER,
          client,
        ),
      );
    }
  });

  it('rejects an unknown document type (ERR_VALIDATION)', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putApprovalMode(
          'not_a_real_document_type',
          { mode: ApprovalMode.OFF },
          CALLER,
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('is unreachable through the generic PUT /api/settings/:key route (no bypass of the dedicated Owner-only gate)', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putOne('approval.mode', { value: { void_refund: 'off' } }, CALLER, client),
      ).rejects.toMatchObject({
        response: { code: 'ERR_NOT_FOUND' },
      });
    });
  });
});

// ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
//
// `putOne`/`putApprovalChain`/`putApprovalMode` previously ran with zero `BEGIN...COMMIT`
// of their own; `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` silently
// discarded every one of them. `asRequest` reproduces the real two-request shape: each
// call gets its own connection, mimicking `RlsContextGuard`'s `BEGIN` and
// `RlsCleanupInterceptor`'s `ROLLBACK` exactly — a service that only writes inside the
// guard's transaction (no `withWrite`) fails this, a service that commits passes.
describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
  it('putOne persists past its own request — a later GET (new connection) sees the new value', async () => {
    try {
      const updated = await withRollback((client) =>
        buildService().putOne('hr.late_grace_minutes', { value: 7 }, CALLER, client),
      );
      expect(updated.value).toBe(7);

      const reread = await withRollback((client) =>
        buildService().getOne('hr.late_grace_minutes', client),
      );
      expect(reread.value).toBe(7);
    } finally {
      await resetSettingValue('hr.late_grace_minutes', 5);
    }
  });
});
