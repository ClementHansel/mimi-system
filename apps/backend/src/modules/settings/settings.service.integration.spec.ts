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
import { closeTestPool, fetchOneUserId, getAppPool, resetSettingValue, withRollback } from '../auth/test-support/live-db';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

function buildService(): SettingsService {
  const pool = getAppPool();
  const events = new SyncEventsRepository(pool);
  const syncEmit = new SyncEmitService(events, new ConflictDetectorService(events, new SyncConflictsRepository()));
  return new SettingsService(new SettingsRepository(), syncEmit);
}

let CALLER: { sub: string };

beforeAll(async () => {
  const owner = await fetchOneUserId('owner');
  CALLER = { sub: owner.id };
});

// Every test below runs the service inside `withRollback` (auth's live-db
// harness), so no write here is ever actually committed — this reset is
// defensive belt-and-braces only, in case a future edit changes that.
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
      await expect(buildService().getOne('not.a.real.key', client)).rejects.toMatchObject({ response: { code: 'ERR_NOT_FOUND' } });
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
      await expect(service.putOne('hr.late_grace_minutes', { value: 'not-a-number' }, CALLER, client)).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION' },
      });
      await expect(
        service.putOne('coldchain.frozen', { value: { minC: '-25.0' /* missing maxC */ } }, CALLER, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('THE D-18 GATE: raw PUT on payroll.statutory is always ERR_USE_WIZARD, regardless of value shape', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(service.putOne('payroll.statutory', { value: { enabled: true } }, CALLER, client)).rejects.toMatchObject({
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

  it('rejects changing step 1\'s fixed approver role', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.putApprovalChain(
          'void_refund',
          { steps: [{ stepNo: 1, approverRole: 'manager' as never, minAmount: undefined, maxAmount: undefined }] },
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
              { stepNo: 1, approverRole: 'supervisor' as never, minAmount: undefined, maxAmount: undefined },
              { stepNo: 3, approverRole: 'manager' as never, minAmount: '200000.00', maxAmount: undefined },
            ],
          },
          client,
        ),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('accepts a threshold-only change to an existing chain (step 1 role unchanged)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const updated = await service.putApprovalChain(
        'void_refund',
        {
          steps: [
            { stepNo: 1, approverRole: 'supervisor' as never, minAmount: undefined, maxAmount: undefined },
            { stepNo: 2, approverRole: 'manager' as never, minAmount: '250000.00', maxAmount: undefined },
          ],
        },
        client,
      );
      expect(updated.steps[1]?.minAmount).toBe('250000.00');
    });
  });

  it('rejects an unknown document type', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putApprovalChain('not_a_real_document_type', { steps: [{ stepNo: 1, approverRole: 'owner' as never, minAmount: undefined, maxAmount: undefined }] }, client),
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

  it('PUT persists a single document type\'s mode, self-seeding the settings row, and leaves every other type untouched', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const updated = await service.putApprovalMode(ApprovalDocumentType.VOID_REFUND, { mode: ApprovalMode.OFF }, CALLER, client);
      expect(updated).toEqual({ documentType: ApprovalDocumentType.VOID_REFUND, mode: ApprovalMode.OFF });

      const modes = await service.getApprovalModes(client);
      const voidRefund = modes.find((m) => m.documentType === ApprovalDocumentType.VOID_REFUND);
      const waste = modes.find((m) => m.documentType === ApprovalDocumentType.WASTE);
      expect(voidRefund?.mode).toBe(ApprovalMode.OFF);
      expect(waste?.mode).toBe(ApprovalMode.MANUAL); // untouched by the void_refund-only write
    });
  });

  it('a mode change is itself auditable data: the settings row records who changed it and when', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await service.putApprovalMode(ApprovalDocumentType.PAYROLL_RUN, { mode: ApprovalMode.WHATSAPP }, CALLER, client);
      const row = await client.query<{ updated_by: string; updated_at: Date }>(`SELECT updated_by, updated_at FROM settings WHERE key = 'approval.mode'`);
      expect(row.rows[0]?.updated_by).toBe(CALLER.sub);
      expect(row.rows[0]?.updated_at).toBeInstanceOf(Date);
    });
  });

  it('rejects an unknown document type (ERR_VALIDATION)', async () => {
    await withRollback(async (client) => {
      await expect(
        buildService().putApprovalMode('not_a_real_document_type', { mode: ApprovalMode.OFF }, CALLER, client),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
    });
  });

  it('is unreachable through the generic PUT /api/settings/:key route (no bypass of the dedicated Owner-only gate)', async () => {
    await withRollback(async (client) => {
      await expect(buildService().putOne('approval.mode', { value: { void_refund: 'off' } }, CALLER, client)).rejects.toMatchObject({
        response: { code: 'ERR_NOT_FOUND' },
      });
    });
  });
});
