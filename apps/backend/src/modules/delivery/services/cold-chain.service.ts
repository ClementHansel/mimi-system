import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { isTempBreach, type Temp, type TempLog, type UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { withSystemContext } from '../system-context';

export interface ShipmentTypeRow {
  id: string;
  key: 'frozen' | 'dry';
  name: string;
  requires_temperature_log: boolean;
  requires_seal: boolean;
  temp_min: string | null;
  temp_max: string | null;
}

/**
 * Cold-chain evaluation (D-14, OBJ-03) shared by the SJ load step, per-drop
 * depart/arrive, and the standalone `/temperature-logs` endpoint: writes an
 * append-only `sj_temperature_logs` row, computes `is_breach` against the
 * shipment type's seeded range (`shipment_types.temp_min/max` — frozen
 * -25.0..-15.0), and on breach raises the `cold_chain_breach` notification to
 * Kepala Gudang + Manager + Owner (kernel template already registered).
 */
@Injectable()
export class ColdChainService {
  constructor(
    private readonly notifications: NotificationService,
    private readonly syncEmit: SyncEmitService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * `POST /api/delivery/temperature-logs` — the standalone log endpoint
   * (CONTRACTS.md §4.10), used when a reading isn't tied to a specific
   * depart/arrive/load action (e.g. a mid-route check). Resolves the SJ's
   * shipment type and the reading's location (the drop's outlet, or the
   * warehouse when `dropId` is omitted) itself, then delegates to
   * `logTemperature`.
   */
  async recordStandalone(
    client: PoolClient,
    params: { sjId: UUID; dropId: UUID | null; stage: 'load' | 'depart' | 'arrive'; tempC: Temp },
    actorUserId: UUID,
  ): Promise<TempLog> {
    const sjRes = await client.query<{ shipment_type_id: string; origin_location_id: string }>(
      `SELECT shipment_type_id, origin_location_id FROM surat_jalan WHERE id = $1`,
      [params.sjId],
    );
    const sj = sjRes.rows[0];
    if (!sj) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Surat Jalan ${params.sjId} not found` });

    let locationId = sj.origin_location_id;
    let locationName = 'Gudang Pusat';
    if (params.dropId) {
      const dropRes = await client.query<{ location_id: string; location_name: string }>(
        `SELECT d.location_id, l.name AS location_name FROM sj_drops d JOIN locations l ON l.id = d.location_id WHERE d.id = $1 AND d.sj_id = $2`,
        [params.dropId, params.sjId],
      );
      const drop = dropRes.rows[0];
      if (!drop) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Drop ${params.dropId} not found on Surat Jalan ${params.sjId}` });
      locationId = drop.location_id;
      locationName = drop.location_name;
    }

    const shipmentType = await this.loadShipmentType(client, sj.shipment_type_id);
    const recipients = await this.resolveBreachRecipients(client, sj.origin_location_id);
    const { id, isBreach } = await this.logTemperature(client, {
      sjId: params.sjId,
      dropId: params.dropId,
      stage: params.stage,
      tempC: params.tempC,
      loggedBy: actorUserId,
      shipmentType,
      locationName,
      locationId,
      notifyUserIds: recipients,
    });

    await this.syncEmit.emit(client, {
      entity: 'sj_temperature_logs',
      op: 'logged',
      entityId: id,
      locationId,
      actorUserId,
      data: { sjId: params.sjId, dropId: params.dropId ?? undefined, stage: params.stage, tempC: params.tempC },
    });

    const nameRes = await client.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [actorUserId]);
    return {
      id,
      dropId: params.dropId,
      stage: params.stage,
      tempC: params.tempC,
      isBreach,
      loggedBy: nameRes.rows[0]?.name ?? actorUserId,
      loggedAt: new Date().toISOString(),
    };
  }

  async loadShipmentType(client: PoolClient, shipmentTypeId: string): Promise<ShipmentTypeRow> {
    const res = await client.query<ShipmentTypeRow>(`SELECT * FROM shipment_types WHERE id = $1`, [shipmentTypeId]);
    const row = res.rows[0];
    if (!row) throw new Error(`shipment_types/${shipmentTypeId} not found`);
    return row;
  }

  /**
   * Inserts the temperature log row and, on breach, fires the notification.
   * Returns the created row's id and whether it was a breach. Caller supplies
   * the already-loaded `shipmentType` (avoids refetching on every drop stage
   * within one SJ's lifecycle).
   *
   * `loggedAt`: for the ONLINE/REST callers this is naturally "now" (the
   * column's own `DEFAULT NOW()` is fine — omit it). For the OFFLINE/sync
   * projector path, the caller MUST pass an explicit, STABLE value (the
   * event's defensible server-witnessed time, `relay_received_at` read back
   * from `sync_events` — never a freshly-computed `new Date()`): a cold-chain
   * reading's timing is evidence, and a projector that re-stamps `NOW()` on
   * every re-projection retry of the SAME event silently rewrites "when we
   * learned about it" on each replay, which is exactly the defensibility bug
   * this parameter exists to prevent (coordinator finding, cross-referencing
   * W3-09's projector).
   */
  async logTemperature(
    client: PoolClient,
    params: {
      sjId: UUID;
      dropId: UUID | null;
      stage: 'load' | 'depart' | 'arrive';
      tempC: Temp;
      loggedBy: UUID | null;
      shipmentType: ShipmentTypeRow;
      locationName: string;
      locationId: UUID | null;
      notifyUserIds: UUID[];
      clientId?: UUID;
      loggedAt?: string;
    },
  ): Promise<{ id: string; isBreach: boolean }> {
    const isBreach = isTempBreach(params.tempC, params.shipmentType.temp_min, params.shipmentType.temp_max);

    const res = await client.query<{ id: string }>(
      `INSERT INTO sj_temperature_logs (sj_id, drop_id, stage, temp_c, is_breach, logged_by, client_id, logged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
       ON CONFLICT (client_id) DO NOTHING
       RETURNING id`,
      [params.sjId, params.dropId, params.stage, params.tempC, isBreach, params.loggedBy, params.clientId ?? null, params.loggedAt ?? null],
    );

    // `ON CONFLICT ... DO NOTHING` yields no row on an idempotent replay (same `client_id`) — read back
    // the existing row rather than treat a replay as "no id to report".
    const id =
      res.rows[0]?.id ??
      (
        await client.query<{ id: string }>(`SELECT id FROM sj_temperature_logs WHERE client_id = $1`, [params.clientId ?? null])
      ).rows[0]?.id;
    if (!id) throw new Error('sj_temperature_logs insert did not return an id');

    if (isBreach && params.notifyUserIds.length > 0) {
      await this.notifications.notify({
        templateKey: 'cold_chain_breach',
        userIds: params.notifyUserIds,
        locationId: params.locationId ?? undefined,
        params: {
          recordedTemp: params.tempC,
          minTemp: params.shipmentType.temp_min ?? '',
          maxTemp: params.shipmentType.temp_max ?? '',
          context: `Surat Jalan ${params.sjId}${params.dropId ? ` / drop ${params.dropId}` : ''} (${params.stage})`,
          locationName: params.locationName,
        },
      });
    }

    return { id, isBreach };
  }

  /**
   * Owner + Manager (global) + Kepala Gudang assigned to `warehouseLocationId`
   * — the cold-chain-breach recipient set (D-14, migration comment: "is_breach
   * ⇒ NotificationService 'cold_chain_breach' to KGD + Manager + Owner").
   *
   * Deliberately does NOT run on the caller's own RLS-scoped `request.dbClient`:
   * `users`/`roles`/`user_locations`' SELECT policy (migration 009) is
   * `ROLE(owner,manager,hr_admin,finance) OR self` — a driver or Kepala
   * Gudang session (the common case: a driver logging an in-transit reading,
   * or KGD loading at the warehouse) would see ONLY their own row, so this
   * lookup would silently return an empty recipient list under the acting
   * user's own scope. Uses `system-context.ts`'s `withSystemContext` — a
   * short-lived, separately-opened connection with `SET LOCAL ROLE app_user`
   * + the central 'owner' role asserted, the SAME pattern
   * `kernel/sync`'s and `modules/inventory/low-stock`'s system-context
   * helpers use for their own cross-location background work. This is a
   * single, explicit, narrowly-scoped elevation for a cross-cutting concern
   * (never the D-21/D-22 anti-pattern of a production connection identity
   * that silently bypasses RLS for every request) — critically, it is NOT a
   * bare `this.pool.query()`: without the `SET LOCAL ROLE app_user` +
   * `set_config` calls `withSystemContext` performs, `mimi_app` holds zero
   * table grants of its own (migrations 203/205) and every query below would
   * fail outright with `permission denied`, not merely under-scope.
   */
  async resolveBreachRecipients(_client: PoolClient, warehouseLocationId: UUID): Promise<UUID[]> {
    return withSystemContext(this.pool, async (conn) => {
      const res = await conn.query<{ id: string }>(
        `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
          WHERE r.key IN ('owner', 'manager')
         UNION
         SELECT u.id FROM users u
          JOIN roles r ON r.id = u.role_id
          JOIN user_locations ul ON ul.user_id = u.id
          WHERE r.key = 'kepala_gudang' AND ul.location_id = $1`,
        [warehouseLocationId],
      );
      return res.rows.map((r) => r.id);
    });
  }
}
