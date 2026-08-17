/**
 * Pure unit test (no DB) for `SyncEmitService`'s direction guard — the
 * defect W3-07 found (it duplicated a local `delivery-fact-emitter
 * .service.ts` to work around it) and this file fixes: the guard was
 * checking `resolveDirection(entity)` against `'pull'/'bidirectional'`,
 * rejecting cloud emission of any class-F/B entity whose declared
 * `direction` happens to be `'push'` — even though `canOriginate()` (the
 * SAME authority data the device-ingest path uses) explicitly exempts the
 * cloud tier regardless of direction. Fixed by delegating to
 * `canOriginate(CLOUD, entity, op)` directly instead of re-deriving a
 * parallel condition.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import { SyncEmitService } from './sync-emit.service';
import type { SyncEventsRepository } from './sync-events.repository';
import type { ConflictDetectorService } from './conflict-detector.service';

function buildEmitService() {
  const fakeEvents = {
    nextCloudClientSeq: vi.fn(async () => 1n),
    insertEvent: vi.fn(async () => ({}) as never),
  } as unknown as SyncEventsRepository;
  const fakeConflicts = {
    detectAtApply: vi.fn(async () => ({ isLoser: false })),
  } as unknown as ConflictDetectorService;
  return new SyncEmitService(fakeEvents, fakeConflicts);
}

const fakeClient = {} as never; // never touched: emit() with an explicit client never opens its own transaction

describe('SyncEmitService.emit — cloud-origin authority guard', () => {
  it.each([
    ['sj_drops', 'received'], // the exact regression W3-07 hit
    ['sj_drops', 'departed'],
    ['sj_drops', 'arrived'],
    ['sj_temperature_logs', 'logged'],
    ['goods_receipts', 'recorded'],
    ['attendance', 'checked_in'], // HR entering a correction, per the coordinator's follow-up question
    ['waste_records', 'reported'], // desktop entry — already worked before the fix (bidirectional), regression-guarded here too
  ])('cloud MAY emit %s.%s (push-class, but canOriginate exempts the cloud tier)', async (entity, op) => {
    const emit = buildEmitService();
    await expect(
      emit.emit(fakeClient, { entity, op, entityId: 'e', locationId: 'l', actorUserId: 'u', data: {} }),
    ).resolves.toMatchObject({ entity, op });
  });

  it.each([
    ['stock_balances', 'updated'], // D-16/D-16a: never on the wire in either direction, even from the cloud
    ['stock_movements', 'posted'],
    ['journal_entries', 'posted'],
    ['not_a_real_entity', 'whatever'],
  ])('cloud may NOT emit %s.%s (class D/X, or unknown — no legitimate op vocabulary at all)', async (entity, op) => {
    const emit = buildEmitService();
    await expect(
      emit.emit(fakeClient, { entity, op, entityId: 'e', locationId: 'l', actorUserId: 'u', data: {} }),
    ).rejects.toThrow(/not a known op|class X\/D\/T/);
  });

  it('rejects an op that is genuinely not in the entity\'s vocabulary, even though the entity itself is wire-eligible', async () => {
    const emit = buildEmitService();
    await expect(
      emit.emit(fakeClient, { entity: 'sales', op: 'not_a_real_op', entityId: 'e', locationId: 'l', actorUserId: 'u', data: {} }),
    ).rejects.toThrow();
  });
});

// Type-only sanity check that emit()'s success path returns the shape callers expect (server_seq/client_seq
// bookkeeping aside) — keeps this file honest if EmitParams/SyncEventEnvelope ever drift.
function _typeCheck(env: SyncEventEnvelope): string {
  return env.entity;
}
void _typeCheck;
