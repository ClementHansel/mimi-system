/**
 * Offline-authorization re-verification — SYNC-PROTOCOL §7.4, run "at apply
 * of any `*_offline` decision" (R6, immediate hook — this file IS that
 * hook; `reconciliation.service.ts`'s R6 entry is the nightly safety-net
 * sweep over the same logic for anything that missed the immediate path).
 *
 * Adversarial threat model (§7.1): the cashier controls the device. Nothing
 * here trusts the device's claim beyond what cryptography (`k`, the binding
 * HMAC) or the cloud's own registry (`offline_credentials`) can verify.
 *
 * Three-valued outcome (§7.4 "Outcomes"): `verified` | `failed` |
 * `unprovable`. `failed`/`unprovable` both route to the finance exception
 * queue (`sync_conflicts`, kind `offline_auth`, queue `finance`) — §7.5.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Money, UUID } from '@mimi/shared';
import {
  businessDateOf,
  compareMoney,
  DEFAULT_MAX_OFFLINE_WINDOW_HOURS,
  DEFAULT_OFFLINE_APPROVAL_VOLUME_CAP,
} from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { OfflineAuthorizationMeta } from '@mimi/sync-protocol';
import type { DbClient } from './sync-events.repository';
import { OfflineCredentialsRepository } from './offline-credentials.repository';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { decryptBindingSecret, encKeyFromConfig, verifyBindingHmac } from './binding-crypto';
import type { OfflineAuthOutcomeRow, OfflineAuthVerdictRow } from './db-rows';

export interface ReverifyResult {
  outcome: OfflineAuthOutcomeRow;
  reason: string | null;
  /** The REAL `offline_credentials.credential_id` this claim resolved to, or `null` if none exists (forged/unknown, §7.4 check 1) — `offline_authorizations.credential_id` is `NOT NULL` + FK'd, so a `null` here means there is literally no valid row to attribute a "use" to (see `persist`). */
  credentialId: UUID | null;
}

const ENTITY_DOCUMENT_TYPE: Record<string, string> = {
  void_refunds: 'void_refund',
  replenishment_requests: 'replenishment_request',
  waste_records: 'waste',
};

/** `defensible_at` (§6.4): `occurred_at` clamped to `[relay_received_at - maxOfflineWindow, relay_received_at]`. */
function defensibleAt(
  occurredAt: string,
  relayReceivedAt: string,
  maxOfflineWindowMs: number,
): string {
  const occurredMs = new Date(occurredAt).getTime();
  const relayMs = new Date(relayReceivedAt).getTime();
  const lower = relayMs - maxOfflineWindowMs;
  const clamped = Math.min(Math.max(occurredMs, lower), relayMs);
  return new Date(clamped).toISOString();
}

@Injectable()
export class OfflineAuthService {
  constructor(
    private readonly offlineCreds: OfflineCredentialsRepository,
    private readonly conflicts: SyncConflictsRepository,
    private readonly config: ConfigService,
  ) {}

  /** `true` iff this op is one of the closed-list §7.6 offline-eligible decisions this event's entity supports. */
  isOfflineDecision(entity: string, op: string): boolean {
    return op === 'approved_offline' && !!ENTITY_DOCUMENT_TYPE[entity];
  }

  /** Entry point from the ingest pipeline — called once, at apply, for every `*_offline` decision event. */
  async verifyAndRecord(client: DbClient, event: SyncEventEnvelope): Promise<void> {
    const auth = event.payload.meta?.authorization;
    const documentType = ENTITY_DOCUMENT_TYPE[event.entity] ?? event.entity;

    if (!auth) {
      await this.persist(
        client,
        event,
        documentType,
        null,
        null,
        'failed',
        'missing meta.authorization on an *_offline op — malformed approval, not a mere sync reject (fact still applies, §3.4 step 4)',
      );
      return;
    }

    const result = await this.reverify(client, event, auth);
    await this.persist(
      client,
      event,
      documentType,
      auth,
      result.credentialId,
      result.outcome,
      result.reason,
    );
  }

  private async reverify(
    client: DbClient,
    event: SyncEventEnvelope,
    auth: OfflineAuthorizationMeta,
  ): Promise<ReverifyResult> {
    // check 1 — credential exists, minted for this sub. NOTE: `credentialId: null` in the two returns
    // below is load-bearing, not incidental — `offline_authorizations.credential_id` is NOT NULL + FK'd
    // to `offline_credentials`, so a forged/unknown id has no row `persist()` can legally attribute a
    // "use" to; see that method for how a `null` here routes straight to `sync_conflicts` instead.
    const cred = await this.offlineCreds.findCredential(client, auth.credentialId);
    if (!cred)
      return {
        outcome: 'failed',
        reason: 'credential_id not found in offline_credentials — forged or unknown (fraud alert)',
        credentialId: null,
      };
    if (cred.user_id !== auth.approverUserId) {
      return {
        outcome: 'failed',
        reason: 'credential was not minted for the claimed approver_user_id',
        credentialId: cred.credential_id,
      };
    }

    // check 2 — binding HMAC recomputes over the event's own fields with the stored k.
    const encKey = encKeyFromConfig(this.config);
    let k: Buffer;
    try {
      k = decryptBindingSecret(cred.binding_secret_enc, encKey);
    } catch {
      return {
        outcome: 'failed',
        reason: 'binding secret could not be decrypted (corrupt or tampered credential row)',
        credentialId: cred.credential_id,
      };
    }
    const amountIdr = auth.amountIdr ?? '';
    const hmacOk = verifyBindingHmac(
      k,
      {
        eventId: event.eventId,
        entity: event.entity,
        entityId: event.entityId,
        op: event.op,
        amountIdr,
        occurredAt: event.occurredAt,
      },
      auth.binding,
    );
    if (!hmacOk) {
      return {
        outcome: 'failed',
        reason:
          'binding HMAC does not verify — tampered action, or a binding replayed onto a different document/amount',
        credentialId: cred.credential_id,
      };
    }

    const relayReceivedAt = event.relayReceivedAt ?? new Date().toISOString();

    // check 3 — not revoked before relay_received_at.
    if (
      cred.revoked_at &&
      new Date(cred.revoked_at).getTime() <= new Date(relayReceivedAt).getTime()
    ) {
      return {
        outcome: 'failed',
        reason: `credential revoked at ${cred.revoked_at}, effective before this action's server sighting`,
        credentialId: cred.credential_id,
      };
    }

    // check 4 — expiry, §6.4 provable/unprovable/failed.
    const expiryVerdict = this.checkExpiry(event.occurredAt, relayReceivedAt, cred.expires_at);
    if (expiryVerdict === 'failed') {
      return {
        outcome: 'failed',
        reason: `claim (${event.occurredAt}) is outside the credential's validity window even accounting for the defensible clamp`,
        credentialId: cred.credential_id,
      };
    }

    // check 5 — scope covers (entity, op); amount <= max_idr.
    const scopeKey = scopeKeyForEntity(event.entity);
    const scope = cred.scopes[scopeKey];
    if (!scope) {
      return {
        outcome: 'failed',
        reason: `credential scopes do not include '${scopeKey}'`,
        credentialId: cred.credential_id,
      };
    }
    if (scope.max_idr && auth.amountIdr && compareMoney(auth.amountIdr, scope.max_idr) > 0) {
      return {
        outcome: 'failed',
        reason: `amount ${auth.amountIdr} exceeds scope cap ${scope.max_idr}`,
        credentialId: cred.credential_id,
      };
    }

    // check 6 — approver active + held role/location at defensible_at (best-effort: current state; see note below).
    const active = await this.offlineCreds.userIsActive(client, auth.approverUserId);
    if (!active)
      return {
        outcome: 'failed',
        reason: 'approver is no longer an active user',
        credentialId: cred.credential_id,
      };
    if (event.locationId) {
      const holdsLocation = await this.offlineCreds.userHoldsLocation(
        client,
        auth.approverUserId,
        event.locationId,
      );
      if (!holdsLocation)
        return {
          outcome: 'failed',
          reason: 'approver no longer holds the location this event was recorded at',
          credentialId: cred.credential_id,
        };
    }

    // check 7 — selfie present when required; PIN telemetry sane.
    const selfieThreshold = cred.selfie_required_above;
    const requiresSelfie = !!auth.amountIdr && compareMoney(auth.amountIdr, selfieThreshold) >= 0;
    let degraded = false;
    if (requiresSelfie) {
      if (!auth.selfieRef) {
        degraded = true;
      } else {
        // The selfie's attachment row travels the §4.7 side-channel and may legitimately not have
        // arrived yet (async upload) — its ABSENCE from `attachments` this early is not itself proof
        // of anything; the R3 evidence-SLA job (24h) is the actual enforcement point for that lag.
      }
    }
    if (
      typeof auth.pinAttemptsBeforeSuccess !== 'number' ||
      auth.pinAttemptsBeforeSuccess < 1 ||
      auth.pinAttemptsBeforeSuccess > 5
    ) {
      degraded = true;
    }

    // check 8 — volume cap: uses under this credential within its TTL.
    const priorUses = await this.offlineCreds.countPriorUses(
      client,
      cred.credential_id,
      new Date().toISOString(),
    );
    if (priorUses >= (cred.volume_cap || DEFAULT_OFFLINE_APPROVAL_VOLUME_CAP)) {
      degraded = true;
    }

    if (degraded) {
      return {
        outcome: 'unprovable',
        reason:
          'degraded evidence — missing/incomplete selfie or PIN telemetry, or volume cap exceeded (§7.4 checks 7/8)',
        credentialId: cred.credential_id,
      };
    }
    if (expiryVerdict === 'unprovable') {
      return {
        outcome: 'unprovable',
        reason: 'expiry is in-window by claim but the first server sighting is after expiry (§6.4)',
        credentialId: cred.credential_id,
      };
    }

    return { outcome: 'verified', reason: null, credentialId: cred.credential_id };
  }

  /** §7.4 check 4 / §6.4: provable / unprovable / failed. */
  private checkExpiry(
    occurredAt: string,
    relayReceivedAt: string,
    expiresAt: string,
  ): 'provable' | 'unprovable' | 'failed' {
    const relayMs = new Date(relayReceivedAt).getTime();
    const expMs = new Date(expiresAt).getTime();
    const occurredMs = new Date(occurredAt).getTime();
    if (relayMs <= expMs) return 'provable';
    if (occurredMs <= expMs) return 'unprovable';
    return 'failed';
  }

  /**
   * `credentialId` is the REAL registry id (`null` when check 1 found no such row — forged/unknown,
   * or `meta.authorization` was missing entirely). `offline_authorizations.credential_id` is `NOT NULL`
   * + FK'd to `offline_credentials` (CONTRACTS.md block 120-129) — there is no legal row to insert for
   * a "use" of a credential that was never actually minted, so that case skips `insertUse` entirely and
   * goes straight to `sync_conflicts` (kind `offline_auth`) with the claimed id preserved in `detail` for
   * forensics. Every other outcome DOES have a real row (`cred` was found by the time `reverify` fails
   * any LATER check) and gets the full per-use record.
   */
  private async persist(
    client: DbClient,
    event: SyncEventEnvelope,
    documentType: string,
    auth: OfflineAuthorizationMeta | null,
    credentialId: UUID | null,
    outcome: OfflineAuthOutcomeRow,
    reason: string | null,
  ): Promise<void> {
    if (credentialId) {
      await this.offlineCreds.insertUse(client, {
        credentialId,
        approvalEventId: event.eventId,
        userId: auth?.approverUserId ?? event.actorUserId,
        deviceId: event.originDeviceId,
        locationId: event.locationId,
        documentType,
        documentId: event.entityId,
        action: scopeKeyForEntity(event.entity),
        amount: (auth?.amountIdr as Money | undefined) ?? null,
        bindingHmac: auth?.binding ?? '',
        pinAttemptsBeforeSuccess: auth?.pinAttemptsBeforeSuccess ?? null,
        selfieAttachmentId: null, // resolved by sha256 lookup once the §4.7 side-channel upload lands — R3's job
        grantedAt: event.occurredAt,
        relayReceivedAt: event.relayReceivedAt ?? new Date().toISOString(),
        outcome,
        failureReason: reason,
      });
    }

    if (outcome === 'failed' || outcome === 'unprovable') {
      await this.conflicts.recordConflictIfAbsent(client, {
        kind: 'offline_auth',
        queue: 'finance',
        entity: event.entity,
        entityId: event.entityId,
        locationId: event.locationId,
        loserEventId: event.eventId,
        physicalEffectSuspected: true, // §7.5: operations already acted on the offline decision
        detail: {
          outcome,
          reason,
          claimedCredentialId: auth?.credentialId ?? null,
          resolvedCredentialId: credentialId,
          approverUserId: auth?.approverUserId ?? null,
        },
        assigneeRole: 'finance',
      });
    }
  }

  /** §7.5 finance verdict: `upheld` (converts to verified) or `rejected` (converts to failed). */
  async recordVerdict(
    client: DbClient,
    offlineAuthorizationId: UUID,
    verdict: OfflineAuthVerdictRow,
    reviewedBy: UUID,
  ) {
    const newOutcome: OfflineAuthOutcomeRow = verdict === 'upheld' ? 'verified' : 'failed';
    return this.offlineCreds.recordVerdict(
      client,
      offlineAuthorizationId,
      verdict,
      reviewedBy,
      newOutcome,
    );
  }
}

/** §7.6 closed-list scope key, verbatim per §7.2's `scopes` shape (`void_refund.approve`, `replenishment.supervisor_approve`, `waste.approve`). */
function scopeKeyForEntity(
  entity: string,
): 'void_refund.approve' | 'replenishment.supervisor_approve' | 'waste.approve' {
  switch (entity) {
    case 'void_refunds':
      return 'void_refund.approve';
    case 'replenishment_requests':
      return 'replenishment.supervisor_approve';
    case 'waste_records':
      return 'waste.approve';
    default:
      throw new Error(`entity '${entity}' has no offline-eligible scope key`);
  }
}

export const _internal = { defensibleAt, businessDateOf, DEFAULT_MAX_OFFLINE_WINDOW_HOURS };
