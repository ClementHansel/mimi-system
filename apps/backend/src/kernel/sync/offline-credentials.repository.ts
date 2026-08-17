/**
 * Raw `pg` access to `offline_credentials` (mint registry) and
 * `offline_authorizations` (per-use log) — CONTRACTS.md §1.13, SYNC-PROTOCOL
 * §7. Minting itself belongs to M01 `auth.offline_credential.mint` (Wave 3,
 * not yet built) — this repository only READS the mint registry (for §7.4
 * re-verification) and WRITES the per-use log (the engine's own job: every
 * `<entity>.approved_offline` event ingested creates or updates one row
 * here, per CONTRACTS.md A-13's naming resolution: "exists in
 * offline_authorizations" (§7.4 check 1) resolves against the MINT
 * registry, `offline_credentials`).
 */
import { Injectable } from '@nestjs/common';
import type { Money, UUID } from '@mimi/shared';
import type { DbClient } from './sync-events.repository';
import type { OfflineAuthorizationRow, OfflineAuthOutcomeRow, OfflineAuthVerdictRow, OfflineCredentialRow } from './db-rows';

/** Every method here takes its own `client: DbClient` — no pool of its own (§5.1: detection/re-verification always runs inside the caller's transaction, e.g. `sync-ingest.service.ts`'s apply-time hook). */
@Injectable()
export class OfflineCredentialsRepository {

  async findCredential(client: DbClient, credentialId: UUID): Promise<OfflineCredentialRow | undefined> {
    const res = await client.query<OfflineCredentialRow>(
      `SELECT * FROM offline_credentials WHERE credential_id = $1`,
      [credentialId],
    );
    return res.rows[0];
  }

  /** Count of prior USES of this credential strictly before `beforeCreatedAt` — §7.4 check 8 volume cap. */
  async countPriorUses(client: DbClient, credentialId: UUID, beforeCreatedAt: string): Promise<number> {
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM offline_authorizations WHERE credential_id = $1 AND created_at < $2`,
      [credentialId, beforeCreatedAt],
    );
    return Number(res.rows[0]?.n ?? '0');
  }

  async insertUse(
    client: DbClient,
    row: {
      credentialId: UUID;
      approvalEventId: UUID | null;
      userId: UUID;
      deviceId: UUID;
      locationId: UUID | null;
      documentType: string;
      documentId: UUID;
      action: string;
      amount: Money | null;
      bindingHmac: string;
      pinAttemptsBeforeSuccess: number | null;
      selfieAttachmentId: UUID | null;
      grantedAt: string;
      relayReceivedAt: string | null;
      outcome: OfflineAuthOutcomeRow;
      failureReason: string | null;
    },
  ): Promise<OfflineAuthorizationRow> {
    const res = await client.query<OfflineAuthorizationRow>(
      `INSERT INTO offline_authorizations (
         credential_id, approval_event_id, user_id, device_id, location_id, document_type, document_id,
         action, amount, binding_hmac, pin_attempts_before_success, selfie_attachment_id, granted_at,
         relay_received_at, synced_at, outcome, failure_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
       RETURNING *`,
      [
        row.credentialId, row.approvalEventId, row.userId, row.deviceId, row.locationId, row.documentType,
        row.documentId, row.action, row.amount, row.bindingHmac, row.pinAttemptsBeforeSuccess,
        row.selfieAttachmentId, row.grantedAt, row.relayReceivedAt, row.outcome, row.failureReason,
      ],
    );
    return res.rows[0]!;
  }

  async findByApprovalEvent(client: DbClient, approvalEventId: UUID): Promise<OfflineAuthorizationRow | undefined> {
    const res = await client.query<OfflineAuthorizationRow>(
      `SELECT * FROM offline_authorizations WHERE approval_event_id = $1`,
      [approvalEventId],
    );
    return res.rows[0];
  }

  async recordVerdict(
    client: DbClient,
    id: UUID,
    verdict: OfflineAuthVerdictRow,
    reviewedBy: UUID,
    newOutcome: OfflineAuthOutcomeRow,
  ): Promise<OfflineAuthorizationRow | undefined> {
    const res = await client.query<OfflineAuthorizationRow>(
      `UPDATE offline_authorizations
          SET verdict = $2, reviewed_by = $3, reviewed_at = NOW(), outcome = $4
        WHERE id = $1
        RETURNING *`,
      [id, verdict, reviewedBy, newOutcome],
    );
    return res.rows[0];
  }

  async attachmentExists(client: DbClient, attachmentId: UUID): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM attachments WHERE id = $1`, [attachmentId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** `true` if `roleKey` currently holds `location_id` per `user_locations` (§7.4 check 6, best-effort — see engine note on historical role checks). */
  async userHoldsLocation(client: DbClient, userId: UUID, locationId: UUID): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM user_locations WHERE user_id = $1 AND location_id = $2`,
      [userId, locationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async userIsActive(client: DbClient, userId: UUID): Promise<boolean> {
    const res = await client.query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [userId]);
    return res.rows[0]?.is_active ?? false;
  }
}
