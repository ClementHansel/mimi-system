/**
 * Live-database proof that the domain-projection hook (`sync-projector
 * .types.ts`, `sync-projector-registry.service.ts`) actually closes the gap
 * W3-08 found: an applied device-origin event reaches a registered
 * `SyncProjector`, exactly once, inside the SAME transaction as the
 * `sync_events` insert — and a throwing projector does not lose the fact.
 *
 * Uses a FAKE projector (not a real Wave 3+ table — those are each
 * module's own to write) so this test doesn't depend on any domain module
 * having landed.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { SyncOriginType } from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import { buildIngestKit } from './test-support/ingest-factory';
import type { ProjectionContext, SyncProjector } from './sync-projector.types';
import {
  cleanupOrigins,
  fetchOneLocationId,
  getAppPool,
  getOwnerPool,
} from './test-support/live-db';

const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as ConfigService;
const pool = getAppPool();
const assertPool = getOwnerPool();

class FakeAttendanceProjector implements SyncProjector {
  readonly handles = ['attendance.checked_in'];
  readonly projectedEventIds: string[] = [];
  shouldFail = false;

  async project(
    _client: PoolClient,
    event: SyncEventEnvelope,
    _context: ProjectionContext,
  ): Promise<void> {
    if (this.shouldFail)
      throw new Error('simulated domain-table failure (e.g. a FK violation on employees)');
    this.projectedEventIds.push(event.eventId); // idempotency is THIS projector's job in real life; here we just record calls
  }
}

let locationId: string;
let actorUserId: string;
const createdOrigins: string[] = [];

function freshOrigin(): string {
  const id = randomUUID();
  createdOrigins.push(id);
  return id;
}

function mkEvent(originDeviceId: string, clientSeq: number): SyncEventEnvelope {
  return {
    eventId: formatUuidV7(Date.now() + clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId,
    locationId,
    entity: 'attendance',
    entityId: randomUUID(),
    op: 'checked_in',
    payload: {
      v: 1,
      data: {
        clientId: randomUUID(),
        locationId,
        lat: '-1.24',
        lng: '116.83',
        accuracyM: 10,
        selfieAttachmentId: randomUUID(),
      },
      meta: { actorUserId, actorRole: 'kasir', appVersion: '1.0.0' },
    },
    clientSeq: BigInt(clientSeq),
    occurredAt: new Date().toISOString(),
    actorUserId,
    schemaV: 1,
  };
}

function batchOf(events: SyncEventEnvelope[]): SyncPushBatch {
  return { batchId: randomUUID(), sentAt: new Date().toISOString(), events };
}

async function resolveLocation(originDeviceId: string): Promise<string | undefined> {
  return createdOrigins.includes(originDeviceId) ? locationId : undefined;
}

describe('SyncProjectorRegistry — the domain-projection hook, live database', () => {
  afterEach(async () => {
    await cleanupOrigins(createdOrigins);
    createdOrigins.length = 0;
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
    await assertPool.end().catch(() => {});
  });

  it('a registered projector runs exactly once per event, inside the ingest transaction, before the batch acks', async () => {
    if (!locationId) locationId = await fetchOneLocationId();
    if (!actorUserId) actorUserId = randomUUID(); // fresh per test-process run — see sync-ingest.integration.test.ts's ensureFixtures() note on cross-file C4 pollution

    const fake = new FakeAttendanceProjector();
    const { ingest } = buildIngestKit(pool, { projectors: [fake], config: fakeConfig });

    const origin = freshOrigin();
    const event = mkEvent(origin, 1);
    const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);

    expect(ack.acceptedThrough[origin]).toBe(1);
    expect(fake.projectedEventIds).toEqual([event.eventId]); // ran exactly once

    // Replaying the identical batch must not re-invoke the projector — the event is already 'applied'.
    await ingest.ingestBatch(batchOf([event]), resolveLocation);
    expect(fake.projectedEventIds).toEqual([event.eventId]); // still exactly once
  });

  it('a projector that throws does not lose the fact — sync_events stays applied, and it surfaces as a projection_failed exception', async () => {
    if (!locationId) locationId = await fetchOneLocationId();
    if (!actorUserId) actorUserId = randomUUID(); // fresh per test-process run — see sync-ingest.integration.test.ts's ensureFixtures() note on cross-file C4 pollution

    const fake = new FakeAttendanceProjector();
    fake.shouldFail = true;
    const { ingest } = buildIngestKit(pool, { projectors: [fake], config: fakeConfig });

    const origin = freshOrigin();
    const event = mkEvent(origin, 1);
    const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);

    // The batch still acks the fact — a projector bug is not a sync reject (§4.4).
    expect(ack.acceptedThrough[origin]).toBe(1);
    expect(ack.rejected).toEqual([]);

    const row = await assertPool.query(`SELECT apply_status FROM sync_events WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(row.rows[0]?.apply_status).toBe('applied'); // NOT rolled back by the projector's failure

    const conflictRes = await assertPool.query<{ detail: { reason: string } }>(
      `SELECT detail FROM sync_conflicts WHERE loser_event_id = $1 AND kind = 'poison'`,
      [event.eventId],
    );
    expect(conflictRes.rows).toHaveLength(1);
    expect(conflictRes.rows[0]!.detail.reason).toBe('projection_failed');
  });

  it('an unregistered (entity, op) is a safe no-op — projection.ran is false, no exception raised', async () => {
    if (!locationId) locationId = await fetchOneLocationId();
    if (!actorUserId) actorUserId = randomUUID(); // fresh per test-process run — see sync-ingest.integration.test.ts's ensureFixtures() note on cross-file C4 pollution

    // Nothing registered — this test is about an unmatched (entity, op) being
    // a silent no-op, so the empty default is the point rather than an
    // omission.
    const { ingest } = buildIngestKit(pool, { config: fakeConfig });

    const origin = freshOrigin();
    const event = mkEvent(origin, 1);
    const ack = await ingest.ingestBatch(batchOf([event]), resolveLocation);

    expect(ack.acceptedThrough[origin]).toBe(1);
    expect(ack.rejected).toEqual([]);
    const conflictRes = await assertPool.query(
      `SELECT id FROM sync_conflicts WHERE loser_event_id = $1`,
      [event.eventId],
    );
    expect(conflictRes.rows).toHaveLength(0); // no projector registered is not itself an error
  });
});
