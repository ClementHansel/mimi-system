/**
 * `pairing_tokens` (CONTRACTS.md block 110-119, §7.1/§7.2) — minted by an
 * authenticated user (`device.pair`/`node.manage`), redeemed exactly once by
 * a device or a branch node over its OWN public registration endpoint.
 * Shared by BOTH `device-registry` (`POST /api/devices/pairing-tokens`,
 * `/api/devices/register`) and `node-gateway` (`POST /api/nodes/pairing-
 * tokens`, `/api/nodes/register`) — one table, one `target_type` CHECK
 * discriminator (CONTRACTS §7.1: "Branch nodes... pair identically via
 * `targetType:'node'` tokens"), so this service lives in `device-registry`
 * and `node-gateway` imports `DeviceRegistryModule` to reuse it rather than
 * re-implementing single-use redemption twice.
 *
 * Hashing reuses `kernel/sync`'s `hashDeviceToken` (sha256) — the SAME
 * function that hashes device/node long-lived tokens, so there is exactly
 * one "how do we hash a bearer secret before it touches the database"
 * convention in this codebase, not three.
 */
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PairingTargetType, UUID } from '@mimi/shared';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';

const PAIRING_TOKEN_TTL_MS = 15 * 60 * 1000; // §7.2/§4.21: "+15 min, single-use"
const DISPLAY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — human-typable (AIRE pattern)

export interface MintedPairingToken {
  tokenId: UUID;
  token: string;
  displayCode: string;
  qrPayload: string;
  expiresAt: string;
}

export interface RedeemedPairingToken {
  id: UUID;
  locationId: UUID;
  targetType: `${PairingTargetType}`;
  suggestedCategory: string | null;
  createdBy: UUID;
}

function randomDisplayCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++)
    out += DISPLAY_CODE_ALPHABET[bytes[i]! % DISPLAY_CODE_ALPHABET.length];
  return out;
}

/**
 * The human side of `randomDisplayCode()`: an admin reads the 12 characters
 * out loud, the operator types them back with spaces, dashes or lowercase.
 * Uppercase and strip everything outside `A-Z0-9` so `abc-def-ghi-jk` and
 * `ABC DEF GHI JK` both become the stored code. Callers pass the result as a
 * `display_code` candidate only when it is 1..12 chars — that bound is what
 * stops a 48-char raw token from ever being compared as a `display_code`.
 */
export function normalizeDisplayCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
@Injectable()
export class PairingTokensService {
  /** Mint — runs on the caller's OWN RLS transaction (`req.dbClient`); `pairing_tokens` carries no RLS policy (API-gated), so any authenticated actor holding the right permission key may write it for a location within their scope (enforced by the controller, not this service). */
  async mint(
    client: PoolClient,
    params: {
      targetType: `${PairingTargetType}`;
      locationId: UUID;
      createdBy: UUID;
      suggestedCategory?: string | null;
    },
  ): Promise<MintedPairingToken> {
    const token = randomBytes(24).toString('hex');
    const displayCode = randomDisplayCode();
    const expiresAt = new Date(Date.now() + PAIRING_TOKEN_TTL_MS).toISOString();

    const res = await client.query<{ id: UUID }>(
      `INSERT INTO pairing_tokens (token_hash, display_code, target_type, location_id, suggested_category, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        hashDeviceToken(token),
        displayCode,
        params.targetType,
        params.locationId,
        params.suggestedCategory ?? null,
        params.createdBy,
        expiresAt,
      ],
    );

    return {
      tokenId: res.rows[0]!.id,
      token,
      displayCode,
      qrPayload: `mimi-pair:${params.targetType}:${token}`,
      expiresAt,
    };
  }

  /**
   * Atomically claims the token (`used_at IS NULL AND revoked_at IS NULL AND
   * expires_at > NOW()`), so two concurrent redemption attempts for the same
   * token can never both succeed — the `UPDATE ... RETURNING` is the single
   * source of truth for "was this token still valid," not a separate
   * SELECT-then-UPDATE that would race.
   *
   * The submitted identifier may be EITHER the raw 48-char token (machine
   * callers: `/api/nodes/register`, `/api/devices/register` with `token`) OR
   * the 12-char human display code an admin reads out loud and an operator
   * types into the POS pairing screen — the display code is redeemable by a
   * human. Both are matched in the same statement (`token_hash = $1 OR
   * display_code = $2`), so single-use semantics are unchanged and there is no
   * read-then-write window between the two lookups. `$2` is `null` whenever
   * the normalized candidate is not 1..12 chars, which makes it impossible for
   * a raw token to accidentally match some display code.
   *
   * Returns `undefined` on an unknown/expired/already-used/revoked/wrong-target-
   * type identifier; the caller (register endpoint) treats all of those
   * identically (§4.21/§4.22: opaque "invalid or expired token" — never leaks
   * WHICH reason to a public, unauthenticated caller).
   */
  async redeem(
    client: PoolClient,
    identifier: string,
    targetType: `${PairingTargetType}`,
  ): Promise<RedeemedPairingToken | undefined> {
    const normalized = normalizeDisplayCode(identifier);
    const displayCode = normalized.length >= 1 && normalized.length <= 12 ? normalized : null;
    const res = await client.query<{
      id: UUID;
      location_id: UUID;
      target_type: string;
      suggested_category: string | null;
      created_by: UUID;
    }>(
      `UPDATE pairing_tokens
          SET used_at = NOW()
        WHERE (token_hash = $1 OR display_code = $2) AND target_type = $3
          AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
        RETURNING id, location_id, target_type, suggested_category, created_by`,
      [hashDeviceToken(identifier), displayCode, targetType],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      locationId: row.location_id,
      targetType: row.target_type as `${PairingTargetType}`,
      suggestedCategory: row.suggested_category,
      createdBy: row.created_by,
    };
  }

  /** Cosmetic traceability only (`used_by_ref` -> the `devices`/`branch_nodes` row this token became) — never gates anything; `redeem`'s `used_at` claim already is the security boundary. */
  async recordUsedBy(client: PoolClient, tokenId: UUID, usedByRef: UUID): Promise<void> {
    await client.query(`UPDATE pairing_tokens SET used_by_ref = $2 WHERE id = $1`, [
      tokenId,
      usedByRef,
    ]);
  }
}
