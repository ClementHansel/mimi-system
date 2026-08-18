import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { isTempBreach, type Temp, type TempLog, type UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { withSystemContext } from '../system-context';
import {
  COLD_CHAIN_STORAGE_TYPES,
  requiredAreaTypeFor,
  type ItemStorageType,
} from '../storage-type.util';

export interface ShipmentTypeRow {
  id: string;
  key: 'frozen' | 'dry';
  name: string;
  requires_temperature_log: boolean;
  requires_seal: boolean;
  temp_min: string | null;
  temp_max: string | null;
}

/** A cold-chain goods class (`items.storage_type` restricted to the two classes a 'frozen' truck may carry) paired with the temperature range that class must stay within, per D-15's `storage_areas` (the owner's answer, 2026-08-17: "move the range off the shipment type and onto the goods"). */
export interface CargoClassRange {
  storageType: 'frozen' | 'chilled';
  tempMin: string | null;
  tempMax: string | null;
}

/** Indonesian label for a goods class in the `cold_chain_breach` notification (`{{goodsClass}}`) — the ONE place this backend renders user-facing text is `kernel/notification/i18n/id-ID.ts`; this is data (a param value), not template copy. */
const GOODS_CLASS_LABEL_ID: Record<'frozen' | 'chilled', string> = {
  frozen: 'barang beku (frozen)',
  chilled: 'barang chiller (chilled)',
};

/**
 * Cold-chain evaluation (D-14, OBJ-03) shared by the SJ load step, per-drop
 * depart/arrive, and the standalone `/temperature-logs` endpoint: writes an
 * append-only `sj_temperature_logs` row and computes breach PER GOODS CLASS
 * present onboard, not against a single static shipment-type range.
 *
 * Why: the owner confirmed (2026-08-17) that Indonesia's cold truck ALWAYS
 * has a chiller, so `shipment_types.key = 'frozen'` means "the cold-chain
 * vehicle" and legitimately carries BOTH frozen (-25..-15) and chilled
 * (0..5) goods in the SAME run. Checking a single reading against one static
 * range (the old behavior) meant either the truck runs at freezer temp and
 * ruins the chilled goods, or it runs at chiller temp and EVERY frozen-truck
 * reading gets flagged — training drivers to ignore the alert, which defeats
 * the whole audit trail this table exists for.
 *
 * The fix: resolve which classes ('frozen'/'chilled') are actually onboard
 * for the reading being taken (`resolveOnboardClassRanges`), pull each
 * class's range from the ORIGIN warehouse's `storage_areas` (D-15's own
 * per-area temp_min/max — the "natural source of truth... an item's storage
 * area tells you the range it must be kept in"), and flag a breach PER CLASS
 * that the single physical reading falls outside of. A mixed load only
 * "passes" when the reading satisfies every class still onboard; a genuine
 * breach names exactly which class it's about (`cold_chain_breach`'s new
 * `{{goodsClass}}` param) rather than a bare "temperature out of range".
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
    if (!sj)
      throw new NotFoundException({
        code: 'ERR_NOT_FOUND',
        message: `Surat Jalan ${params.sjId} not found`,
      });

    let locationId = sj.origin_location_id;
    let locationName = 'Gudang Pusat';
    let dropSeq: number | null = null;
    if (params.dropId) {
      const dropRes = await client.query<{
        location_id: string;
        location_name: string;
        drop_seq: number;
      }>(
        `SELECT d.location_id, l.name AS location_name, d.drop_seq FROM sj_drops d JOIN locations l ON l.id = d.location_id WHERE d.id = $1 AND d.sj_id = $2`,
        [params.dropId, params.sjId],
      );
      const drop = dropRes.rows[0];
      if (!drop)
        throw new NotFoundException({
          code: 'ERR_NOT_FOUND',
          message: `Drop ${params.dropId} not found on Surat Jalan ${params.sjId}`,
        });
      locationId = drop.location_id;
      locationName = drop.location_name;
      dropSeq = drop.drop_seq;
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
      originLocationId: sj.origin_location_id,
      dropSeq,
      notifyUserIds: recipients,
    });

    await this.syncEmit.emit(client, {
      entity: 'sj_temperature_logs',
      op: 'logged',
      entityId: id,
      locationId,
      actorUserId,
      data: {
        sjId: params.sjId,
        dropId: params.dropId ?? undefined,
        stage: params.stage,
        tempC: params.tempC,
      },
    });

    const nameRes = await client.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [
      actorUserId,
    ]);
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
    const res = await client.query<ShipmentTypeRow>(`SELECT * FROM shipment_types WHERE id = $1`, [
      shipmentTypeId,
    ]);
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
      /** The gudang pusat this SJ originates from (D-05: THE scoping dimension) — cold-chain ranges are read from ITS `storage_areas` (D-15), never the destination outlet's, matching every other cold-chain/putaway check in this module (`assertLinesMatchShipmentType`, `dispatch()`'s `resolveArea`). */
      originLocationId: UUID;
      /**
       * `null` at `stage: 'load'` (dropId is also null there — the whole SJ is
       * still on the truck, nothing dropped off yet). Otherwise the drop this
       * reading is FOR (`sj_drops.drop_seq`) — the onboard cargo at that point
       * is every line whose drop hasn't been handed off yet, i.e.
       * `drop_seq >= dropSeq` (see `resolveOnboardClassRanges`).
       */
      dropSeq: number | null;
      notifyUserIds: UUID[];
      clientId?: UUID;
      loggedAt?: string;
    },
  ): Promise<{ id: string; isBreach: boolean }> {
    const classRanges =
      params.shipmentType.key === 'frozen'
        ? await this.resolveOnboardClassRanges(
            client,
            params.sjId,
            params.originLocationId,
            params.dropSeq,
          )
        : [];
    const breaches = classRanges.filter((r) => isTempBreach(params.tempC, r.tempMin, r.tempMax));
    const isBreach = breaches.length > 0;
    // Machine-parseable breach detail — WHICH class(es), not just the bare boolean (the actionability this
    // whole redesign is for: "frozen items exceeded -15°C" vs "temperature out of range"). `notes` already
    // exists on `sj_temperature_logs` (migration 035) and was never populated by any caller — carrying this
    // here needed no schema change. FE surfacing of this detail is still a follow-up: `TempLog`
    // (`@mimi/shared`) only has `isBreach: boolean` today; flagged to the architect/W1-C, not improvised here.
    const notes = isBreach
      ? JSON.stringify({
          breachedClasses: breaches.map((b) => b.storageType),
          ranges: Object.fromEntries(
            breaches.map((b) => [b.storageType, { min: b.tempMin, max: b.tempMax }]),
          ),
        })
      : null;

    const res = await client.query<{ id: string }>(
      `INSERT INTO sj_temperature_logs (sj_id, drop_id, stage, temp_c, is_breach, logged_by, client_id, logged_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9)
       ON CONFLICT (client_id) DO NOTHING
       RETURNING id`,
      [
        params.sjId,
        params.dropId,
        params.stage,
        params.tempC,
        isBreach,
        params.loggedBy,
        params.clientId ?? null,
        params.loggedAt ?? null,
        notes,
      ],
    );

    // `ON CONFLICT ... DO NOTHING` yields no row on an idempotent replay (same `client_id`) — read back
    // the existing row rather than treat a replay as "no id to report".
    const id =
      res.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          `SELECT id FROM sj_temperature_logs WHERE client_id = $1`,
          [params.clientId ?? null],
        )
      ).rows[0]?.id;
    if (!id) throw new Error('sj_temperature_logs insert did not return an id');

    // One notification PER breached class (never a combined "chilled+frozen" message): a single truck
    // reading can breach BOTH classes at once (e.g. a hot reading blows past both the freezer's -15 max and
    // the chiller's 5 max), and each is its own actionable fact for Kepala Gudang/Manager/Owner to act on.
    if (params.notifyUserIds.length > 0) {
      for (const breach of breaches) {
        await this.notifications.notify({
          templateKey: 'cold_chain_breach',
          userIds: params.notifyUserIds,
          locationId: params.locationId ?? undefined,
          params: {
            recordedTemp: params.tempC,
            minTemp: breach.tempMin ?? '',
            maxTemp: breach.tempMax ?? '',
            goodsClass: GOODS_CLASS_LABEL_ID[breach.storageType],
            context: `Surat Jalan ${params.sjId}${params.dropId ? ` / drop ${params.dropId}` : ''} (${params.stage})`,
            locationName: params.locationName,
          },
        });
      }
    }

    return { id, isBreach };
  }

  /**
   * Resolves the temperature range(s) that apply to a specific reading: the
   * distinct `items.storage_type` classes ('frozen'/'chilled' — 'dry' never
   * needs a range) still onboard, each paired with the ORIGIN warehouse's
   * `storage_areas` range for that class (D-15 — "an item's storage area
   * tells you the range it must be kept in").
   *
   * Onboard scope by stage:
   *  - `minDropSeq === null` (stage 'load'): the WHOLE SJ — nothing has been
   *    dropped off yet, so every line on every drop is still on the truck.
   *  - `minDropSeq` set (stage 'depart'/'arrive' for that drop): every line
   *    whose drop hasn't been handed off yet, `drop_seq >= minDropSeq` —
   *    departing for/arriving at drop N still has drop N's own cargo AND
   *    every later drop's cargo aboard; only completed/failed drops (always
   *    `drop_seq < minDropSeq` at this point in the route) have left the
   *    truck. This is what lets a mixed-cargo SJ narrow to "frozen only" once
   *    its chilled drop is done, rather than checking a class that already
   *    left.
   *
   * Picks the first active area of each type at the origin (ORDER BY
   * `sort_order` — same tie-break `dispatch()`'s `resolveArea` and
   * `reverseFailedDropStock` already use for the identical "one canonical
   * area per type per location" assumption).
   */
  private async resolveOnboardClassRanges(
    client: PoolClient,
    sjId: UUID,
    originLocationId: UUID,
    minDropSeq: number | null,
  ): Promise<CargoClassRange[]> {
    const classesRes = await client.query<{ storage_type: ItemStorageType }>(
      `SELECT DISTINCT i.storage_type
         FROM sj_lines sl
         JOIN items i ON i.id = sl.item_id
         JOIN sj_drops d ON d.id = sl.drop_id
        WHERE sl.sj_id = $1
          AND i.storage_type = ANY($2::text[])
          AND ($3::int IS NULL OR d.drop_seq >= $3)`,
      [sjId, COLD_CHAIN_STORAGE_TYPES, minDropSeq],
    );

    const ranges: CargoClassRange[] = [];
    for (const row of classesRes.rows) {
      const storageType = row.storage_type as 'frozen' | 'chilled';
      const areaRes = await client.query<{ temp_min: string | null; temp_max: string | null }>(
        `SELECT temp_min, temp_max FROM storage_areas WHERE location_id = $1 AND type = $2 AND is_active = true ORDER BY sort_order ASC LIMIT 1`,
        [originLocationId, requiredAreaTypeFor(storageType)],
      );
      const area = areaRes.rows[0];
      if (!area) continue; // no active area of this type at origin — same "already have blocked dispatch" reasoning as reverseFailedDropStock; nothing to check against
      ranges.push({ storageType, tempMin: area.temp_min, tempMax: area.temp_max });
    }
    return ranges;
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
