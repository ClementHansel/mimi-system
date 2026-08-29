/**
 * Live-database adversarial tests for §7.4 offline-authorization
 * re-verification (SYNC-PROTOCOL §9.2 T-15 subset) — the three-valued
 * outcome (`verified`/`failed`/`unprovable`) under a cashier who fully
 * controls the device (§7.1's threat model).
 *
 * SCOPE NOTE (see `system-rls-context.ts`'s header, and the W2-D report):
 * `offline_credentials`' RLS policy is `SELF`-only with no central-role
 * bypass, so the credential lookup this service depends on is CURRENTLY
 * BLOCKED for the system/device-token flow when run through the real
 * `mimi_app` pool (confirmed: `SELECT count(*) FROM offline_credentials`
 * returns 0 as `mimi_app` regardless of session context). These tests
 * therefore exercise `OfflineAuthService` against the OWNER pool — this
 * verifies the §7.4 CHECK LOGIC (HMAC tamper/replay detection, expiry
 * provable/unprovable/failed, volume cap, selfie threshold) is correct;
 * it does NOT (and cannot, until that policy question is resolved)
 * demonstrate that the logic is reachable in production over `mimi_app`.
 * That gap is the blocker, not a gap in this test's coverage of the logic.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SyncOriginType } from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope } from '@mimi/sync-protocol';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { OfflineCredentialsRepository } from './offline-credentials.repository';
import { OfflineAuthService } from './offline-auth.service';
import {
  computeBindingHmac,
  encryptBindingSecret,
  generateBindingSecret,
  encKeyFromConfig,
} from './binding-crypto';
import {
  assignUserToLocation,
  cleanupCredentials,
  cleanupDevices,
  cleanupOrigins,
  cleanupUserLocation,
  closeTestPool,
  fetchOneLocationId,
  fetchOneUserId,
  getOwnerPool,
  insertTestDevice,
} from './test-support/live-db';

const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as ConfigService;
const encKey = encKeyFromConfig(fakeConfig);

const pool = getOwnerPool(); // see file header: the ONE unresolved RLS gap this ticket flags, not weakened here
const conflictsRepo = new SyncConflictsRepository();
const offlineAuth = new OfflineAuthService(
  new OfflineCredentialsRepository(),
  conflictsRepo,
  fakeConfig,
);

let locationId: string;
let approverUserId: string;
const createdDeviceIds: string[] = [];
const createdCredentialIds: string[] = [];
const createdOriginIds: string[] = [];

async function ensureFixtures() {
  if (!locationId) locationId = await fetchOneLocationId();
  if (!approverUserId) {
    approverUserId = await fetchOneUserId('supervisor');
    await assignUserToLocation(approverUserId, locationId); // §7.4 check 6: approver must hold this location
  }
}

interface Rig {
  deviceId: string;
  credentialId: string;
  k: Buffer;
}

async function mintCredential(
  overrides: { expiresAt?: string; volumeCap?: number; selfieRequiredAbove?: string } = {},
): Promise<Rig> {
  const deviceId = await insertTestDevice(locationId, randomUUID());
  createdDeviceIds.push(deviceId);
  const credentialId = randomUUID();
  createdCredentialIds.push(credentialId);
  const k = generateBindingSecret();

  await pool.query(
    `INSERT INTO offline_credentials (
       credential_id, user_id, device_id, role_key, location_ids, scopes,
       binding_secret_enc, pin_verifier, selfie_required_above, volume_cap, expires_at
     ) VALUES ($1,$2,$3,'supervisor',$4,$5,$6,'x',$7,$8,$9)`,
    [
      credentialId,
      approverUserId,
      deviceId,
      [locationId],
      JSON.stringify({ 'void_refund.approve': { max_idr: '500000.00' } }),
      encryptBindingSecret(k, encKey),
      overrides.selfieRequiredAbove ?? '200000.00',
      overrides.volumeCap ?? 20,
      overrides.expiresAt ?? new Date(Date.now() + 24 * 3600_000).toISOString(),
    ],
  );
  return { deviceId, credentialId, k };
}

/** Inserts the prerequisite `sync_events` row directly (bypassing ingest — this suite targets `OfflineAuthService` in isolation) so `offline_authorizations.approval_event_id`'s FK is satisfiable. */
async function insertBackingEvent(event: SyncEventEnvelope): Promise<void> {
  createdOriginIds.push(event.originDeviceId);
  await pool.query(
    `INSERT INTO sync_events (event_id, origin_tier, origin_device_id, location_id, entity, entity_id, op, payload, client_seq, occurred_at, actor_user_id, schema_v, apply_status, applied_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'applied',NOW())`,
    [
      event.eventId,
      event.originTier,
      event.originDeviceId,
      event.locationId,
      event.entity,
      event.entityId,
      event.op,
      JSON.stringify(event.payload),
      event.clientSeq.toString(),
      event.occurredAt,
      event.actorUserId,
      event.schemaV,
    ],
  );
}

function mkVoidRefundOfflineApproval(
  deviceId: string,
  credentialId: string,
  k: Buffer,
  opts: {
    amountIdr?: string;
    entityIdOverrideForReplay?: string;
    occurredAt?: string;
    relayReceivedAt?: string;
    bindingOverride?: string;
    pinAttempts?: number;
    selfieRef?: { sha256: string; size: number; mime: string };
  } = {},
): SyncEventEnvelope {
  const eventId = formatUuidV7(Date.now(), randomBytes(16));
  const entityId = randomUUID();
  const amountIdr = opts.amountIdr ?? '100000.00';
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  const bindingEntityId = opts.entityIdOverrideForReplay ?? entityId; // (iii) replay: binding computed for a DIFFERENT document
  const binding =
    opts.bindingOverride ??
    computeBindingHmac(k, {
      eventId,
      entity: 'void_refunds',
      entityId: bindingEntityId,
      op: 'approved_offline',
      amountIdr,
      occurredAt,
    });

  return {
    eventId,
    originTier: SyncOriginType.DEVICE,
    originDeviceId: deviceId,
    locationId,
    entity: 'void_refunds',
    entityId,
    op: 'approved_offline',
    payload: {
      v: 1,
      data: {},
      meta: {
        actorUserId: approverUserId,
        actorRole: 'supervisor',
        appVersion: '1.0.0',
        authorization: {
          credentialId,
          approverUserId,
          binding,
          pinAttemptsBeforeSuccess: opts.pinAttempts ?? 1,
          selfieRef: opts.selfieRef,
          amountIdr,
        },
      },
    },
    clientSeq: 1n,
    occurredAt,
    relayReceivedAt: opts.relayReceivedAt ?? occurredAt,
    actorUserId: approverUserId,
    schemaV: 1,
  };
}

async function outcomeFor(
  eventId: string,
): Promise<{ outcome: string; failure_reason: string | null } | undefined> {
  const res = await pool.query<{ outcome: string; failure_reason: string | null }>(
    `SELECT outcome, failure_reason FROM offline_authorizations WHERE approval_event_id = $1`,
    [eventId],
  );
  return res.rows[0];
}

describe('OfflineAuthService — live database (§7.4 adversarial)', () => {
  afterEach(async () => {
    // Order matters: offline_authorizations.approval_event_id -> sync_events(event_id), so the
    // credential/authorization cleanup (which also deletes offline_authorizations rows) must run
    // BEFORE cleanupOrigins deletes the sync_events rows those authorizations reference.
    await cleanupCredentials(createdCredentialIds);
    await cleanupOrigins(createdOriginIds);
    await cleanupDevices(createdDeviceIds);
    createdOriginIds.length = 0;
    createdCredentialIds.length = 0;
    createdDeviceIds.length = 0;
  });

  afterAll(async () => {
    if (approverUserId && locationId) await cleanupUserLocation(approverUserId, locationId);
    await closeTestPool();
  });

  it('(viii) happy path: a valid offline approval verifies', async () => {
    await ensureFixtures();
    const rig = await mintCredential();
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k);
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('verified');
  });

  it('(i) forged credential (self-minted, not in the registry) fails — and lands in sync_conflicts, not offline_authorizations (no valid FK target)', async () => {
    await ensureFixtures();
    const rig = await mintCredential();
    const forgedK = generateBindingSecret(); // the cashier's own key — never registered
    const forgedCredentialId = randomUUID();
    const event = mkVoidRefundOfflineApproval(rig.deviceId, forgedCredentialId, forgedK);
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    // No offline_authorizations row: `credential_id` is NOT NULL + FK'd, and this id was never minted.
    const row = await outcomeFor(event.eventId);
    expect(row).toBeUndefined();

    const conflictRes = await pool.query<{
      detail: { claimedCredentialId: string; outcome: string };
    }>(`SELECT detail FROM sync_conflicts WHERE kind = 'offline_auth' AND loser_event_id = $1`, [
      event.eventId,
    ]);
    expect(conflictRes.rows).toHaveLength(1);
    expect(conflictRes.rows[0]!.detail.claimedCredentialId).toBe(forgedCredentialId);
    expect(conflictRes.rows[0]!.detail.outcome).toBe('failed');
  });

  it('(ii) tampered amount breaks the binding HMAC — failed', async () => {
    await ensureFixtures();
    const rig = await mintCredential();
    // Binding computed for 100_000 but the event claims 400_000 — a post-hoc amount edit.
    const eventId = formatUuidV7(Date.now(), randomBytes(16));
    const entityId = randomUUID();
    const occurredAt = new Date().toISOString();
    const bindingForWrongAmount = computeBindingHmac(rig.k, {
      eventId,
      entity: 'void_refunds',
      entityId,
      op: 'approved_offline',
      amountIdr: '100000.00',
      occurredAt,
    });
    const event: SyncEventEnvelope = {
      eventId,
      originTier: SyncOriginType.DEVICE,
      originDeviceId: rig.deviceId,
      locationId,
      entity: 'void_refunds',
      entityId,
      op: 'approved_offline',
      payload: {
        v: 1,
        data: {},
        meta: {
          actorUserId: approverUserId,
          actorRole: 'supervisor',
          appVersion: '1.0.0',
          authorization: {
            credentialId: rig.credentialId,
            approverUserId,
            binding: bindingForWrongAmount,
            pinAttemptsBeforeSuccess: 1,
            amountIdr: '400000.00',
          },
        },
      },
      clientSeq: 1n,
      occurredAt,
      relayReceivedAt: occurredAt,
      actorUserId: approverUserId,
      schemaV: 1,
    };
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_reason).toMatch(/binding HMAC/i);

    // D-11 — WHERE a failed re-verification goes, which is the half that was
    // never asserted for a void with a valid credential (only the forged case
    // checked it).
    //
    // Owner decision 2026-08-29: a failed re-verification of an already-
    // executed void produces a DISPUTE for finance, not an approval row. The
    // reason is that the void physically happened — cash left the drawer, stock
    // was reversed — so writing `rejected` on an `approvals` row would describe
    // a decision nobody made and imply the void did not occur. What is true is
    // narrower: the action happened and its authority did not hold up.
    const conflict = await pool.query<{
      queue: string;
      assignee_role: string;
      physical_effect_suspected: boolean;
      detail: { outcome: string };
    }>(
      `SELECT queue, assignee_role, physical_effect_suspected, detail
         FROM sync_conflicts WHERE kind = 'offline_auth' AND loser_event_id = $1`,
      [event.eventId],
    );
    expect(conflict.rows).toHaveLength(1);
    expect(conflict.rows[0]!.queue).toBe('finance');
    expect(conflict.rows[0]!.assignee_role).toBe('finance');
    // §7.5 — the field that records "operations already acted on this". A
    // dispute that did not say so would be indistinguishable from a request
    // that was simply declined before anything happened.
    expect(conflict.rows[0]!.physical_effect_suspected).toBe(true);
    expect(conflict.rows[0]!.detail.outcome).toBe('failed');

    // And NO approval bookkeeping, deliberately. `approvals` is the record of
    // decisions people made; this was not one.
    const approvals = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approvals WHERE document_id = $1`,
      [entityId],
    );
    expect(approvals.rows[0]!.count).toBe('0');
  });

  it('(iii) a binding replayed onto a different document fails', async () => {
    await ensureFixtures();
    const rig = await mintCredential();
    const otherDocumentId = randomUUID(); // the binding is computed for THIS document...
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k, {
      entityIdOverrideForReplay: otherDocumentId,
    }); // ...but claimed against event.entityId
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_reason).toMatch(/binding HMAC/i);
  });

  it('(iv) expired credential + backdated clock claim is unprovable, never auto-passed (§6.4)', async () => {
    await ensureFixtures();
    const rig = await mintCredential({ expiresAt: new Date(Date.now() - 3600_000).toISOString() }); // expired 1h ago
    const occurredAt = new Date(Date.now() - 2 * 3600_000).toISOString(); // claims 2h ago (before expiry — in-window claim)
    const relayReceivedAt = new Date().toISOString(); // but first server sighting is NOW (after expiry)
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k, {
      occurredAt,
      relayReceivedAt,
    });
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('unprovable');
  });

  it('(iv-b) claim itself is outside the window even accounting for the clamp — failed', async () => {
    await ensureFixtures();
    const rig = await mintCredential({
      expiresAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    }); // expired 2 days ago
    const occurredAt = new Date(Date.now() - 47 * 3600_000).toISOString(); // claim itself is AFTER expiry too
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k, {
      occurredAt,
      relayReceivedAt: new Date().toISOString(),
    });
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('failed');
  });

  it('(v) missing selfie above the threshold degrades to unprovable, not verified', async () => {
    await ensureFixtures();
    const rig = await mintCredential({ selfieRequiredAbove: '50000.00' });
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k, {
      amountIdr: '250000.00',
    }); // above threshold, no selfieRef supplied
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('unprovable');
    expect(row?.failure_reason).toMatch(/degraded/i);
  });

  it('scope cap: amount exceeding the credential max_idr fails', async () => {
    await ensureFixtures();
    const rig = await mintCredential(); // scope max_idr = 500000.00
    const event = mkVoidRefundOfflineApproval(rig.deviceId, rig.credentialId, rig.k, {
      amountIdr: '900000.00',
    });
    await insertBackingEvent(event);

    await offlineAuth.verifyAndRecord(pool, event);

    const row = await outcomeFor(event.eventId);
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_reason).toMatch(/exceeds scope cap/i);
  });
});
