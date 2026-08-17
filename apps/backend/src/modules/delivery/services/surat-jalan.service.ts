import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  ERR_SHIPMENT_TYPE_MIX,
  ERR_VALIDATION,
  JournalEventType,
  MovementType,
  RoleKey,
  businessDateOf,
  formatCloudDocNumber,
  isNegativeQty,
  isZeroQty,
  mulMoneyByQty,
  sumMoney,
  type Money,
  type Paginated,
  type Qty,
  type SuratJalan,
  type UUID,
} from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import type { PostMovementInput } from '../../../kernel/stock-ledger/stock-ledger.types';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { withWrite } from '../db-tx';
import { requiredAreaTypeFor } from '../storage-type.util';
import {
  buildSuratJalanFull,
  buildSuratJalanSummary,
  selectLinesForSj,
  selectSuratJalanHeader,
  selectSuratJalanHeaderForUpdate,
  type SuratJalanHeaderRow,
} from '../queries';
import { CreateSuratJalanDto, ListSuratJalanQueryDto, LoadSuratJalanDto, UpdateSuratJalanDto } from '../dto/surat-jalan.dto';
import { ColdChainService } from './cold-chain.service';
import { REPLENISHMENT_FULFILLMENT_PORT, type ReplenishmentFulfillmentPort } from '../ports/replenishment-fulfillment.port';

/** SJ's own status state machine (CONTRACTS.md §4.10) — `surat_jalan` has no `ApprovalDocumentType` entry (APR-04 is a plain RBAC gate, not a chain, per CONTRACTS §3 footer), so this tiny table lives here rather than in `@mimi/shared`. */
const SJ_TRANSITIONS: Record<string, string[]> = {
  ready: ['draft'],
  load: ['ready'],
  dispatch: ['loading'],
  cancel: ['draft', 'ready', 'loading'],
};

@Injectable()
export class SuratJalanService {
  constructor(
    private readonly syncEmit: SyncEmitService,
    private readonly stockLedger: StockLedgerService,
    private readonly eventBus: EventBus,
    private readonly coldChain: ColdChainService,
    @Inject(REPLENISHMENT_FULFILLMENT_PORT) private readonly replenishment: ReplenishmentFulfillmentPort,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────

  async list(client: PoolClient, query: ListSuratJalanQueryDto): Promise<Paginated<SuratJalan>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('$$', `$${params.length}`));
    };
    if (query.status) push('sj.status = $$', query.status);
    if (query.date) push('sj.planned_date = $$::date', query.date);
    if (query.locationId) push('(sj.origin_location_id = $$ OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = sj.id AND d.location_id = $$))', query.locationId);
    if (query.driverId) push('sj.driver_id = $$', query.driverId);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM surat_jalan sj ${whereSql}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const idsRes = await client.query<{ id: string }>(
      `SELECT sj.id FROM surat_jalan sj ${whereSql} ORDER BY sj.planned_date DESC, sj.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const rows: SuratJalan[] = [];
    for (const { id } of idsRes.rows) {
      const header = await selectSuratJalanHeader(client, id);
      if (header) rows.push(await buildSuratJalanSummary(client, header));
    }
    return { rows, total, page, pageSize };
  }

  async getById(client: PoolClient, id: UUID): Promise<SuratJalan> {
    const header = await this.requireHeader(client, id);
    return buildSuratJalanFull(client, header);
  }

  /** `GET /api/delivery/my-jobs` — the calling driver's assigned SJs, full detail (F13 pre-departure cache). */
  async myJobs(client: PoolClient, driverUserId: UUID, date?: string): Promise<SuratJalan[]> {
    const driverRes = await client.query<{ id: string }>(`SELECT id FROM drivers WHERE user_id = $1 AND is_active = true`, [driverUserId]);
    const driverId = driverRes.rows[0]?.id;
    if (!driverId) return [];
    const params: unknown[] = [driverId];
    let dateFilter = '';
    if (date) {
      params.push(date);
      dateFilter = `AND sj.planned_date = $2::date`;
    }
    const res = await client.query<{ id: string }>(
      `SELECT sj.id FROM surat_jalan sj WHERE sj.driver_id = $1 ${dateFilter} ORDER BY sj.planned_date ASC`,
      params,
    );
    const out: SuratJalan[] = [];
    for (const { id } of res.rows) {
      const header = await selectSuratJalanHeader(client, id);
      if (header) out.push(await buildSuratJalanFull(client, header));
    }
    return out;
  }

  // ── create / edit ────────────────────────────────────────────────────

  async create(client: PoolClient, dto: CreateSuratJalanDto, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      const originLocationId = await this.requireWarehouseLocationId(client);

      const vehicleRes = await client.query<{ id: string; has_freezer: boolean }>(
        `SELECT id, has_freezer FROM vehicles WHERE id = $1 AND is_active = true`,
        [dto.vehicleId],
      );
      const vehicle = vehicleRes.rows[0];
      if (!vehicle) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Vehicle ${dto.vehicleId} not found or inactive` });
      if (dto.shipmentType === 'frozen' && !vehicle.has_freezer) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Vehicle ${dto.vehicleId} has no freezer — a 'frozen' Surat Jalan requires a cold-chain-capable vehicle (FR-LOG-02)`,
        });
      }

      const driverRes = await client.query<{ id: string }>(`SELECT id FROM drivers WHERE id = $1 AND is_active = true`, [dto.driverId]);
      if (!driverRes.rows[0]) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Driver ${dto.driverId} not found or inactive` });

      const shipmentTypeRes = await client.query<{ id: string }>(`SELECT id FROM shipment_types WHERE key = $1`, [dto.shipmentType]);
      const shipmentTypeId = shipmentTypeRes.rows[0]?.id;
      if (!shipmentTypeId) throw new Error(`shipment_types row for key '${dto.shipmentType}' is missing — seed data problem`);

      await this.assertLinesMatchShipmentType(client, dto.drops, dto.shipmentType);
      for (const drop of dto.drops) {
        const locRes = await client.query<{ id: string }>(`SELECT id FROM locations WHERE id = $1 AND is_active = true`, [drop.locationId]);
        if (!locRes.rows[0]) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Location ${drop.locationId} not found or inactive` });
      }

      const sjNumber = await this.nextDocNumber(client, 'SJ');
      // `id` is generated CLIENT-SIDE (never `RETURNING id`) for both `surat_jalan` and `sj_drops`: their RLS
      // policy's USING clause (migration 201) calls the SECURITY DEFINER `app_sj_locations()` helper, which
      // re-queries `surat_jalan`/`sj_drops` itself — evaluating that as part of THIS SAME INSERT command's
      // `RETURNING` clause hits a genuine Postgres RLS quirk (verified live: the identical INSERT succeeds
      // with no `RETURNING`, and a bare follow-up `SELECT` in a separate command then sees the row fine) and
      // fails with "new row violates row-level security policy" even though every USING/WITH CHECK predicate
      // independently evaluates true. Knowing the id ahead of time sidesteps the whole class of issue.
      // Flagged in the module report for senior-db/the architect — this affects ANY caller of
      // `INSERT ... RETURNING` against these two tables, not just this module.
      const sjId = randomUUID();
      await client.query(
        `INSERT INTO surat_jalan (id, sj_number, origin_location_id, shipment_type_id, driver_id, vehicle_id, planned_date, created_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [sjId, sjNumber, originLocationId, shipmentTypeId, dto.driverId, dto.vehicleId, dto.plannedDate, actorUserId, dto.notes ?? null],
      );

      const dropPayloads: unknown[] = [];
      let dropSeq = 1;
      for (const drop of dto.drops) {
        const dropId = randomUUID();
        await client.query(
          `INSERT INTO sj_drops (id, sj_id, drop_seq, location_id, replenishment_request_id) VALUES ($1, $2, $3, $4, $5)`,
          [dropId, sjId, dropSeq, drop.locationId, drop.replenishmentRequestId ?? null],
        );
        for (const line of drop.lines) {
          await client.query(
            `INSERT INTO sj_lines (sj_id, drop_id, item_id, unit_id, qty, request_line_id) VALUES ($1, $2, $3, $4, $5, $6)`,
            [sjId, dropId, line.itemId, line.unitId, line.qty, line.requestLineId ?? null],
          );
        }
        if (drop.replenishmentRequestId) {
          await this.replenishment.linkSuratJalan(client, drop.replenishmentRequestId, sjId);
        }
        dropPayloads.push({
          id: dropId,
          dropSeq,
          locationId: drop.locationId,
          replenishmentRequestId: drop.replenishmentRequestId ?? null,
          lines: drop.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitId: l.unitId, requestLineId: l.requestLineId })),
        });
        dropSeq += 1;
      }

      await this.syncEmit.emit(client, {
        entity: 'surat_jalan',
        op: 'issued',
        entityId: sjId,
        locationId: originLocationId,
        actorUserId,
        data: {
          id: sjId,
          sjNumber,
          originLocationId,
          shipmentType: dto.shipmentType,
          driverId: dto.driverId,
          vehicleId: dto.vehicleId,
          plannedDate: dto.plannedDate,
          drops: dropPayloads,
        },
      });

      return this.getById(client, sjId);
    });
  }

  async update(client: PoolClient, id: UUID, dto: UpdateSuratJalanDto, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      const header = await this.requireHeaderForUpdate(client, id);
      if (header.status !== 'draft' && header.status !== 'ready') {
        throw new ConflictException({ code: 'ERR_CONFLICT', message: `Surat Jalan can only be edited while draft/ready (current: ${header.status})` });
      }

      if (dto.vehicleId) {
        const vehicleRes = await client.query<{ has_freezer: boolean }>(`SELECT has_freezer FROM vehicles WHERE id = $1 AND is_active = true`, [dto.vehicleId]);
        if (!vehicleRes.rows[0]) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Vehicle ${dto.vehicleId} not found or inactive` });
        if (header.shipment_type === 'frozen' && !vehicleRes.rows[0].has_freezer) {
          throw new BadRequestException({ code: ERR_VALIDATION, message: `Vehicle ${dto.vehicleId} has no freezer — required for a 'frozen' Surat Jalan` });
        }
      }
      if (dto.driverId) {
        const driverRes = await client.query(`SELECT id FROM drivers WHERE id = $1 AND is_active = true`, [dto.driverId]);
        if (!driverRes.rows[0]) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Driver ${dto.driverId} not found or inactive` });
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.driverId !== undefined) set('driver_id', dto.driverId);
      if (dto.vehicleId !== undefined) set('vehicle_id', dto.vehicleId);
      if (dto.plannedDate !== undefined) set('planned_date', dto.plannedDate);
      if (dto.notes !== undefined) set('notes', dto.notes);
      if (sets.length > 0) {
        params.push(id);
        await client.query(`UPDATE surat_jalan SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }

      if (dto.drops) {
        await this.assertLinesMatchShipmentType(client, dto.drops, header.shipment_type);
        // Replace the route wholesale — draft/ready only, so nothing downstream (stock, replenishment
        // status) has happened against the old drops/lines yet.
        await client.query(`DELETE FROM sj_drops WHERE sj_id = $1`, [id]); // ON DELETE CASCADE clears sj_lines
        let dropSeq = 1;
        for (const drop of dto.drops) {
          // Client-generated id, no `RETURNING` — see `create()`'s comment on the same pattern (RLS/`app_sj_locations()` quirk).
          const dropId = randomUUID();
          await client.query(
            `INSERT INTO sj_drops (id, sj_id, drop_seq, location_id, replenishment_request_id) VALUES ($1, $2, $3, $4, $5)`,
            [dropId, id, dropSeq, drop.locationId, drop.replenishmentRequestId ?? null],
          );
          for (const line of drop.lines) {
            await client.query(
              `INSERT INTO sj_lines (sj_id, drop_id, item_id, unit_id, qty, request_line_id) VALUES ($1, $2, $3, $4, $5, $6)`,
              [id, dropId, line.itemId, line.unitId, line.qty, line.requestLineId ?? null],
            );
          }
          if (drop.replenishmentRequestId) {
            await this.replenishment.linkSuratJalan(client, drop.replenishmentRequestId, id);
          }
          dropSeq += 1;
        }
      }

      await this.emitUpdated(client, id, actorUserId);
      return this.getById(client, id);
    });
  }

  // ── status walk ──────────────────────────────────────────────────────

  async ready(client: PoolClient, id: UUID, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      const header = await this.assertTransition(client, id, 'ready');
      await client.query(`UPDATE surat_jalan SET status = 'ready' WHERE id = $1`, [id]);

      const requestIds = await this.linkedRequestIds(client, id);
      for (const requestId of requestIds) {
        // `delivery.sj.create` (this endpoint's permission) is KEPALA_GUDANG-only per the RBAC matrix —
        // the same role `transition()`'s 'process' rule allows (CONTRACTS.md §5.1 row 7).
        await this.replenishment.markProcessing(client, requestId, actorUserId, RoleKey.KEPALA_GUDANG);
      }

      await this.emitUpdated(client, id, actorUserId, header);
      return this.getById(client, id);
    });
  }

  async load(client: PoolClient, id: UUID, dto: LoadSuratJalanDto, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      const header = await this.assertTransition(client, id, 'load');
      const shipmentType = await this.coldChain.loadShipmentType(
        client,
        (await client.query<{ shipment_type_id: string }>(`SELECT shipment_type_id FROM surat_jalan WHERE id = $1`, [id])).rows[0]!.shipment_type_id,
      );

      if (shipmentType.requires_temperature_log && !dto.tempC) {
        throw new BadRequestException({ code: ERR_VALIDATION, message: `tempC is required at load for a '${shipmentType.key}' shipment (D-14)` });
      }

      await client.query(`UPDATE surat_jalan SET status = 'loading' WHERE id = $1`, [id]);

      for (const seal of dto.seals) {
        await client.query(`INSERT INTO sj_seals (sj_id, drop_id, seal_number, status, checked_by, checked_at) VALUES ($1, NULL, $2, 'applied', $3, NOW())`, [
          id,
          seal.sealNumber,
          actorUserId,
        ]);
      }
      await this.syncEmit.emit(client, {
        entity: 'sj_seals',
        op: 'applied',
        entityId: id,
        locationId: header.origin_location_id,
        actorUserId,
        data: dto.seals.map((s) => ({ id, sjId: id, dropId: null, sealNumber: s.sealNumber })),
      });

      if (dto.tempC) {
        const recipients = await this.coldChain.resolveBreachRecipients(client, header.origin_location_id);
        await this.coldChain.logTemperature(client, {
          sjId: id,
          dropId: null,
          stage: 'load',
          tempC: dto.tempC,
          loggedBy: actorUserId,
          shipmentType,
          locationName: 'Gudang Pusat',
          locationId: header.origin_location_id,
          notifyUserIds: recipients,
        });
      }

      await this.emitUpdated(client, id, actorUserId, header);
      return this.getById(client, id);
    });
  }

  async dispatch(client: PoolClient, id: UUID, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      const header = await this.assertTransition(client, id, 'dispatch');

      const lineRows = await client.query<{
        id: string;
        drop_id: string;
        item_id: string;
        qty: string;
        avg_cost: string;
        storage_type: 'frozen' | 'chilled' | 'dry';
        drop_location_id: string;
        request_line_id: string | null;
      }>(
        `SELECT sl.id, sl.drop_id, sl.item_id, sl.qty, i.avg_cost, i.storage_type, d.location_id AS drop_location_id, sl.request_line_id
           FROM sj_lines sl
           JOIN items i ON i.id = sl.item_id
           JOIN sj_drops d ON d.id = sl.drop_id
          WHERE sl.sj_id = $1`,
        [id],
      );
      if (lineRows.rows.length === 0) {
        throw new BadRequestException({ code: ERR_VALIDATION, message: 'Cannot dispatch a Surat Jalan with no lines' });
      }

      const areaCache = new Map<string, string>();
      const resolveArea = async (storageType: 'frozen' | 'chilled' | 'dry'): Promise<string> => {
        const required = requiredAreaTypeFor(storageType);
        const cached = areaCache.get(required);
        if (cached) return cached;
        const areaRes = await client.query<{ id: string }>(
          `SELECT id FROM storage_areas WHERE location_id = $1 AND type = $2 AND is_active = true ORDER BY sort_order ASC LIMIT 1`,
          [header.origin_location_id, required],
        );
        const areaId = areaRes.rows[0]?.id;
        if (!areaId) throw new BadRequestException({ code: ERR_VALIDATION, message: `Warehouse has no active '${required}' storage area configured (D-15)` });
        areaCache.set(required, areaId);
        return areaId;
      };

      const movements: PostMovementInput[] = [];
      for (const l of lineRows.rows) {
        movements.push({
          locationId: header.origin_location_id,
          storageAreaId: await resolveArea(l.storage_type),
          itemId: l.item_id,
          movementType: MovementType.TRANSFER_OUT,
          qty: l.qty,
          unitCost: l.avg_cost,
          refType: 'sj_drop',
          refId: l.drop_id,
          counterpartyLocationId: l.drop_location_id,
          counterpartyStorageAreaId: null,
          actorId: actorUserId,
        });
      }
      await this.stockLedger.post(client, movements, 'strict');

      await client.query(`UPDATE surat_jalan SET status = 'in_transit', dispatched_at = NOW() WHERE id = $1`, [id]);

      const total: Money = sumMoney(movements.map((m) => mulMoneyByQty(m.unitCost, m.qty)));
      await this.eventBus.publish('journal.action', {
        eventType: JournalEventType.GUDANG_GOODS_OUT_TO_OUTLET,
        documentType: 'surat_jalan',
        documentId: id,
        locationId: header.origin_location_id,
        amount: total,
        context: { sjNumber: header.sj_number, lineCount: movements.length },
        occurredAt: new Date().toISOString(),
      });

      const shipmentsByRequest = new Map<string, { requestLineId: UUID; qtyShipped: Qty }[]>();
      const requestIds = await this.linkedRequestIds(client, id);
      for (const l of lineRows.rows) {
        if (!l.request_line_id) continue;
        const dropRequest = await client.query<{ replenishment_request_id: string | null }>(`SELECT replenishment_request_id FROM sj_drops WHERE id = $1`, [l.drop_id]);
        const requestId = dropRequest.rows[0]?.replenishment_request_id;
        if (!requestId) continue;
        const list = shipmentsByRequest.get(requestId) ?? [];
        list.push({ requestLineId: l.request_line_id, qtyShipped: l.qty });
        shipmentsByRequest.set(requestId, list);
      }
      for (const requestId of requestIds) {
        await this.replenishment.markShipped(client, requestId, shipmentsByRequest.get(requestId) ?? [], actorUserId, RoleKey.KEPALA_GUDANG);
      }

      await this.emitUpdated(client, id, actorUserId, header);
      return this.getById(client, id);
    });
  }

  async cancel(client: PoolClient, id: UUID, reason: string, actorUserId: UUID): Promise<SuratJalan> {
    return withWrite(client, async () => {
      await this.assertTransition(client, id, 'cancel');
      await client.query(`UPDATE surat_jalan SET status = 'cancelled' WHERE id = $1`, [id]);
      await this.syncEmit.emit(client, {
        entity: 'surat_jalan',
        op: 'cancelled',
        entityId: id,
        locationId: (await this.requireHeader(client, id)).origin_location_id,
        actorUserId,
        data: { id, reason },
      });
      return this.getById(client, id);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async requireWarehouseLocationId(client: PoolClient): Promise<UUID> {
    const res = await client.query<{ id: string }>(`SELECT id FROM locations WHERE type = 'warehouse' AND is_active = true ORDER BY created_at ASC LIMIT 1`);
    const id = res.rows[0]?.id;
    if (!id) throw new Error('No active warehouse location seeded — cannot issue a Surat Jalan (D-14: single central gudang pusat)');
    return id;
  }

  private async requireHeader(client: PoolClient, id: UUID): Promise<SuratJalanHeaderRow> {
    const header = await selectSuratJalanHeader(client, id);
    if (!header) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Surat Jalan ${id} not found` });
    return header;
  }

  private async requireHeaderForUpdate(client: PoolClient, id: UUID): Promise<SuratJalanHeaderRow> {
    const header = await selectSuratJalanHeaderForUpdate(client, id);
    if (!header) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Surat Jalan ${id} not found` });
    return header;
  }

  private async assertTransition(client: PoolClient, id: UUID, action: keyof typeof SJ_TRANSITIONS): Promise<SuratJalanHeaderRow> {
    const header = await this.requireHeaderForUpdate(client, id);
    const allowed = SJ_TRANSITIONS[action]!;
    if (!allowed.includes(header.status)) {
      throw new ConflictException({
        code: 'ERR_CONFLICT',
        message: `Surat Jalan ${id} cannot '${action}' from status '${header.status}' (allowed: ${allowed.join(', ')})`,
      });
    }
    return header;
  }

  private async linkedRequestIds(client: PoolClient, sjId: UUID): Promise<UUID[]> {
    const res = await client.query<{ replenishment_request_id: string }>(
      `SELECT DISTINCT replenishment_request_id FROM sj_drops WHERE sj_id = $1 AND replenishment_request_id IS NOT NULL`,
      [sjId],
    );
    return res.rows.map((r) => r.replenishment_request_id);
  }

  private async emitUpdated(client: PoolClient, id: UUID, actorUserId: UUID, headerHint?: SuratJalanHeaderRow): Promise<void> {
    const header = headerHint ?? (await this.requireHeader(client, id));
    const full = await this.getById(client, id);
    // `DropLine` (the shared response DTO) carries `unitCode` for display, not the raw `unit_id` the wire
    // schema (`sj_drops` embedded lines) actually needs — fetch the raw rows once for that one field.
    const rawLines = await selectLinesForSj(client, id);
    const rawLinesByDrop = new Map<string, typeof rawLines>();
    for (const l of rawLines) {
      const list = rawLinesByDrop.get(l.drop_id) ?? [];
      list.push(l);
      rawLinesByDrop.set(l.drop_id, list);
    }
    await this.syncEmit.emit(client, {
      entity: 'surat_jalan',
      op: 'updated',
      entityId: id,
      locationId: header.origin_location_id,
      actorUserId,
      data: {
        id: full.id,
        sjNumber: full.sjNumber,
        originLocationId: full.originLocationId,
        shipmentType: full.shipmentType,
        driverId: full.driver.id,
        vehicleId: full.vehicle.id,
        status: full.status,
        plannedDate: full.plannedDate,
        dispatchedAt: full.dispatchedAt,
        completedAt: full.completedAt,
        drops: full.drops.map((d) => ({
          id: d.id,
          dropSeq: d.dropSeq,
          locationId: d.locationId,
          replenishmentRequestId: d.replenishmentRequestId,
          lines: (rawLinesByDrop.get(d.id) ?? []).map((l) => ({ itemId: l.item_id, qty: l.qty, unitId: l.unit_id, requestLineId: l.request_line_id ?? undefined })),
        })),
      },
    });
  }

  private async assertLinesMatchShipmentType(
    client: PoolClient,
    drops: readonly { lines: readonly { itemId: UUID; qty: Qty }[] }[],
    shipmentType: 'frozen' | 'dry',
  ): Promise<void> {
    for (const drop of drops) {
      if (drop.lines.length === 0) throw new BadRequestException({ code: ERR_VALIDATION, message: 'Every drop needs at least one line' });
      for (const line of drop.lines) {
        if (isZeroQty(line.qty) || isNegativeQty(line.qty)) {
          throw new BadRequestException({ code: ERR_VALIDATION, message: `qty must be > 0 (item ${line.itemId})` });
        }
        const itemRes = await client.query<{ storage_type: string; name: string }>(`SELECT storage_type, name FROM items WHERE id = $1`, [line.itemId]);
        const item = itemRes.rows[0];
        if (!item) throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Item ${line.itemId} not found` });
        if (item.storage_type !== shipmentType) {
          throw new BadRequestException({
            code: ERR_SHIPMENT_TYPE_MIX,
            message: `${item.name} is '${item.storage_type}' and cannot travel on a '${shipmentType}' Surat Jalan — frozen and dry never share one SJ (FR-LOG-02)`,
          });
        }
      }
    }
  }

  private async nextDocNumber(client: PoolClient, docType: string): Promise<string> {
    const period = businessDateOf(new Date().toISOString()).slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [docType, period],
    );
    return formatCloudDocNumber(docType, period, res.rows[0]!.last_number);
  }
}
