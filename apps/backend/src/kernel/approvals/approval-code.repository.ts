import { Injectable } from '@nestjs/common';
import type { ApprovalDocumentType, UUID } from '@mimi/shared';
import type { DbClient } from './types';

/**
 * B-15 — persistence for one-time approval codes.
 *
 * `code_hash` leaves this file in exactly ONE method (`findActiveForVerify`)
 * and is never part of any shape a controller can return. That is deliberate:
 * the code is low-entropy by design (six digits a human reads over the phone),
 * so its only protection is that a database read cannot hand back a live
 * authorization.
 */

export interface ApprovalCodeRow {
  id: UUID;
  documentType: string;
  documentId: UUID;
  locationId: UUID | null;
  issuedByUserId: UUID;
  issuedByRole: string;
  redeemableByUserId: UUID;
  state: 'active' | 'consumed' | 'superseded' | 'expired';
  expiresAt: string;
  attemptCount: number;
  createdAt: string;
}

/** The only shape that carries the hash — used by verification, nothing else. */
export interface ApprovalCodeVerifyRow extends ApprovalCodeRow {
  codeHash: string;
}

interface RawRow {
  id: string;
  document_type: string;
  document_id: string;
  location_id: string | null;
  issued_by_user_id: string;
  issued_by_role: string;
  redeemable_by_user_id: string;
  code_hash: string;
  state: string;
  expires_at: Date;
  consumed_at: Date | null;
  attempt_count: number;
  created_at: Date;
}

function mapRow(row: RawRow): ApprovalCodeVerifyRow {
  return {
    id: row.id as UUID,
    documentType: row.document_type,
    documentId: row.document_id as UUID,
    locationId: (row.location_id as UUID | null) ?? null,
    issuedByUserId: row.issued_by_user_id as UUID,
    issuedByRole: row.issued_by_role,
    redeemableByUserId: row.redeemable_by_user_id as UUID,
    codeHash: row.code_hash,
    state: row.state as ApprovalCodeRow['state'],
    expiresAt: row.expires_at.toISOString(),
    attemptCount: row.attempt_count,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Strips the hash — what every non-verification caller gets.
 *
 * Field-by-field rather than a rest-spread: a spread would silently start
 * leaking any hash-like column added to this row type later, and this is the
 * one function whose whole job is to make sure that cannot happen.
 */
export function withoutHash(row: ApprovalCodeVerifyRow): ApprovalCodeRow {
  return {
    id: row.id,
    documentType: row.documentType,
    documentId: row.documentId,
    locationId: row.locationId,
    issuedByUserId: row.issuedByUserId,
    issuedByRole: row.issuedByRole,
    redeemableByUserId: row.redeemableByUserId,
    state: row.state,
    expiresAt: row.expiresAt,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class ApprovalCodeRepository {
  /**
   * Retires whatever live code this document has, so `insert` can claim the
   * partial unique index. Two separate reasons a row gets retired here, and
   * the distinction is kept because it is the difference between "the
   * supervisor re-sent it" and "nobody used it in time":
   *   - past `expires_at` → `expired`
   *   - still valid but being replaced → `superseded`
   */
  async retireActive(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: UUID,
  ): Promise<void> {
    await client.query(
      `UPDATE approval_codes
          SET state = CASE WHEN expires_at <= NOW() THEN 'expired' ELSE 'superseded' END
        WHERE document_type = $1 AND document_id = $2 AND state = 'active'`,
      [documentType, documentId],
    );
  }

  async insert(
    client: DbClient,
    input: {
      documentType: ApprovalDocumentType;
      documentId: UUID;
      locationId: UUID | null;
      issuedByUserId: UUID;
      issuedByRole: string;
      redeemableByUserId: UUID;
      codeHash: string;
      expiresAt: Date;
    },
  ): Promise<ApprovalCodeRow> {
    const res = await client.query<RawRow>(
      `INSERT INTO approval_codes
         (document_type, document_id, location_id, issued_by_user_id, issued_by_role,
          redeemable_by_user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.documentType,
        input.documentId,
        input.locationId,
        input.issuedByUserId,
        input.issuedByRole,
        input.redeemableByUserId,
        input.codeHash,
        input.expiresAt,
      ],
    );
    return withoutHash(mapRow(res.rows[0]!));
  }

  /**
   * The live code for a document, locked `FOR UPDATE` so two simultaneous
   * redemptions of the same code cannot both pass verification and both
   * approve. Expiry is evaluated in the SERVICE, not filtered out here, so a
   * lapsed code can be reported as expired rather than as "no code issued" —
   * two different things to the person at the till.
   */
  async findActiveForVerify(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: UUID,
  ): Promise<ApprovalCodeVerifyRow | null> {
    const res = await client.query<RawRow>(
      `SELECT * FROM approval_codes
        WHERE document_type = $1 AND document_id = $2 AND state = 'active'
        FOR UPDATE`,
      [documentType, documentId],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  async recordAttempt(client: DbClient, codeId: UUID): Promise<void> {
    await client.query(
      `UPDATE approval_codes SET attempt_count = attempt_count + 1 WHERE id = $1`,
      [codeId],
    );
  }

  async markConsumed(client: DbClient, codeId: UUID): Promise<void> {
    await client.query(
      `UPDATE approval_codes SET state = 'consumed', consumed_at = NOW() WHERE id = $1`,
      [codeId],
    );
  }

  async markExpired(client: DbClient, codeId: UUID): Promise<void> {
    await client.query(`UPDATE approval_codes SET state = 'expired' WHERE id = $1`, [codeId]);
  }
}
