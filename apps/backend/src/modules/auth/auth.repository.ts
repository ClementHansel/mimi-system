/**
 * Raw `pg` access for M01 `auth` (CONTRACTS.md §4.1). Parameterized queries
 * only, no ORM (BUILD-PLAN CONSTRAINTS). Every method takes the caller's
 * `PoolClient` — this class holds no pool of its own, matching
 * `ScopeService`'s discipline (structurally impossible to query outside an
 * already-context-scoped connection).
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Money, UUID } from '@mimi/shared';

export interface UserAuthRow {
  id: UUID;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  pin_hash: string | null;
  is_active: boolean;
  role_id: UUID;
  role_key: string;
  role_name: string;
}

export interface LocationDetailRow {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  city: string;
}

export interface SessionRow {
  id: UUID;
  user_id: UUID;
  refresh_token_hash: string;
  device_id: UUID | null;
  expires_at: string;
  revoked_at: string | null;
}

export interface OfflineCredentialInsert {
  credentialId: UUID;
  userId: UUID;
  deviceId: UUID | null;
  roleKey: string;
  locationIds: UUID[];
  scopes: Record<string, { max_idr?: Money }>;
  bindingSecretEnc: Buffer;
  pinVerifier: string;
  selfieRequiredAbove: Money;
  volumeCap: number;
  expiresAt: string;
}

export interface OfflineCredentialRow {
  credential_id: UUID;
  user_id: UUID;
  device_id: UUID | null;
  role_key: string;
  location_ids: UUID[];
  scopes: Record<string, { max_idr?: Money }>;
  expires_at: string;
  revoked_at: string | null;
}

@Injectable()
export class AuthRepository {
  async findUserAuthByUsername(client: PoolClient, username: string): Promise<UserAuthRow | undefined> {
    const res = await client.query<UserAuthRow>(
      `SELECT u.id, u.username, u.name, u.email, u.phone, u.password_hash, u.pin_hash, u.is_active,
              u.role_id, r.key AS role_key, r.name AS role_name
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.username = $1`,
      [username],
    );
    return res.rows[0];
  }

  async findUserAuthById(client: PoolClient, id: UUID): Promise<UserAuthRow | undefined> {
    const res = await client.query<UserAuthRow>(
      `SELECT u.id, u.username, u.name, u.email, u.phone, u.password_hash, u.pin_hash, u.is_active,
              u.role_id, r.key AS role_key, r.name AS role_name
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [id],
    );
    return res.rows[0];
  }

  async touchLastLogin(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
  }

  async rawLocationIds(client: PoolClient, userId: UUID): Promise<UUID[]> {
    const res = await client.query<{ location_id: UUID }>(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((r) => r.location_id);
  }

  async locationDetails(client: PoolClient, userId: UUID): Promise<LocationDetailRow[]> {
    const res = await client.query<LocationDetailRow>(
      `SELECT l.id, l.code, l.name, l.type, l.city
         FROM user_locations ul JOIN locations l ON l.id = ul.location_id
        WHERE ul.user_id = $1
        ORDER BY l.name`,
      [userId],
    );
    return res.rows;
  }

  async employeeIdForUser(client: PoolClient, userId: UUID): Promise<UUID | null> {
    const res = await client.query<{ id: UUID }>(`SELECT id FROM employees WHERE user_id = $1 LIMIT 1`, [userId]);
    return res.rows[0]?.id ?? null;
  }

  async insertSession(
    client: PoolClient,
    row: { id: UUID; userId: UUID; refreshTokenHash: string; deviceId: UUID | null; ipAddress: string | null; userAgent: string | null; expiresAt: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, device_id, ip_address, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.userId, row.refreshTokenHash, row.deviceId, row.ipAddress, row.userAgent, row.expiresAt],
    );
  }

  async findSession(client: PoolClient, sessionId: UUID): Promise<SessionRow | undefined> {
    const res = await client.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);
    return res.rows[0];
  }

  /** Rotates the refresh token in place on a refresh call — `ip_address`/`user_agent` stay as recorded at login (only the token/hash and expiry move). */
  async rotateSession(client: PoolClient, sessionId: UUID, row: { refreshTokenHash: string; expiresAt: string }): Promise<void> {
    await client.query(`UPDATE sessions SET refresh_token_hash = $2, expires_at = $3 WHERE id = $1`, [
      sessionId,
      row.refreshTokenHash,
      row.expiresAt,
    ]);
  }

  async revokeSession(client: PoolClient, sessionId: UUID): Promise<void> {
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  }

  async revokeAllSessionsForUser(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }

  async updatePinHash(client: PoolClient, userId: UUID, pinHash: string): Promise<void> {
    await client.query(`UPDATE users SET pin_hash = $2 WHERE id = $1`, [userId, pinHash]);
  }

  async getSettingValue<T>(client: PoolClient, key: string): Promise<T | undefined> {
    const res = await client.query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key]);
    return res.rows[0]?.value;
  }

  /**
   * §7.2 scope cap derivation: the MIN_AMOUNT of the next escalation step
   * above `approverRole`'s own step for `documentType`, if the chain defines
   * one (`approval_chain_steps`, seeded from CONTRACTS.md §5). `null` when
   * `approverRole` has no step at all, or no further step exists above it —
   * both read as "uncapped" by the caller, matching SYNC-PROTOCOL §7.2's own
   * example (`replenishment.supervisor_approve: {}`, no `maxIdr`).
   */
  async nextStepMinAmount(client: PoolClient, documentType: string, approverRole: string): Promise<Money | null> {
    const res = await client.query<{ min_amount: Money | null }>(
      `SELECT next.min_amount
         FROM approval_chain_steps mine
         JOIN approval_chain_steps next
           ON next.document_type = mine.document_type AND next.step_no = mine.step_no + 1
        WHERE mine.document_type = $1 AND mine.approver_role = $2`,
      [documentType, approverRole],
    );
    return res.rows[0]?.min_amount ?? null;
  }

  /** Supersedes (revokes) any still-live credential for this exact (user, device) pair before minting a fresh one — "mints (or refreshes)" (§7.2). */
  async revokeLiveCredentialsForUserDevice(client: PoolClient, userId: UUID, deviceId: UUID | null): Promise<void> {
    await client.query(
      `UPDATE offline_credentials
          SET revoked_at = NOW()
        WHERE user_id = $1 AND device_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [userId, deviceId],
    );
  }

  async insertOfflineCredential(client: PoolClient, row: OfflineCredentialInsert): Promise<OfflineCredentialRow> {
    const res = await client.query<OfflineCredentialRow>(
      `INSERT INTO offline_credentials
         (credential_id, user_id, device_id, role_key, location_ids, scopes, binding_secret_enc,
          pin_verifier, selfie_required_above, volume_cap, expires_at)
       VALUES ($1,$2,$3,$4,$5::uuid[],$6::jsonb,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        row.credentialId,
        row.userId,
        row.deviceId,
        row.roleKey,
        row.locationIds,
        JSON.stringify(row.scopes),
        row.bindingSecretEnc,
        row.pinVerifier,
        row.selfieRequiredAbove,
        row.volumeCap,
        row.expiresAt,
      ],
    );
    return res.rows[0]!;
  }

  async findOfflineCredential(client: PoolClient, credentialId: UUID): Promise<OfflineCredentialRow | undefined> {
    const res = await client.query<OfflineCredentialRow>(`SELECT * FROM offline_credentials WHERE credential_id = $1`, [credentialId]);
    return res.rows[0];
  }

  async revokeOfflineCredential(client: PoolClient, credentialId: UUID): Promise<void> {
    await client.query(`UPDATE offline_credentials SET revoked_at = NOW() WHERE credential_id = $1 AND revoked_at IS NULL`, [credentialId]);
  }

  async revokeAllOfflineCredentialsForUser(client: PoolClient, userId: UUID): Promise<void> {
    await client.query(`UPDATE offline_credentials SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }
}
