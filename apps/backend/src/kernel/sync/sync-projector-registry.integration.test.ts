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

  it('D-10: a PROMOTED event reaches its projector carrying the relay_received_at it was stamped with on ARRIVAL, not the promotion time', async () => {
    if (!locationId) locationId = await fetchOneLocationId();
    if (!actorUserId) actorUserId = randomUUID();

    // The projector is the observation point: `sweepPendingDependency`
    // reconstructs the envelope from the stored row rather than reusing the
    // caller's object, so the only way to see what the promoted envelope
    // carries is to be handed it. `OfflineAuthService` is handed the same
    // object on the same hook, and reads `relayReceivedAt` for its §7.4
    // expiry check.
    // `relayReceivedAt` is `string | null | undefined` on the envelope: absent
    // on the wire, null for a relay whose node stamp is still pending.
    const seen = new Map<string, string | null | undefined>();
    const recorder: SyncProjector = {
      handles: ['attendance.checked_in'],
      async project(_client: PoolClient, event: SyncEventEnvelope): Promise<void> {
        seen.set(event.eventId, event.relayReceivedAt);
      },
    };
    const { ingest } = buildIngestKit(pool, { projectors: [recorder], config: fakeConfig });

    const origin = freshOrigin();

    // Park seq 2 behind a missing seq 1.
    const parked = mkEvent(origin, 2);
    await ingest.ingestBatch(batchOf([parked]), resolveLocation);

    const arrival = await assertPool.query<{
      apply_status: string;
      relay_received_at: Date | null;
    }>(`SELECT apply_status, relay_received_at FROM sync_events WHERE event_id = $1`, [
      parked.eventId,
    ]);
    expect(arrival.rows[0]!.apply_status).toBe('pending_dependency');
    const stampedOnArrival = arrival.rows[0]!.relay_received_at!;
    expect(seen.has(parked.eventId)).toBe(false); // parked events have not projected yet

    // Fill the gap, which promotes the parked row through the sweep.
    await ingest.ingestBatch(batchOf([mkEvent(origin, 1)]), resolveLocation);

    // The promoted envelope carries the ARRIVAL stamp. Compared against the
    // row rather than a clock, so this asserts the invariant ("these agree")
    // instead of "recent enough" — the whole failure mode here is a value that
    // looks perfectly plausible and is the wrong instant.
    expect(seen.get(parked.eventId)).toBeDefined();
    expect(new Date(seen.get(parked.eventId)!).getTime()).toBe(stampedOnArrival.getTime());

    // Promotion must not restamp the row either: when it was RECEIVED is not
    // when it was APPLIED, and §7.4 expiry is judged against the former.
    const after = await assertPool.query<{ relay_received_at: Date | null }>(
      `SELECT relay_received_at FROM sync_events WHERE event_id = $1`,
      [parked.eventId],
    );
    expect(after.rows[0]!.relay_received_at!.getTime()).toBe(stampedOnArrival.getTime());
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
