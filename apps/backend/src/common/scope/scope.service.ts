import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/**
 * `null` = unrestricted (central role — sees every location).
 * `string[]` = exactly these `location_id`s (possibly empty: no assignment yet).
 */
export type LocationScope = string[] | null;

/**
 * Role-key string literals from CONTRACTS.md §2.1 (`RoleKey` enum values).
 * Kept as plain strings rather than importing the enum from `@mimi/shared`
 * — see the comment in `common/jwt/jwt-payload.interface.ts` for why. These
 * MUST stay byte-identical to `RoleKey`'s string values and to the RLS
 * `app_is_central()` helper (CONTRACTS §1.14 block 009) if either ever changes.
 */
const CENTRAL_ROLES = new Set(['owner', 'manager', 'finance', 'hr_admin']);

/**
 * Resolves the set of `location_id`s a user may see, from their role and
 * assignments (BUILD-PLAN §5 W1-D):
 *  - Owner / Manager / Finance / HR Admin → all locations (`null`; matches
 *    the RLS helper `app_is_central()` exactly — CONTRACTS §1.14 lists these
 *    four roles, not just the three the BUILD-PLAN prose names).
 *  - Kepala Gudang → their warehouse(s) (`user_locations`) UNION every
 *    outlet a Surat Jalan from that warehouse has ever dropped at
 *    ("shipping destinations").
 *  - Supervisor / Leader-Outlet / Kasir → exactly their `user_locations` assignment.
 *  - Driver → the outlets on their currently active Surat Jalan (status
 *    'ready'|'loading'|'in_transit') plus the warehouse they're loading from.
 *
 * TWO-PHASE SESSION CONTEXT (coordinator decision, superseding this file's
 * earlier "app role owns these tables" assumption — that would have
 * silently disabled RLS for every read this service makes, the worst
 * failure mode in a fraud-control system):
 *   Phase 1 (`RlsContextGuard`, before calling this service): `app.user_id`
 *   and `app.role` are set from the verified JWT — no DB read needed.
 *   Phase 2 (THIS service): every query below runs on the SAME client
 *   `RlsContextGuard` already opened phase 1 on, i.e. UNDER RLS, with
 *   `app.user_id`/`app.role` already live in that transaction. Narrow
 *   self-read policies on `user_locations`, `drivers`, and
 *   `surat_jalan`/`sj_drops` (W1-C, per architect instruction) are what let
 *   a non-owner `app_user` role read exactly its own assignment here — NOT
 *   an RLS exemption. `app.location_ids` itself is set by the guard
 *   AFTER this resolves, from the result.
 *
 * This service takes no DI dependencies (no pooled connection of its own)
 * precisely so it is structurally impossible to query outside the
 * caller-supplied, already-RLS-scoped `client`.
 */
@Injectable()
export class ScopeService {
  async resolveLocationIds(
    client: PoolClient,
    user: { sub: string; roleKey: string },
  ): Promise<LocationScope> {
    if (CENTRAL_ROLES.has(user.roleKey)) return null;

    switch (user.roleKey) {
      case 'kepala_gudang':
        return this.kepalaGudangScope(client, user.sub);
      case 'driver':
        return this.driverScope(client, user.sub);
      case 'supervisor':
      case 'leader_outlet':
      case 'kasir':
      default:
        return this.assignedLocationIds(client, user.sub);
    }
  }

  /**
   * The floor every scoped role gets: their raw `user_locations` assignment.
   * Scoped by the exact `userId` parameter (defense in depth) AND, once
   * W1-C's self-read policy is live, by the `app.user_id` RLS predicate —
   * a user genuinely cannot read another user's assignment row via this
   * query even if `userId` here were ever wrong.
   */
  private async assignedLocationIds(client: PoolClient, userId: string): Promise<string[]> {
    const res = await client.query<{ location_id: string }>(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((r) => r.location_id);
  }

  /** Kepala Gudang: their warehouse(s) + every outlet that warehouse has shipped to. */
  private async kepalaGudangScope(client: PoolClient, userId: string): Promise<string[]> {
    const warehouseIds = await this.assignedLocationIds(client, userId);
    if (warehouseIds.length === 0) return [];

    const res = await client.query<{ location_id: string }>(
      `SELECT DISTINCT d.location_id
         FROM sj_drops d
         JOIN surat_jalan sj ON sj.id = d.sj_id
        WHERE sj.origin_location_id = ANY($1::uuid[])`,
      [warehouseIds],
    );
    return [...new Set([...warehouseIds, ...res.rows.map((r) => r.location_id)])];
  }

  /** Driver: outlets on their active Surat Jalan, plus the warehouse they load from. */
  private async driverScope(client: PoolClient, userId: string): Promise<string[]> {
    const driverRes = await client.query<{ id: string }>(
      `SELECT id FROM drivers WHERE user_id = $1 AND is_active = true`,
      [userId],
    );
    const driverId = driverRes.rows[0]?.id;
    if (!driverId) return [];

    const ACTIVE_SJ_STATUSES = ['ready', 'loading', 'in_transit'];

    const [dropsRes, originsRes] = await Promise.all([
      client.query<{ location_id: string }>(
        `SELECT DISTINCT d.location_id
           FROM sj_drops d
           JOIN surat_jalan sj ON sj.id = d.sj_id
          WHERE sj.driver_id = $1
            AND sj.status = ANY($2::varchar[])`,
        [driverId, ACTIVE_SJ_STATUSES],
      ),
      client.query<{ origin_location_id: string }>(
        `SELECT DISTINCT origin_location_id
           FROM surat_jalan
          WHERE driver_id = $1
            AND status = ANY($2::varchar[])`,
        [driverId, ACTIVE_SJ_STATUSES],
      ),
    ]);

    return [
      ...new Set([
        ...dropsRes.rows.map((r) => r.location_id),
        ...originsRes.rows.map((r) => r.origin_location_id),
      ]),
    ];
  }
}
