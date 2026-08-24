import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_PHOTO_REQUIRED,
  ERR_SIGNATURE_REQUIRED,
  ERR_VALIDATION,
  ERR_VARIANCE_REASON_REQUIRED,
  JournalEventType,
  MovementType,
  compareQty,
  isNegativeQty,
  isZeroQty,
  mulMoneyByQty,
  sumMoney,
  type Drop,
  type Money,
  type Qty,
  type RoleKey,
  type Temp,
  type UUID,
} from '@mimi/shared';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import type { PostMovementInput } from '../../../kernel/stock-ledger/stock-ledger.types';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { withWrite } from '../db-tx';
import { assertAreaMatchesStorageType, requiredAreaTypeFor } from '../storage-type.util';
import {
  buildSuratJalanFull,
  mapDropBase,
  selectDropById,
  selectDropByIdForUpdate,
  selectDropPhotoAttachmentIds,
  selectLinesForDrop,
  selectLinesForDropForUpdate,
  selectLinesForSj,
  selectSuratJalanHeader,
  type DropWithSjRow,
} from '../queries';
import {
  ArriveDropDto,
  DepartDropDto,
  FailDropDto,
  ReceiveDropDto,
  SkipDropDto,
} from '../dto/drop.dto';
import { ColdChainService } from './cold-chain.service';
import {
  REPLENISHMENT_FULFILLMENT_PORT,
  type ReplenishmentFulfillmentPort,
} from '../ports/replenishment-fulfillment.port';

const TERMINAL_DROP_STATUSES = new Set(['completed', 'completed_discrepancy', 'failed']);

// ── Apply-core input/output shapes — shared verbatim between the REST path
// (`depart`/`arrive`/`receive`, interactive/'strict') and `DeliverySyncProjector`
// (offline/'fact'). Neither wrapper reimplements the underlying writes — this
// is the "refactor rather than duplicate" fix (coordinator's follow-up,
// cross-referencing W3-09's own projector): an offline-synced drop fact and
// an online one MUST produce byte-identical rows. ─────────────────────────

export type ApplyDropResult =
  | { applied: true }
  | { applied: false; reason: 'not_found' | 'wrong_status'; currentStatus?: string };

export interface ApplyDepartParams {
  dropId: UUID;
  /** Business-claimed departure time (device wall clock, or "now" for an online caller) — stable across replay by construction (never re-derived), unlike the temp-log timestamp below. */
  at: string;
  tempC?: Temp;
  actorUserId: UUID;
}

export interface ApplyArriveParams {
  dropId: UUID;
  at: string;
  tempC: Temp;
  sealCheck?: { sealId: UUID; status: 'verified_intact' | 'broken'; notes?: string };
  actorUserId: UUID;
}

export interface ApplyReceiveLineInput {
  lineId: UUID;
  qtyReceived: Qty;
  receivedStorageAreaId: UUID;
  discrepancyReason?: string;
}

export interface ApplyReceiveParams {
  dropId: UUID;
  lines: ApplyReceiveLineInput[];
  signatureAttachmentId: UUID;
  tempC?: Temp;
  discrepancyNotes?: string;
  actorUserId: UUID;
  actorRole: RoleKey;
  /** `received_at` — business-claimed time, stable across replay (see `ApplyDepartParams.at`). */
  occurredAt: string;
  mode: 'strict' | 'fact';
  /**
   * Dedup BELOW the sync registry (coordinator's follow-up): independent of
   * `event.eventId`'s own uniqueness guarantee, checked against
   * `sj_drops.client_id` (migration 034 — "driver/outlet offline
   * idempotency"). A client retry that (due to a bug) mints a fresh
   * `eventId` for a resend would otherwise double-post stock; this closes
   * that gap for the one `sj_drops` fact consequential enough to need it.
   */
  clientId?: UUID;
}

export type ApplyReceiveResult =
  | { applied: true; anyDiscrepancy: boolean; locationId: UUID }
  | {
      applied: false;
      reason: 'not_found' | 'wrong_status' | 'duplicate_client_id';
      currentStatus?: string;
    };

@Injectable()
export class DropService {
  constructor(
    private readonly syncEmit: SyncEmitService,
    private readonly stockLedger: StockLedgerService,
    private readonly eventBus: EventBus,
    private readonly coldChain: ColdChainService,
    @Inject(REPLENISHMENT_FULFILLMENT_PORT)
    private readonly replenishment: ReplenishmentFulfillmentPort,
  ) {}

  async getById(client: PoolClient, dropId: UUID): Promise<Drop> {
    const row = await this.requireDrop(client, dropId);
    const lines = await selectLinesForDrop(client, dropId);
    return this.toDto(client, row, lines);
  }

  private async toDto(
    client: PoolClient,
    row: DropWithSjRow,
    lines: Awaited<ReturnType<typeof selectLinesForDrop>>,
  ): Promise<Drop> {
    const dto = mapDropBase(row, lines);
    if (row.signature_attachment_id) {
      dto.signatureUrl = row.signature_attachment_id; // raw attachment id — FE resolves via GET /api/attachments/:id/url (CONTRACTS §4.0)
    }
    dto.photoUrls = await selectDropPhotoAttachmentIds(client, row.id);
    return dto;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Apply cores — no exceptions, no sync-emit, no DTO mapping. Callable from
  // BOTH the REST wrappers below and `DeliverySyncProjector`.
  // ══════════════════════════════════════════════════════════════════════

  /** `pending -> en_route`. Idempotent: a replay finds the row already past `pending` and returns `{applied:false}` rather than re-applying. */
  async applyDepart(
    client: PoolClient,
    params: ApplyDepartParams,
    opts: { loggedAt?: string } = {},
  ): Promise<ApplyDropResult> {
    const row = await selectDropByIdForUpdate(client, params.dropId);
    if (!row) return { applied: false, reason: 'not_found' };
    if (row.status !== 'pending')
      return { applied: false, reason: 'wrong_status', currentStatus: row.status };

    await client.query(`UPDATE sj_drops SET status = 'en_route', departed_at = $2 WHERE id = $1`, [
      params.dropId,
      params.at,
    ]);

    if (params.tempC) {
      await this.logTempForDrop(
        client,
        row,
        'depart',
        params.tempC,
        params.actorUserId,
        opts.loggedAt,
      );
    }
    return { applied: true };
  }

  /** `en_route -> arrived`. Idempotent, same shape as `applyDepart`. */
  async applyArrive(
    client: PoolClient,
    params: ApplyArriveParams,
    opts: { loggedAt?: string } = {},
  ): Promise<ApplyDropResult> {
    const row = await selectDropByIdForUpdate(client, params.dropId);
    if (!row) return { applied: false, reason: 'not_found' };
    if (row.status !== 'en_route')
      return { applied: false, reason: 'wrong_status', currentStatus: row.status };

    await client.query(`UPDATE sj_drops SET status = 'arrived', arrived_at = $2 WHERE id = $1`, [
      params.dropId,
      params.at,
    ]);

    if (params.sealCheck) {
      await client.query(
        `UPDATE sj_seals SET status = $2, checked_by = $3, checked_at = NOW(), drop_id = COALESCE(drop_id, $4) WHERE id = $1`,
        [params.sealCheck.sealId, params.sealCheck.status, params.actorUserId, params.dropId],
      );
    }

    await this.logTempForDrop(
      client,
      row,
      'arrive',
      params.tempC,
      params.actorUserId,
      opts.loggedAt,
    );
    return { applied: true };
  }

  /**
   * `arrived -> completed|completed_discrepancy`. FR-LOG-14/15/16, JOUT-01 —
   * auto-adjusts outlet stock via `StockLedgerService` only (D-07), landing
   * in the caller-chosen area validated against D-15's putaway rule.
   * `params.mode` is the caller's choice ('strict' for the REST/interactive
   * path, 'fact' for a replayed offline sync fact, D-17a) — never decided in
   * here, so this method behaves identically regardless of origin.
   */
  async applyReceive(
    client: PoolClient,
    params: ApplyReceiveParams,
    opts: { loggedAt?: string } = {},
  ): Promise<ApplyReceiveResult> {
    if (params.clientId) {
      const dup = await client.query<{ id: string }>(
        `SELECT id FROM sj_drops WHERE id = $1 AND client_id = $2`,
        [params.dropId, params.clientId],
      );
      if (dup.rows[0]) return { applied: false, reason: 'duplicate_client_id' };
    }

    const row = await selectDropByIdForUpdate(client, params.dropId);
    if (!row) return { applied: false, reason: 'not_found' };
    if (row.status !== 'arrived')
      return { applied: false, reason: 'wrong_status', currentStatus: row.status };

    const lines = await selectLinesForDropForUpdate(client, params.dropId);
    if (lines.length === 0)
      throw new Error(`sj_drops/${params.dropId} has no sj_lines — data integrity problem`);
    const linesByLineId = new Map(lines.map((l) => [l.id, l]));

    const movements: PostMovementInput[] = [];
    let anyDiscrepancy = false;
    const shortfallMovements: { qtyDelta: string; unitCost: Money }[] = [];

    for (const lineInput of params.lines) {
      const line = linesByLineId.get(lineInput.lineId);
      if (!line) {
        if (params.mode === 'strict') {
          throw new BadRequestException({
            code: ERR_VALIDATION,
            message: `Line ${lineInput.lineId} does not belong to drop ${params.dropId}`,
          });
        }
        continue; // fact mode: a stray line id from the device — skip that line, not the whole fact
      }
      if (isNegativeQty(lineInput.qtyReceived)) {
        if (params.mode === 'strict') {
          throw new BadRequestException({
            code: ERR_VALIDATION,
            message: `qtyReceived must be >= 0 (line ${lineInput.lineId})`,
          });
        }
        continue;
      }

      const discrepancy = compareQty(lineInput.qtyReceived, line.qty) !== 0;
      if (discrepancy) {
        anyDiscrepancy = true;
        if (params.mode === 'strict' && !lineInput.discrepancyReason?.trim()) {
          throw new BadRequestException({
            code: ERR_VARIANCE_REASON_REQUIRED,
            message: `discrepancyReason is required — dikirim ${line.qty} vs diterima ${lineInput.qtyReceived} (item ${line.item_name})`,
          });
        }
      }

      const areaRes = await client.query<{ type: string; name: string }>(
        `SELECT type, name FROM storage_areas WHERE id = $1 AND is_active = true`,
        [lineInput.receivedStorageAreaId],
      );
      const area = areaRes.rows[0];
      if (!area) {
        if (params.mode === 'strict') {
          throw new NotFoundException({
            code: 'ERR_NOT_FOUND',
            message: `Storage area ${lineInput.receivedStorageAreaId} not found or inactive`,
          });
        }
        // fact mode: a missing area on a replayed fact still gets recorded on the line below (the goods
        // landed SOMEWHERE per the device's own record); only the STOCK posting for that line is skipped,
        // since `StockLedgerService.post` needs a real area to move into.
      } else {
        assertAreaMatchesStorageType(line.storage_type, area.type, line.item_name, area.name);
      }

      await client.query(
        `UPDATE sj_lines SET qty_received = $2, received_storage_area_id = $3, discrepancy_reason = $4 WHERE id = $1`,
        [
          lineInput.lineId,
          lineInput.qtyReceived,
          lineInput.receivedStorageAreaId,
          lineInput.discrepancyReason ?? null,
        ],
      );

      if (area && !isZeroQty(lineInput.qtyReceived)) {
        const costRes = await client.query<{ avg_cost: string }>(
          `SELECT avg_cost FROM items WHERE id = $1`,
          [line.item_id],
        );
        const unitCost = costRes.rows[0]!.avg_cost;
        movements.push({
          locationId: row.location_id,
          storageAreaId: lineInput.receivedStorageAreaId,
          itemId: line.item_id,
          movementType: MovementType.TRANSFER_IN,
          qty: lineInput.qtyReceived,
          unitCost,
          refType: 'sj_drop',
          refId: params.dropId,
          actorId: params.actorUserId,
          occurredAt: params.occurredAt,
        });
        if (discrepancy && compareQty(lineInput.qtyReceived, line.qty) < 0) {
          shortfallMovements.push({
            qtyDelta: (Number(line.qty) - Number(lineInput.qtyReceived)).toFixed(3),
            unitCost,
          });
        }
      }
    }

    if (movements.length > 0) {
      // D-17a: 'strict' (interactive — reject a movement that would go negative) vs 'fact' (a replayed
      // offline receipt applies regardless and opens a stock_reconciliations exception, C5) — the caller's
      // choice, never decided here.
      await this.stockLedger.post(client, movements, params.mode);
    }

    const nextStatus = anyDiscrepancy ? 'completed_discrepancy' : 'completed';
    await client.query(
      `UPDATE sj_drops
          SET status = $2, received_by = $3, received_at = $4, signature_attachment_id = $5, discrepancy_notes = $6,
              client_id = COALESCE(client_id, $7)
        WHERE id = $1`,
      [
        params.dropId,
        nextStatus,
        params.actorUserId,
        params.occurredAt,
        params.signatureAttachmentId,
        params.discrepancyNotes ?? null,
        params.clientId ?? null,
      ],
    );

    if (params.tempC) {
      await this.logTempForDrop(
        client,
        row,
        'arrive',
        params.tempC,
        params.actorUserId,
        opts.loggedAt,
      );
    }

    const total: Money =
      movements.length > 0
        ? sumMoney(movements.map((m) => mulMoneyByQty(m.unitCost, m.qty)))
        : '0.00';
    await this.eventBus.publish('journal.action', {
      eventType: JournalEventType.OUTLET_GOODS_IN_FROM_WAREHOUSE,
      documentType: 'sj_drops',
      documentId: params.dropId,
      locationId: row.location_id,
      amount: total,
      context: {
        lineCount: movements.length,
        discrepancy: anyDiscrepancy,
        shortfall:
          shortfallMovements.length > 0
            ? sumMoney(shortfallMovements.map((s) => mulMoneyByQty(s.unitCost, s.qtyDelta)))
            : '0.00',
      },
      occurredAt: params.occurredAt,
    });

    if (row.replenishment_request_id) {
      const lineReceipts = params.lines
        .map((l) => ({ input: l, line: linesByLineId.get(l.lineId) }))
        .filter((x): x is { input: ApplyReceiveLineInput; line: NonNullable<(typeof x)['line']> } =>
          Boolean(x.line?.request_line_id),
        )
        .map((x) => ({ requestLineId: x.line.request_line_id!, qtyReceived: x.input.qtyReceived }));
      await this.replenishment.markReceived(
        client,
        row.replenishment_request_id,
        lineReceipts,
        params.actorUserId,
        params.actorRole,
        anyDiscrepancy,
        params.discrepancyNotes ?? (anyDiscrepancy ? 'discrepancy at receiving' : null),
      );
    }

    await this.checkAndCompleteSuratJalan(client, row.sj_id, params.actorUserId);
    return { applied: true, anyDiscrepancy, locationId: row.location_id };
  }

  // ══════════════════════════════════════════════════════════════════════
  // REST wrappers — interactive validation + exceptions + sync-emit, then
  // delegate to the cores above. `DeliverySyncProjector` calls the cores
  // directly and never these.
  // ══════════════════════════════════════════════════════════════════════

  async depart(
    client: PoolClient,
    dropId: UUID,
    dto: DepartDropDto,
    actorUserId: UUID,
  ): Promise<Drop> {
    return withWrite(client, async () => {
      const current = await this.requireDrop(client, dropId);
      const sjHeader = (await selectSuratJalanHeader(client, current.sj_id))!;
      const at = dto.at ?? new Date().toISOString();

      if (sjHeader.shipment_type === 'frozen' && !dto.tempC) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `tempC is required departing a 'frozen' drop (D-14)`,
        });
      }

      const result = await this.applyDepart(client, { dropId, at, tempC: dto.tempC, actorUserId });
      if (!result.applied) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} must be 'pending' to depart (current: ${result.reason === 'wrong_status' ? result.currentStatus : 'not found'})`,
        });
      }

      await this.syncEmit.emit(client, {
        entity: 'sj_drops',
        op: 'departed',
        entityId: dropId,
        locationId: current.location_id,
        actorUserId,
        data: { dropId, at, tempC: dto.tempC },
      });

      return this.getById(client, dropId);
    });
  }

  async arrive(
    client: PoolClient,
    dropId: UUID,
    dto: ArriveDropDto,
    actorUserId: UUID,
  ): Promise<Drop> {
    return withWrite(client, async () => {
      const current = await this.requireDrop(client, dropId);
      const sjHeader = (await selectSuratJalanHeader(client, current.sj_id))!;
      const at = dto.at ?? new Date().toISOString();

      if (sjHeader.shipment_type === 'frozen' && !dto.tempC) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `tempC is required arriving at a 'frozen' drop (D-14)`,
        });
      }
      if (!dto.tempC) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `tempC is required arriving at a drop (D-14)`,
        });
      }

      const result = await this.applyArrive(client, {
        dropId,
        at,
        tempC: dto.tempC,
        sealCheck: dto.sealCheck,
        actorUserId,
      });
      if (!result.applied) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} must be 'en_route' to arrive (current: ${result.reason === 'wrong_status' ? result.currentStatus : 'not found'})`,
        });
      }

      await this.syncEmit.emit(client, {
        entity: 'sj_drops',
        op: 'arrived',
        entityId: dropId,
        locationId: current.location_id,
        actorUserId,
        data: { dropId, at, tempC: dto.tempC, sealCheck: dto.sealCheck },
      });

      return this.getById(client, dropId);
    });
  }

  async receive(
    client: PoolClient,
    dropId: UUID,
    dto: ReceiveDropDto,
    actorUserId: UUID,
    actorRole: RoleKey,
  ): Promise<Drop> {
    return withWrite(client, async () => {
      if (dto.photoAttachmentIds.length === 0) {
        throw new BadRequestException({
          code: ERR_PHOTO_REQUIRED,
          message: 'At least one receiving photo is wajib (FR-LOG-15)',
        });
      }
      if (!dto.signatureAttachmentId) {
        throw new BadRequestException({
          code: ERR_SIGNATURE_REQUIRED,
          message: 'A receiving signature is required (D-14)',
        });
      }
      // Attachment existence/kind checks are REST-ONLY: an offline fact's binary may still be mid-upload
      // via the side-channel (SYNC-PROTOCOL §4.7 — "the event pushes immediately... never waits for the
      // binary"), so the projector must not require the `attachments` row to exist yet.
      await this.assertAttachments(client, dto.photoAttachmentIds, dropId, 'receiving_photo');
      await this.assertAttachments(client, [dto.signatureAttachmentId], dropId, 'signature');

      const result = await this.applyReceive(client, {
        dropId,
        lines: dto.lines,
        signatureAttachmentId: dto.signatureAttachmentId,
        tempC: dto.tempC,
        discrepancyNotes: dto.discrepancyNotes,
        actorUserId,
        actorRole,
        occurredAt: new Date().toISOString(),
        mode: 'strict',
      });
      if (!result.applied) {
        if (result.reason === 'not_found')
          throw new NotFoundException({
            code: 'ERR_NOT_FOUND',
            message: `Drop ${dropId} not found`,
          });
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} must be 'arrived' to receive (current: ${result.currentStatus})`,
        });
      }

      await this.syncEmit.emit(client, {
        entity: 'sj_drops',
        op: 'received',
        entityId: dropId,
        locationId: result.locationId,
        actorUserId,
        data: {
          dropId,
          lines: dto.lines.map((l) => ({
            lineId: l.lineId,
            qtyReceived: l.qtyReceived,
            receivedStorageAreaId: l.receivedStorageAreaId,
            discrepancyReason: l.discrepancyReason,
          })),
          photoAttachmentIds: dto.photoAttachmentIds,
          signatureAttachmentId: dto.signatureAttachmentId,
          tempC: dto.tempC,
          discrepancyNotes: dto.discrepancyNotes,
        },
      });

      return this.getById(client, dropId);
    });
  }

  /**
   * `sj_drops`'s wire ops (`@mimi/sync-protocol`'s authority matrix) are
   * exactly `departed`/`arrived`/`received` — SYNC-PROTOCOL never named a
   * `failed` op for the drop entity itself, even though CONTRACTS.md §4.10
   * defines this endpoint as first-class. Rather than emit an unregistered
   * op (which `SyncEmitService`/`canOriginate` would correctly refuse), a
   * fail is communicated as a `surat_jalan.updated` event — the SJ aggregate
   * already embeds every drop's `status`, and `updated` is registered
   * exactly for "something about this SJ's drops changed" (`emitSjUpdated`
   * below, shared with `checkAndCompleteSuratJalan`). Flagged in the module
   * report as a registry gap for the architect.
   */
  async fail(client: PoolClient, dropId: UUID, dto: FailDropDto, actorUserId: UUID): Promise<Drop> {
    return withWrite(client, async () => {
      const row = await this.requireDropForUpdate(client, dropId);
      if (TERMINAL_DROP_STATUSES.has(row.status)) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} is already terminal (${row.status})`,
        });
      }
      if (dto.photoAttachmentId) {
        await this.assertAttachments(client, [dto.photoAttachmentId], dropId, 'delivery_failure');
      }
      await client.query(
        `UPDATE sj_drops
            SET status = 'failed', failure_reason = $2, failure_attachment_id = $3
          WHERE id = $1`,
        [dropId, dto.reason, dto.photoAttachmentId ?? null],
      );

      await this.emitSjUpdated(client, row.sj_id, actorUserId);
      await this.checkAndCompleteSuratJalan(client, row.sj_id, actorUserId);
      return this.getById(client, dropId);
    });
  }

  /**
   * Defer a drop to the end of today's route.
   *
   * A skip is NOT an outcome and deliberately writes no terminal status — see
   * migration 241. `fail` already means "not happening", and failing a drop
   * reverses its dispatch `transfer_out` so the stock returns to the warehouse.
   * A driver going past a busy outlet to come back in an hour still has those
   * goods on the van, so borrowing `failed` for a skip would return stock that
   * never moved and leave the next opname with a discrepancy nobody can explain.
   *
   * What actually changes is the ROUTE ORDER: the drop goes to the back of the
   * queue and returns to `pending`, because it is once again a place the driver
   * has not set out for. `departed_at` is cleared for the same reason — leaving
   * it set would claim the van is en route to somewhere it has driven past.
   *
   * Terminal drops cannot be skipped: there is nothing left to defer, and
   * silently accepting it would let a completed delivery be reordered out of
   * the history.
   */
  async skip(client: PoolClient, dropId: UUID, dto: SkipDropDto, actorUserId: UUID): Promise<Drop> {
    return withWrite(client, async () => {
      const row = await this.requireDropForUpdate(client, dropId);
      if (TERMINAL_DROP_STATUSES.has(row.status)) {
        throw new ConflictException({
          code: 'ERR_CONFLICT',
          message: `Drop ${dropId} is already terminal (${row.status}) and cannot be skipped`,
        });
      }

      // Last place in the route. Computed inside the same transaction as the
      // UPDATE — two drivers skipping on one SJ is unlikely, but reading the
      // max in a separate statement is how two drops end up sharing a
      // drop_seq, which `sj_drops_sj_id_drop_seq_key` would then reject.
      const seqRes = await client.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(drop_seq), 0) + 1 AS next_seq FROM sj_drops WHERE sj_id = $1`,
        [row.sj_id],
      );
      // `COALESCE(MAX(...))` over a table always yields exactly one row, so the
      // fallback is unreachable — but it is 1 rather than 0 so that if the
      // impossible ever happens the drop lands at a valid sequence instead of
      // colliding with whatever sits at zero.
      const nextSeq = seqRes.rows[0]?.next_seq ?? 1;

      await client.query(
        `UPDATE sj_drops
            SET drop_seq = $2,
                status = 'pending',
                departed_at = NULL,
                skip_count = skip_count + 1,
                last_skip_reason = $3,
                last_skipped_at = now()
          WHERE id = $1`,
        [dropId, nextSeq, dto.reason],
      );

      await this.emitSjUpdated(client, row.sj_id, actorUserId);
      // No `checkAndCompleteSuratJalan` here, and that is the point: a skipped
      // drop is still outstanding, so the Surat Jalan must stay open.
      return this.getById(client, dropId);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async requireDrop(client: PoolClient, dropId: UUID): Promise<DropWithSjRow> {
    const row = await selectDropById(client, dropId);
    if (!row)
      throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Drop ${dropId} not found` });
    return row;
  }

  private async requireDropForUpdate(client: PoolClient, dropId: UUID): Promise<DropWithSjRow> {
    const row = await selectDropByIdForUpdate(client, dropId);
    if (!row)
      throw new NotFoundException({ code: 'ERR_NOT_FOUND', message: `Drop ${dropId} not found` });
    return row;
  }

  private async shipmentTypeId(client: PoolClient, sjId: UUID): Promise<string> {
    const res = await client.query<{ shipment_type_id: string }>(
      `SELECT shipment_type_id FROM surat_jalan WHERE id = $1`,
      [sjId],
    );
    return res.rows[0]!.shipment_type_id;
  }

  /** Shared temp-log write for `applyDepart`/`applyArrive`/`applyReceive` — `loggedAt` (when supplied, always by the projector) is the event's defensible server-witnessed time, never a fresh `new Date()` (see `ColdChainService.logTemperature`'s doc comment). */
  private async logTempForDrop(
    client: PoolClient,
    row: DropWithSjRow,
    stage: 'depart' | 'arrive',
    tempC: Temp,
    actorUserId: UUID,
    loggedAt?: string,
  ): Promise<void> {
    const sjHeader = (await selectSuratJalanHeader(client, row.sj_id))!;
    const shipmentType = await this.coldChain.loadShipmentType(
      client,
      await this.shipmentTypeId(client, row.sj_id),
    );
    const recipients = await this.coldChain.resolveBreachRecipients(
      client,
      sjHeader.origin_location_id,
    );
    await this.coldChain.logTemperature(client, {
      sjId: row.sj_id,
      dropId: row.id,
      stage,
      tempC,
      loggedBy: actorUserId,
      shipmentType,
      locationName: row.location_name,
      locationId: row.location_id,
      originLocationId: sjHeader.origin_location_id,
      dropSeq: row.drop_seq, // cargo for THIS drop and every later one is still onboard at depart/arrive
      notifyUserIds: recipients,
      loggedAt,
    });
  }

  private async assertAttachments(
    client: PoolClient,
    ids: readonly UUID[],
    dropId: UUID,
    expectedKind: string,
  ): Promise<void> {
    for (const id of ids) {
      const res = await client.query<{ kind: string }>(
        `SELECT kind FROM attachments WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row)
        throw new NotFoundException({
          code: 'ERR_NOT_FOUND',
          message: `Attachment ${id} not found — confirm the upload before receiving`,
        });
      if (row.kind !== expectedKind) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Attachment ${id} is kind '${row.kind}', expected '${expectedKind}' for drop ${dropId}`,
        });
      }
    }
  }

  /**
   * D-14: "SJ auto-completes when every drop is terminal; linked requests
   * flip received→completed when all lines reconciled." Also reverses the
   * `transfer_out` posted at dispatch for any FAILED drop's lines (stock
   * returns to the warehouse) — a failed drop never physically left Mimi's
   * custody in any lasting sense once the truck is back.
   *
   * Public: also called by `DeliverySyncProjector` after projecting an
   * offline `sj_drops.received` fact (same post-receive completion check the
   * REST path runs, via `applyReceive` above).
   */
  async checkAndCompleteSuratJalan(
    client: PoolClient,
    sjId: UUID,
    actorUserId: UUID,
  ): Promise<void> {
    const dropsRes = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM sj_drops WHERE sj_id = $1`,
      [sjId],
    );
    const allTerminal = dropsRes.rows.every((d) => TERMINAL_DROP_STATUSES.has(d.status));
    if (!allTerminal) return;

    const header = await selectSuratJalanHeader(client, sjId);
    if (!header || header.status === 'completed') return;

    for (const drop of dropsRes.rows.filter((d) => d.status === 'failed')) {
      await this.reverseFailedDropStock(client, header.origin_location_id, drop.id, actorUserId);
    }

    await client.query(
      `UPDATE surat_jalan SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [sjId],
    );
    await this.emitSjUpdated(client, sjId, actorUserId, header);

    const requestIds = new Set(
      dropsRes.rows.length > 0 ? await this.linkedRequestIds(client, sjId) : [],
    );
    for (const requestId of requestIds) {
      await this.replenishment.tryAutoComplete(client, requestId);
    }
  }

  /** Shared `surat_jalan.updated` emission (full snapshot, matching `issued`'s shape plus `status`/`dispatchedAt`/`completedAt`) — used by every SJ-aggregate-level change this service makes (a drop failing, or the SJ completing). */
  private async emitSjUpdated(
    client: PoolClient,
    sjId: UUID,
    actorUserId: UUID,
    headerHint?: Awaited<ReturnType<typeof selectSuratJalanHeader>>,
  ): Promise<void> {
    const header = headerHint ?? (await selectSuratJalanHeader(client, sjId));
    if (!header) return;
    const full = await buildSuratJalanFull(client, header);
    // `DropLine` (the response DTO) carries `unitCode` for display, not the raw `unit_id` the wire schema
    // needs — fetch the raw rows once for that one field (same pattern as `surat-jalan.service.ts`'s own `emitUpdated`).
    const rawLines = await selectLinesForSj(client, sjId);
    const rawLinesByDrop = new Map<string, typeof rawLines>();
    for (const l of rawLines) {
      const list = rawLinesByDrop.get(l.drop_id) ?? [];
      list.push(l);
      rawLinesByDrop.set(l.drop_id, list);
    }
    await this.syncEmit.emit(client, {
      entity: 'surat_jalan',
      op: 'updated',
      entityId: sjId,
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
          lines: (rawLinesByDrop.get(d.id) ?? []).map((l) => ({
            itemId: l.item_id,
            qty: l.qty,
            unitId: l.unit_id,
            requestLineId: l.request_line_id ?? undefined,
          })),
        })),
      },
    });
  }

  private async linkedRequestIds(client: PoolClient, sjId: UUID): Promise<UUID[]> {
    const res = await client.query<{ replenishment_request_id: string }>(
      `SELECT DISTINCT replenishment_request_id FROM sj_drops WHERE sj_id = $1 AND replenishment_request_id IS NOT NULL`,
      [sjId],
    );
    return res.rows.map((r) => r.replenishment_request_id);
  }

  private async reverseFailedDropStock(
    client: PoolClient,
    originLocationId: UUID,
    dropId: UUID,
    actorUserId: UUID,
  ): Promise<void> {
    const lines = await client.query<{
      item_id: string;
      qty: string;
      storage_type: 'frozen' | 'chilled' | 'dry';
      avg_cost: string;
    }>(
      `SELECT sl.item_id, sl.qty, i.storage_type, i.avg_cost FROM sj_lines sl JOIN items i ON i.id = sl.item_id WHERE sl.drop_id = $1`,
      [dropId],
    );
    if (lines.rows.length === 0) return;

    const movements: PostMovementInput[] = [];
    for (const l of lines.rows) {
      const areaRes = await client.query<{ id: string }>(
        `SELECT id FROM storage_areas WHERE location_id = $1 AND type = $2 AND is_active = true ORDER BY sort_order ASC LIMIT 1`,
        [originLocationId, requiredAreaTypeFor(l.storage_type)],
      );
      const areaId = areaRes.rows[0]?.id;
      if (!areaId) continue; // best-effort reversal — a missing area here would already have blocked dispatch
      movements.push({
        locationId: originLocationId,
        storageAreaId: areaId,
        itemId: l.item_id,
        movementType: MovementType.TRANSFER_IN,
        qty: l.qty,
        unitCost: l.avg_cost,
        refType: 'sj_drop_failed_return',
        refId: dropId,
        actorId: actorUserId,
      });
    }
    if (movements.length > 0) await this.stockLedger.post(client, movements, 'fact');
  }
}
