import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  MovementType,
  RoleKey,
  businessDateOf,
  formatCloudDocNumber,
  isNegativeQty,
  isZeroQty,
  type Money,
  type Qty,
  type UUID,
} from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from '../../../kernel/sync/sync-projector.types';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import type { PostMovementInput } from '../../../kernel/stock-ledger/stock-ledger.types';
import { selectDropById, selectSuratJalanHeader } from '../queries';
import { ColdChainService } from './cold-chain.service';
import { DropService } from './drop.service';

// ── Wire payload shapes (packages/sync-protocol/src/schema/registry.ts, GROUP_4_SCHEMAS) ──

interface DepartedPayload {
  dropId: UUID;
  at: string;
  tempC?: string;
}

interface SealCheckPayload {
  sealId: UUID;
  status: 'verified_intact' | 'broken';
  notes?: string;
}

interface ArrivedPayload {
  dropId: UUID;
  at: string;
  tempC: string;
  sealCheck?: SealCheckPayload;
}

interface ReceivedLinePayload {
  lineId: UUID;
  qtyReceived: Qty;
  receivedStorageAreaId: UUID;
  discrepancyReason?: string;
}

interface ReceivedPayload {
  dropId: UUID;
  lines: ReceivedLinePayload[];
  photoAttachmentIds: UUID[];
  signatureAttachmentId: UUID;
  tempC?: string;
  discrepancyNotes?: string;
  /** Additive field this module's owner added to the registry (sanctioned, sj_drops.received only) — see registry.ts's comment. */
  clientId?: UUID;
}

interface TempLoggedPayload {
  sjId: UUID;
  dropId?: UUID;
  stage: 'load' | 'depart' | 'arrive';
  tempC: string;
}

interface GoodsReceiptLinePayload {
  itemId: UUID;
  qty: Qty;
  storageAreaId: UUID;
  unitCost: Money;
}

interface GoodsReceiptPayload {
  id: UUID;
  locationId: UUID;
  lines: GoodsReceiptLinePayload[];
  photoAttachmentIds: UUID[];
  notes?: string;
}

/**
 * M10's `SyncProjector` — the piece that makes offline delivery real
 * (coordinator's follow-up): until this existed, a device-originated
 * `sj_drops.received`/`goods_receipts.recorded`/etc. fact durably logged in
 * `sync_events`, got deduped and conflict-checked, and then never became a
 * domain row — a drop received by a driver with no signal would sync up and
 * simply not exist as a receipt.
 *
 * Registered via `DeliveryModule.onModuleInit()` (self-service — kernel/sync
 * never imports this module, see `sync-projector.types.ts`'s header).
 *
 * REFACTOR, NOT DUPLICATE (coordinator's follow-up, cross-referencing
 * W3-09's own projector): every `sj_drops.*` op below calls `DropService`'s
 * non-emitting apply CORE (`applyDepart`/`applyArrive`/`applyReceive`) — the
 * EXACT same code the REST controller's `depart`/`arrive`/`receive` call —
 * so an offline-synced fact and an online one land in byte-identical rows
 * (same storage-area validation, same discrepancy handling, same
 * replenishment/SJ-completion side effects). This file's only job is: parse
 * the wire payload, decide the `mode`/timestamp/dedup-key arguments the core
 * needs, and skip cleanly when idempotency or conflict rules say so.
 *
 * DEFENSIBLE TIMESTAMPS (coordinator finding): `event.relayReceivedAt` is
 * declared on `SyncEventEnvelope` but NOT reliably populated on the in-memory
 * object this method receives (`sync-ingest.service.ts`'s `envelopeFromRow`
 * omits it) — reading it from there would silently be `undefined`. Cold-chain
 * temperature timing is evidence ("when was this reading taken, and when did
 * we learn about it"), so this projector reads `sync_events.relay_received_at`
 * (falling back to `received_at`) back from the row `SyncIngestService` wrote
 * in THIS SAME transaction, ONCE per event, and threads that through as the
 * explicit `loggedAt` argument to `ColdChainService.logTemperature` (via the
 * apply cores) — NEVER `new Date()`, which would silently move forward on
 * every re-projection retry (a `projection_failed` sweep, or a rare crash
 * retry) and destroy exactly the defensibility distinction that matters.
 * `departed_at`/`arrived_at`/`received_at` do NOT have this problem — they
 * already come from the payload's own `at`/business timestamp fields
 * (stable across replay by construction, never re-derived here).
 *
 * IDEMPOTENCY (three layers — the interface requires safety even though a
 * re-projection sweep calling `project()` twice for the SAME event is rare):
 *  1. `sj_drops.departed`/`arrived` have no client-minted id of their own in
 *     the wire schema — idempotency is STATE-based (`DropService.applyDepart`/
 *     `applyArrive` only apply from the expected PRECEDING status; a replay
 *     finds the row already advanced and cleanly no-ops).
 *  2. `sj_drops.received` ADDITIONALLY dedupes BELOW the registry — on
 *     `sj_drops.client_id` (a client-supplied id, independent of
 *     `event.eventId`'s own uniqueness guarantee — see `DropService
 *     .applyReceive`'s doc comment) — because a duplicate receipt means
 *     goods counted into stock twice, a consequence severe enough to want a
 *     second, independent guard beyond "the registry already deduped this
 *     event_id."
 *  3. `sj_temperature_logs.logged` and `goods_receipts.recorded` carry (or
 *     are given) a client-minted id — `ColdChainService.logTemperature`
 *     already `ON CONFLICT (client_id) DO NOTHING`s (this projector supplies
 *     `event.eventId` as that key when the payload itself has none), and
 *     `goods_receipts.recorded`'s payload `id` is checked for existence
 *     before insert.
 *  4. `StockLedgerService.post()` is idempotent on its own natural key
 *     (`ref_type`/`ref_id`/`item_id`/`storage_area_id`/`movement_type`) — a
 *     further layer under (1)/(2), not a substitute for them.
 *
 * STOCK: every posting here uses `mode: 'fact'` (D-17a) — a replayed receipt
 * that would drive a balance negative still applies and opens a
 * `stock_reconciliations` exception instead of being rejected, because the
 * goods physically arrived regardless of what the ledger currently shows.
 *
 * CONFLICT LOSERS: `context.isConflictLoser` is only ever `true` here for
 * `sj_drops.received` (SYNC-PROTOCOL §5.2 C2 — a second `received` for the
 * same drop) — handled by skipping entirely (no stock/business effect for
 * the loser). The other four ops are defensively skipped too on a `true`
 * flag even though no enumerated conflict kind sets it for them today.
 */
@Injectable()
export class DeliverySyncProjector implements SyncProjector {
  private readonly logger = new Logger(DeliverySyncProjector.name);

  readonly handles = [
    'sj_drops.departed',
    'sj_drops.arrived',
    'sj_drops.received',
    'sj_temperature_logs.logged',
    'goods_receipts.recorded',
  ];

  constructor(
    private readonly events: SyncEventsRepository,
    private readonly stockLedger: StockLedgerService,
    private readonly coldChain: ColdChainService,
    private readonly dropService: DropService,
  ) {}

  async project(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext): Promise<void> {
    // Read the defensible, server-witnessed time back from the SAME transaction's `sync_events` row —
    // never trust `event.relayReceivedAt` (unreliable on the in-memory envelope) and never compute a fresh
    // `new Date()` (would move forward on every re-projection retry). One query, shared by every op below.
    const loggedAt = await this.resolveDefensibleAt(client, event.eventId);

    const key = `${event.entity}.${event.op}`;
    switch (key) {
      case 'sj_drops.departed':
        return this.projectDeparted(client, event, context, loggedAt);
      case 'sj_drops.arrived':
        return this.projectArrived(client, event, context, loggedAt);
      case 'sj_drops.received':
        return this.projectReceived(client, event, context, loggedAt);
      case 'sj_temperature_logs.logged':
        return this.projectTempLogged(client, event, context, loggedAt);
      case 'goods_receipts.recorded':
        return this.projectGoodsReceipt(client, event, context);
      default:
        throw new Error(`DeliverySyncProjector: no handler registered for '${key}' — 'handles' and this switch have drifted`);
    }
  }

  private async resolveDefensibleAt(client: PoolClient, eventId: UUID): Promise<string> {
    const row = await this.events.findByEventId(client, eventId);
    if (!row) {
      // Should be impossible — `SyncIngestService` always inserts the `sync_events` row before calling
      // `runApplyHooks` in the SAME transaction — but fail loudly rather than silently reaching for `now()`.
      throw new Error(`DeliverySyncProjector: no sync_events row found for event ${eventId} in the current transaction`);
    }
    return row.relay_received_at ?? row.received_at;
  }

  // ── sj_drops.departed ────────────────────────────────────────────────

  private async projectDeparted(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext, loggedAt: string): Promise<void> {
    if (context.isConflictLoser) return;
    const data = event.payload.data as DepartedPayload;

    const result = await this.dropService.applyDepart(
      client,
      { dropId: data.dropId, at: data.at, tempC: data.tempC, actorUserId: event.actorUserId },
      { loggedAt },
    );
    if (!result.applied && result.reason === 'not_found') {
      this.logger.warn(`sj_drops.departed for unknown drop ${data.dropId} (event ${event.eventId}) — dropping silently`);
    }
    // `wrong_status` is the expected, silent idempotent-replay outcome — nothing to log.
  }

  // ── sj_drops.arrived ─────────────────────────────────────────────────

  private async projectArrived(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext, loggedAt: string): Promise<void> {
    if (context.isConflictLoser) return;
    const data = event.payload.data as ArrivedPayload;

    const result = await this.dropService.applyArrive(
      client,
      { dropId: data.dropId, at: data.at, tempC: data.tempC, sealCheck: data.sealCheck, actorUserId: event.actorUserId },
      { loggedAt },
    );
    if (!result.applied && result.reason === 'not_found') {
      this.logger.warn(`sj_drops.arrived for unknown drop ${data.dropId} (event ${event.eventId}) — dropping silently`);
    }
  }

  // ── sj_drops.received — the important one (FR-LOG-14/15/16, JOUT-01) ──

  private async projectReceived(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext, loggedAt: string): Promise<void> {
    if (context.isConflictLoser) {
      // C2: this event lost to an earlier `received` for the same drop — SYNC-PROTOCOL §5.2: "no stock
      // effect... second → sync_conflicts (duplicate_receipt)". The conflict row is already recorded by
      // `ConflictDetectorService.detectAtApply`; this projector's only job for the loser is to do nothing.
      this.logger.warn(`sj_drops.received event ${event.eventId} is a C2 conflict loser — skipping stock/business effect`);
      return;
    }
    const data = event.payload.data as ReceivedPayload;
    const actorRole = (event.payload.meta?.actorRole as RoleKey) || RoleKey.LEADER_OUTLET;

    const result = await this.dropService.applyReceive(
      client,
      {
        dropId: data.dropId,
        lines: data.lines,
        signatureAttachmentId: data.signatureAttachmentId,
        tempC: data.tempC,
        discrepancyNotes: data.discrepancyNotes,
        actorUserId: event.actorUserId,
        actorRole,
        occurredAt: event.occurredAt,
        mode: 'fact',
        // Dedup below the registry (coordinator's follow-up): a client-supplied id, independent of
        // `event.eventId`'s own uniqueness guarantee — falls back to `event.eventId` when the device/test
        // doesn't supply one, which is at least as strong as today's registry-only protection.
        clientId: data.clientId ?? event.eventId,
      },
      { loggedAt },
    );

    if (!result.applied) {
      if (result.reason === 'not_found') {
        this.logger.warn(`sj_drops.received for unknown drop ${data.dropId} (event ${event.eventId}) — dropping silently`);
      }
      // `wrong_status` / `duplicate_client_id` are expected, silent idempotent-replay outcomes.
      return;
    }
  }

  // ── sj_temperature_logs.logged ───────────────────────────────────────

  private async projectTempLogged(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext, loggedAt: string): Promise<void> {
    if (context.isConflictLoser) return;
    const data = event.payload.data as TempLoggedPayload;

    const sjHeader = await selectSuratJalanHeader(client, data.sjId);
    if (!sjHeader) {
      this.logger.warn(`sj_temperature_logs.logged for unknown Surat Jalan ${data.sjId} (event ${event.eventId}) — dropping silently`);
      return;
    }

    let locationId = sjHeader.origin_location_id;
    let locationName = 'Gudang Pusat';
    if (data.dropId) {
      const dropRow = await selectDropById(client, data.dropId);
      if (dropRow) {
        locationId = dropRow.location_id;
        locationName = dropRow.location_name;
      }
    }

    const shipmentTypeIdRes = await client.query<{ shipment_type_id: string }>(`SELECT shipment_type_id FROM surat_jalan WHERE id = $1`, [data.sjId]);
    const shipmentTypeId = shipmentTypeIdRes.rows[0]?.shipment_type_id;
    if (!shipmentTypeId) return;

    // `sj_temperature_logs.logged` has no REST-side "core" to share the way depart/arrive/receive do — the
    // standalone `/temperature-logs` endpoint's own `ColdChainService.recordStandalone` is ALREADY a thin,
    // non-duplicated wrapper over `logTemperature`; this projector calls the same underlying method
    // directly (both are just consumers of `ColdChainService`, injected here like any other module service).
    const shipmentType = await this.coldChain.loadShipmentType(client, shipmentTypeId);
    const recipients = await this.coldChain.resolveBreachRecipients(client, sjHeader.origin_location_id);
    await this.coldChain.logTemperature(client, {
      sjId: data.sjId,
      dropId: data.dropId ?? null,
      stage: data.stage,
      tempC: data.tempC,
      loggedBy: event.actorUserId,
      shipmentType,
      locationName,
      locationId,
      notifyUserIds: recipients,
      clientId: event.eventId,
      loggedAt,
    });
  }

  // ── goods_receipts.recorded ──────────────────────────────────────────

  private async projectGoodsReceipt(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext): Promise<void> {
    if (context.isConflictLoser) return;
    const data = event.payload.data as GoodsReceiptPayload;

    const existing = await client.query<{ id: string }>(`SELECT id FROM goods_receipts WHERE id = $1`, [data.id]);
    if (existing.rows[0]) return; // idempotent no-op — this exact client-minted receipt already landed

    const period = businessDateOf(event.occurredAt).slice(0, 7).replace('-', '');
    const numRes = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('GR', $1, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [period],
    );
    const receiptNumber = formatCloudDocNumber('GR', period, numRes.rows[0]!.last_number);

    // SYNC-PROTOCOL §8 row 6: a fact reaching the cloud via THIS op (rather than `sj_drops.received`) is,
    // by construction, the "device with no SJ cached" case — always flagged `unmatched_delivery` so it
    // lands in the R5/C6 reconciliation review queue rather than silently going unmatched. The wire schema
    // (registry.ts) carries no `receiptType`/`refId` field to say otherwise for a genuine supplier-direct
    // capture — flagged in the module report as a schema gap for the architect.
    await client.query(
      `INSERT INTO goods_receipts (id, receipt_number, receipt_type, location_id, received_by, received_at, notes, client_id)
       VALUES ($1, $2, 'unmatched_delivery', $3, $4, $5, $6, $1)`,
      [data.id, receiptNumber, data.locationId, event.actorUserId, event.occurredAt, data.notes ?? null],
    );

    const movements: PostMovementInput[] = [];
    for (const line of data.lines) {
      await client.query(
        `INSERT INTO goods_receipt_lines (receipt_id, item_id, storage_area_id, qty_expected, qty_received) VALUES ($1, $2, $3, $4, $4)`,
        [data.id, line.itemId, line.storageAreaId, line.qty],
      );
      if (!isZeroQty(line.qty) && !isNegativeQty(line.qty)) {
        movements.push({
          locationId: data.locationId,
          storageAreaId: line.storageAreaId,
          itemId: line.itemId,
          movementType: MovementType.TRANSFER_IN,
          qty: line.qty,
          unitCost: line.unitCost,
          refType: 'goods_receipt',
          refId: data.id,
          actorId: event.actorUserId,
          occurredAt: event.occurredAt,
        });
      }
    }
    if (movements.length > 0) {
      await this.stockLedger.post(client, movements, 'fact');
    }
  }
}
