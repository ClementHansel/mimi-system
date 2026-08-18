/**
 * Reconciliation jobs R1-R10 — SYNC-PROTOCOL §5.5. Every job is a plain
 * callable method (triggerable on demand via `POST /api/sync/reconcile/
 * :locationId` and, for R1/R9/R10, on a lightweight internal interval — see
 * `sync.module.ts`'s `onModuleInit`) so tests can invoke them directly
 * without waiting on a clock.
 *
 * Several jobs (R4/R5/R7/R8) need fields OUT OF payload.data pinned down by
 * `packages/sync-protocol/src/schema/registry.ts` (W1-B's payload schema
 * registry) — field names below match that registry exactly. R1/R2/R6/R9
 * need no payload introspection at all (they read only `stock_movements`/
 * `stock_balances`/`offline_authorizations`/`sync_events` bookkeeping
 * columns).
 *
 * RLS (D-21/D-22): every query here runs through `withSystemContext`
 * (`system-rls-context.ts`) — these jobs are cross-tenant by nature (R1
 * reconciles ONE location at a time but R9/R10/R6 sweep ALL of them), so
 * they need the same central-role RLS bypass an Owner/Manager gets, not a
 * per-request user's scope. See that file's header for the one table this
 * does NOT unlock (`offline_credentials` — SELF-only RLS, no central
 * bypass exists, flagged as a blocker in the W2-D report).
 */
import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { Money, Qty, UUID } from '@mimi/shared';
import { compareMoney, subMoney } from '@mimi/shared';
import { subQty } from '@mimi/shared';
import {
  computeAreaBalanceChecksums,
  foldMovementsToBalances,
  reconcileBalance,
  type AreaBalanceRow,
  type MovementFact,
} from '@mimi/sync-protocol';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { SyncEventsRepository } from './sync-events.repository';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { RegistryRepository } from './registry.repository';
import { readShiftClosed, readSaleLines } from './payload-shapes';
import { GAP_STALE_THRESHOLD_MS } from './constants';
import { withSystemContext } from './system-rls-context';

interface StockMovementDbRow {
  id: UUID;
  location_id: UUID;
  storage_area_id: UUID;
  item_id: UUID;
  movement_type: MovementFact['movementType'];
  qty: Qty;
  unit_cost: Money;
  ref_type: string;
  ref_id: UUID | null;
  occurred_at: string;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly events: SyncEventsRepository,
    private readonly conflicts: SyncConflictsRepository,
    private readonly registry: RegistryRepository,
  ) {}

  // ── R1: balance recompute (the D-16 canary) ───────────────────────────────
  /** Compares `stock_balances` against a from-scratch fold of `stock_movements`, per location. Both are cloud-side — any mismatch is a projector bug, never a sync concern. */
  async runR1(locationId: UUID): Promise<{ checked: number; mismatches: number }> {
    return withSystemContext(this.pool, async (client) => {
      const movementsRes = await client.query<StockMovementDbRow>(
        `SELECT id, location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at
           FROM stock_movements WHERE location_id = $1`,
        [locationId],
      );
      const movements: MovementFact[] = movementsRes.rows.map((r) => ({
        locationId: r.location_id,
        storageAreaId: r.storage_area_id,
        itemId: r.item_id,
        factId: r.id,
        movementType: r.movement_type,
        qty: r.qty,
        unitCost: r.unit_cost,
        refType: r.ref_type,
        refId: r.ref_id,
        occurredAt: r.occurred_at,
      }));
      const folded = foldMovementsToBalances(movements);

      const balancesRes = await client.query<{
        storage_area_id: UUID;
        item_id: UUID;
        qty_on_hand: Qty;
      }>(
        `SELECT storage_area_id, item_id, qty_on_hand FROM stock_balances WHERE location_id = $1`,
        [locationId],
      );

      let mismatches = 0;
      const seenKeys = new Set<string>();
      for (const row of balancesRes.rows) {
        const key = `${row.storage_area_id}::${row.item_id}`;
        seenKeys.add(key);
        const check = reconcileBalance(
          { locationId, storageAreaId: row.storage_area_id, itemId: row.item_id },
          row.qty_on_hand,
          movements,
        );
        if (!check.matches) {
          mismatches++;
          await this.openStockReconciliation(
            client,
            locationId,
            row.storage_area_id,
            row.item_id,
            'cloud',
            check.expectedQty,
            check.storedQty,
            { job: 'R1' },
          );
        }
      }
      // Folded keys with NO stored balance row at all (balance never initialized) are also a divergence.
      for (const [key, bal] of folded) {
        if (seenKeys.has(key)) continue;
        mismatches++;
        await this.openStockReconciliation(
          client,
          locationId,
          bal.storageAreaId,
          bal.itemId,
          'cloud',
          bal.qtyOnHand,
          '0.000',
          { job: 'R1', note: 'no stock_balances row exists yet' },
        );
      }

      return { checked: seenKeys.size + folded.size, mismatches };
    });
  }

  // ── R2: tier checksum probe ────────────────────────────────────────────────
  /**
   * Compares an edge-derived `area_hashes` payload (device/node daily
   * `sync.balance_checksum` telemetry — the exact transport for which is
   * this engine's own extension of §4.6, see `sync.gateway.ts`'s
   * `sync:checksum` message) against the cloud's own per-area checksum
   * computed from CURRENT `stock_balances`.
   */
  async runR2(
    locationId: UUID,
    originId: UUID,
    edgeAreaHashes: Record<string, string>,
  ): Promise<{ divergentAreas: string[] }> {
    return withSystemContext(this.pool, async (client) => {
      const balancesRes = await client.query<AreaBalanceRow>(
        `SELECT storage_area_id AS "storageAreaId", item_id AS "itemId", qty_on_hand::text AS "qtyOnHand"
           FROM stock_balances WHERE location_id = $1`,
        [locationId],
      );
      const cloudHashes = computeAreaBalanceChecksums(balancesRes.rows);
      const divergentAreas: string[] = [];

      for (const [areaId, edgeHash] of Object.entries(edgeAreaHashes)) {
        if (cloudHashes[areaId] !== edgeHash) {
          divergentAreas.push(areaId);
          await this.conflicts.recordConflictIfAbsent(client, {
            kind: 'negative_balance', // closest existing SyncConflictKind bucket for "tier_divergence"; see detail.reason
            queue: 'exception',
            entity: 'stock_balances',
            entityId: null,
            locationId,
            detail: {
              job: 'R2',
              reason: 'tier_divergence',
              storageAreaId: areaId,
              originId,
              cloudHash: cloudHashes[areaId] ?? null,
              edgeHash,
            },
            assigneeRole: 'kepala_gudang',
          });
        }
      }
      return { divergentAreas };
    });
  }

  // ── R3: evidence SLA ────────────────────────────────────────────────────
  async runR3(): Promise<{ flagged: number }> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{
        event_id: UUID;
        entity: string;
        entity_id: UUID;
        location_id: UUID | null;
        payload: unknown;
      }>(
        `SELECT event_id, entity, entity_id, location_id, payload FROM sync_events
          WHERE apply_status = 'applied' AND applied_at < NOW() - INTERVAL '24 hours'
            AND (payload->'data' @> '{}'::jsonb)
            AND (payload #> '{data,attachmentRef}' IS NOT NULL OR payload #> '{data,attachment_ref}' IS NOT NULL
                 OR payload #> '{data,photoRef}' IS NOT NULL OR payload #> '{data,photo_ref}' IS NOT NULL)`,
      );
      let flagged = 0;
      for (const row of res.rows) {
        const data = (row.payload as { data?: Record<string, unknown> }).data ?? {};
        const ref = (data.attachmentRef ??
          data.attachment_ref ??
          data.photoRef ??
          data.photo_ref) as { sha256?: string } | undefined;
        const sha256 = ref?.sha256;
        if (!sha256) continue;
        const resolved = await client.query(`SELECT 1 FROM attachments WHERE sha256 = $1`, [
          sha256,
        ]);
        if ((resolved.rowCount ?? 0) > 0) continue;
        flagged++;
        await this.conflicts.recordConflictIfAbsent(client, {
          kind: 'poison', // no dedicated evidence-SLA kind exists in the closed `SyncConflictKind` list — see report note
          queue: 'exception',
          entity: row.entity,
          entityId: row.entity_id,
          locationId: row.location_id,
          detail: { job: 'R3', reason: 'evidence_sla', sha256 },
        });
      }
      return { flagged };
    });
  }

  // ── R4: price variance ─────────────────────────────────────────────────
  async runR4(sinceIso: string): Promise<{ flagged: number }> {
    return withSystemContext(this.pool, async (client) => {
      const tolerancePct = await this.registry.getSetting<{ pct?: string }>(
        client,
        'sync.price_variance_tolerance',
        { pct: '1.0' },
      );
      const tolerance = Number(tolerancePct.pct ?? '1.0') / 100;

      const res = await client.query<{
        event_id: UUID;
        entity_id: UUID;
        location_id: UUID | null;
        payload: unknown;
        occurred_at: string;
      }>(
        `SELECT event_id, entity_id, location_id, payload, occurred_at FROM sync_events
          WHERE entity = 'sales' AND op = 'completed' AND apply_status = 'applied' AND occurred_at >= $1`,
        [sinceIso],
      );
      let flagged = 0;
      for (const row of res.rows) {
        const lines = readSaleLines((row.payload as { data?: unknown }).data);
        for (const line of lines) {
          const catalog = await client.query<{ price: Money }>(
            `SELECT price FROM products WHERE id = $1`,
            [line.productId],
          );
          const catalogPrice = catalog.rows[0]?.price;
          if (!catalogPrice) continue;
          const diff = Number(subMoney(line.unitPrice, catalogPrice));
          const ratio = Number(catalogPrice) === 0 ? 0 : Math.abs(diff) / Number(catalogPrice);
          if (ratio > tolerance) {
            flagged++;
            await this.conflicts.recordConflictIfAbsent(client, {
              kind: 'poison',
              queue: 'exception',
              entity: 'sales',
              entityId: row.entity_id,
              locationId: row.location_id,
              detail: {
                job: 'R4',
                reason: 'price_variance',
                productId: line.productId,
                soldAt: line.unitPrice,
                catalogPrice,
                ratio,
              },
            });
          }
        }
      }
      return { flagged };
    });
  }

  // ── R5: duplicate inbound (C6) ──────────────────────────────────────────
  /** Same location + overlapping items within a 6h window, one `sj_drops.received` and one `goods_receipts.recorded` — heuristic, not exact (per spec, "window heuristic"). */
  async runR5(sinceIso: string): Promise<{ flagged: number }> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ a_id: UUID; a_location: UUID; b_id: UUID }>(
        `SELECT a.entity_id AS a_id, a.location_id AS a_location, b.entity_id AS b_id
           FROM sync_events a
           JOIN sync_events b
             ON a.location_id = b.location_id
            AND a.entity = 'sj_drops' AND a.op = 'received'
            AND b.entity = 'goods_receipts' AND b.op = 'recorded'
            AND ABS(EXTRACT(EPOCH FROM (a.occurred_at - b.occurred_at))) < 6 * 3600
          WHERE a.apply_status = 'applied' AND b.apply_status = 'applied'
            AND a.occurred_at >= $1 AND b.occurred_at >= $1`,
        [sinceIso],
      );
      for (const row of res.rows) {
        await this.conflicts.recordConflictIfAbsent(client, {
          kind: 'duplicate_inbound',
          queue: 'exception',
          entity: 'sj_drops',
          entityId: row.a_id,
          locationId: row.a_location,
          detail: { job: 'R5', reason: 'duplicate_inbound', goodsReceiptEntityId: row.b_id },
          assigneeRole: 'kepala_gudang',
        });
      }
      return { flagged: res.rows.length };
    });
  }

  // ── R6: offline-authorization re-verification sweep (safety net) ────────
  /** The immediate hook is `OfflineAuthService.verifyAndRecord` (run at apply). This sweeps anything still `pending_verification` past a grace window — a missed-hook safety net, not the primary path. */
  async runR6(graceMs = 5 * 60 * 1000): Promise<{ swept: number }> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ id: UUID }>(
        `SELECT id FROM offline_authorizations WHERE outcome = 'pending_verification' AND created_at < NOW() - ($1 || ' milliseconds')::interval`,
        [graceMs],
      );
      // Re-verification itself re-enters via the SAME code path as the immediate hook (OfflineAuthService),
      // which requires the original event envelope — reconstructing and re-dispatching is the ingest
      // pipeline's job (`sync-ingest.service.ts`), not this job's; this method only surfaces the backlog
      // size so F12/ops can see whether the immediate hook is keeping up (should normally be ~0).
      return { swept: res.rows.length };
    });
  }

  // ── R7: shift-close recompute (+ D-19 cash-variance proposal) ────────────
  /** Runs at apply of `pos_shifts.closed` (wired from `sync-ingest.service.ts`). Self-contained: computes totals from the SHIFT's own event set (client_seq bracketing, §6.4 — immune to clock lies), never trusts declared totals. */
  async runR7ForClosedShift(
    originDeviceId: UUID,
    shiftEntityId: UUID,
    closedClientSeq: bigint,
    closedPayloadData: unknown,
    closedByUserId: UUID,
  ): Promise<void> {
    return withSystemContext(this.pool, async (client) => {
      const openedRes = await client.query<{ client_seq: string; location_id: UUID | null }>(
        `SELECT client_seq, location_id FROM sync_events
          WHERE origin_device_id = $1 AND entity = 'pos_shifts' AND op = 'opened' AND entity_id = $2`,
        [originDeviceId, shiftEntityId],
      );
      const opened = openedRes.rows[0];
      if (!opened) return; // no matching open — nothing to bracket against (opname never seen this shift's start)
      const openedSeq = BigInt(opened.client_seq);

      const salesRes = await client.query<{ payload: unknown }>(
        `SELECT payload FROM sync_events
          WHERE origin_device_id = $1 AND entity = 'sales' AND op = 'completed'
            AND client_seq > $2 AND client_seq < $3 AND apply_status = 'applied'`,
        [originDeviceId, openedSeq.toString(), closedClientSeq.toString()],
      );

      let expectedCash = '0.00' as Money;
      for (const row of salesRes.rows) {
        // `sales.completed`'s `payments[]` shape — packages/sync-protocol/src/schema/registry.ts GROUP_6_SCHEMAS.
        const data =
          (row.payload as { data?: { payments?: { method?: string; amount?: Money }[] } }).data ??
          {};
        for (const payment of data.payments ?? []) {
          if (payment.method === 'cash' && payment.amount) {
            expectedCash = (Number(expectedCash) + Number(payment.amount)).toFixed(2) as Money;
          }
        }
      }

      const shift = readShiftClosed(closedPayloadData);
      const countedCash = shift.closingCashCounted ?? '0.00';
      const variance = subMoney(countedCash, expectedCash);
      if (compareMoney(variance, '0.00') === 0) return;

      await this.conflicts.recordConflictIfAbsent(client, {
        kind: 'poison',
        queue: 'finance',
        entity: 'pos_shifts',
        entityId: shiftEntityId,
        locationId: opened.location_id,
        detail: { job: 'R7', reason: 'cash_variance', expectedCash, countedCash, variance },
        assigneeRole: 'finance',
      });

      if (compareMoney(variance, '0.00') < 0) {
        const proposeAbove = await this.registry.getSettingMoney(
          client,
          'pos.cash_variance_propose_above',
          '0.00',
        );
        const shortfall = subMoney(expectedCash, countedCash);
        if (compareMoney(shortfall, proposeAbove) > 0 || compareMoney(proposeAbove, '0.00') === 0) {
          await client.query(
            `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, amount, status)
             SELECT $1, $2, $3, $4, 'pending'
             WHERE NOT EXISTS (SELECT 1 FROM cash_variance_proposals WHERE shift_id = $1)`,
            [shiftEntityId, opened.location_id, closedByUserId, shortfall],
          );
        }
      }
    });
  }

  // ── R8: SJ completeness ──────────────────────────────────────────────────
  async runR8(): Promise<{ overdueDrops: number; overdueSj: number }> {
    return withSystemContext(this.pool, async (client) => {
      const drops = await client.query<{ entity_id: UUID; location_id: UUID | null }>(
        `SELECT departed.entity_id, departed.location_id
           FROM sync_events departed
          WHERE departed.entity = 'sj_drops' AND departed.op = 'departed' AND departed.apply_status = 'applied'
            AND departed.occurred_at < NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM sync_events recv
               WHERE recv.entity = 'sj_drops' AND recv.op = 'received' AND recv.entity_id = departed.entity_id
            )`,
      );
      for (const row of drops.rows) {
        await this.conflicts.recordConflictIfAbsent(client, {
          kind: 'poison',
          queue: 'exception',
          entity: 'sj_drops',
          entityId: row.entity_id,
          locationId: row.location_id,
          detail: { job: 'R8', reason: 'overdue_drop' },
        });
      }

      const sjs = await client.query<{ entity_id: UUID; location_id: UUID | null }>(
        `SELECT issued.entity_id, issued.location_id
           FROM sync_events issued
          WHERE issued.entity = 'surat_jalan' AND issued.op = 'issued' AND issued.apply_status = 'applied'
            AND issued.occurred_at < NOW() - INTERVAL '24 hours'
            AND NOT EXISTS (
              SELECT 1 FROM sync_events dep
               WHERE dep.entity = 'sj_drops' AND dep.op = 'departed'
            )`,
      );
      for (const row of sjs.rows) {
        await this.conflicts.recordConflictIfAbsent(client, {
          kind: 'poison',
          queue: 'exception',
          entity: 'surat_jalan',
          entityId: row.entity_id,
          locationId: row.location_id,
          detail: { job: 'R8', reason: 'overdue_sj_no_departure' },
        });
      }
      return { overdueDrops: drops.rows.length, overdueSj: sjs.rows.length };
    });
  }

  // ── R9: sequence-gap sweep ───────────────────────────────────────────────
  async runR9(): Promise<{ staleOrigins: UUID[] }> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ origin_device_id: UUID; oldest_parked: string }>(
        `SELECT origin_device_id, MIN(received_at) AS oldest_parked
           FROM sync_events
          WHERE apply_status = 'pending_dependency'
          GROUP BY origin_device_id`,
      );
      const stale: UUID[] = [];
      for (const row of res.rows) {
        const ageMs = Date.now() - new Date(row.oldest_parked).getTime();
        if (ageMs > GAP_STALE_THRESHOLD_MS) {
          stale.push(row.origin_device_id);
          const frozen = await this.events.isOriginFrozen(client, row.origin_device_id);
          await this.conflicts.recordConflictIfAbsent(client, {
            kind: 'poison',
            queue: 'exception',
            entity: 'sync_events',
            entityId: null,
            locationId: null,
            detail: {
              job: 'R9',
              reason: 'possible_data_loss',
              originDeviceId: row.origin_device_id,
              ageMs,
              alsoFrozen: frozen,
            },
          });
        }
      }
      return { staleOrigins: stale };
    });
  }

  // ── R10: cursor/retention guard ──────────────────────────────────────────
  async runR10(): Promise<{ expired: { subscriberId: UUID; subscriberType: string }[] }> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ subscriber_id: UUID; subscriber_type: 'device' | 'node' }>(
        `SELECT subscriber_id, subscriber_type FROM sync_cursors
          WHERE (subscriber_type = 'device' AND updated_at < NOW() - INTERVAL '14 days')
             OR (subscriber_type = 'node' AND updated_at < NOW() - INTERVAL '90 days')`,
      );
      return {
        expired: res.rows.map((r) => ({
          subscriberId: r.subscriber_id,
          subscriberType: r.subscriber_type,
        })),
      };
    });
  }

  private async openStockReconciliation(
    client: PoolClient,
    locationId: UUID,
    storageAreaId: UUID,
    itemId: UUID,
    tier: 'device' | 'node' | 'cloud',
    expectedQty: Qty,
    storedQty: Qty,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const divergence = subQty(expectedQty, storedQty);
    await client.query(
      `INSERT INTO stock_reconciliations (location_id, storage_area_id, item_id, tier, expected_qty, stored_qty, divergence, detail)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8
       WHERE NOT EXISTS (
         SELECT 1 FROM stock_reconciliations
          WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3 AND tier = $4 AND status = 'open'
       )`,
      [
        locationId,
        storageAreaId,
        itemId,
        tier,
        expectedQty,
        storedQty,
        divergence,
        JSON.stringify(detail),
      ],
    );
  }
}
