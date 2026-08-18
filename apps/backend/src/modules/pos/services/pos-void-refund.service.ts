import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import {
  ApprovalDocumentType,
  ERR_AUTH_PIN_INVALID,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  JournalSystemEventType,
  MovementType,
  RoleKey,
  SaleStatus,
  VoidRefundStatus,
  type Money,
  type Paginated,
  type ReverificationStatus,
  type UUID,
  type VoidRefundType,
} from '@mimi/shared';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import type { PostMovementInput } from '../../../kernel/stock-ledger/stock-ledger.types';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { explodeRecipeUsage, findKitchenLineAreaId } from '../recipe-usage.util';
import { findUsersByRoleAtLocation, resolveUserNames } from '../notify-eligible-users.util';

export interface VoidRefundRow {
  id: UUID;
  saleId: UUID;
  receiptNumber: string;
  type: VoidRefundType;
  amount: Money;
  reason: string;
  status: VoidRefundStatus;
  requestedBy: string;
  approvedBy: string | null;
  offlineAuthorized: boolean;
  reverificationStatus: ReverificationStatus | null;
}

interface SaleForVoid {
  id: UUID;
  location_id: UUID;
  shift_id: UUID;
  status: SaleStatus;
  total: Money;
}

/**
 * `PosVoidRefundService` — FR-POS-03, APR-02, D-17. Every state transition
 * runs through `ApprovalService` (D-08) — `void_refunds.status` is this
 * module's own column (per `kernel/approvals/types.ts`'s division of
 * labour), but WHO may act and WHETHER a reason is required is entirely the
 * kernel's `transition()` table (`§5.2` in `packages/shared/src/approvals/
 * state-machine.ts`) — never re-decided here.
 *
 * This module's REST `approve`/`reject` endpoints are the ONLINE path only
 * (PIN-verified against the acting supervisor's own `users.pin_hash`). The
 * offline-provisional path (`void_refunds.approved_offline`, §7.3's cached
 * credential + PIN + selfie) is a sync EVENT, ingested by `kernel/sync` —
 * see the module report for why no domain-projection hook exists yet to
 * apply one into `void_refunds`/`sales`/stock (a gap shared by every
 * Wave 3+ push-class entity, not specific to this module).
 */
@Injectable()
export class PosVoidRefundService {
  private readonly logger = new Logger(PosVoidRefundService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly approvals: ApprovalService,
    private readonly stockLedger: StockLedgerService,
    private readonly syncEmit: SyncEmitService,
    private readonly notifications: NotificationService,
    private readonly eventBus: EventBus,
  ) {}

  async requestVoid(
    client: PoolClient,
    saleId: UUID,
    kasirId: UUID,
    input: { clientId: UUID; type: VoidRefundType; reason: string; amount?: Money },
  ): Promise<{ voidRefundId: UUID; status: 'pending' }> {
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM void_refunds WHERE client_id = $1`,
      [input.clientId],
    );
    if (existing.rows[0]) return { voidRefundId: existing.rows[0].id, status: 'pending' };

    const sale = await this.loadSaleForVoid(client, saleId);
    if (sale.status !== 'completed') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Sale ${saleId} is not in a voidable state (status=${sale.status})`,
      });
    }
    const pendingAlready = await client.query<{ id: UUID }>(
      `SELECT id FROM void_refunds WHERE sale_id = $1 AND status = 'pending'`,
      [saleId],
    );
    if (pendingAlready.rows[0]) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: 'A void/refund is already pending for this sale',
      });
    }

    const amount = input.amount ?? sale.total;
    const inserted = await client.query<{ id: UUID }>(
      `INSERT INTO void_refunds (sale_id, type, amount, reason, status, requested_by, client_id, occurred_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,NOW())
       RETURNING id`,
      [saleId, input.type, amount, input.reason, kasirId, input.clientId],
    );
    const voidId = inserted.rows[0]!.id;

    await this.approvals.submit(client, {
      documentType: ApprovalDocumentType.VOID_REFUND,
      documentId: voidId,
      requestedBy: kasirId,
      amount,
      locationId: sale.location_id,
    });

    // `users`/`user_locations` RLS (migration 009) only lets a Kasir see their OWN row — see
    // `notify-eligible-users.util.ts`'s header for why this lookup needs its own connection.
    const supervisorIds = await findUsersByRoleAtLocation(
      this.pool,
      ['supervisor', 'manager', 'owner'],
      sale.location_id,
    );
    if (supervisorIds.length > 0) {
      const saleRow = await client.query<{ receipt_number: string; location_name: string }>(
        `SELECT s.receipt_number, l.name AS location_name FROM sales s JOIN locations l ON l.id = s.location_id WHERE s.id = $1`,
        [saleId],
      );
      // Never let a notification failure roll back a real, already-persisted void request — see
      // `PosShiftService.createCashVarianceProposal`'s identical comment for why this can fail
      // (a `kernel/notification` gap, not this module's to silently work around by widening RLS).
      try {
        await this.notifications.notify({
          templateKey: 'approval_pending',
          userIds: supervisorIds,
          params: {
            documentType: 'void_refund',
            documentNumber: saleRow.rows[0]?.receipt_number ?? saleId,
            locationName: saleRow.rows[0]?.location_name ?? '',
          },
          locationId: sale.location_id,
        });
      } catch (err) {
        this.logger.error(
          `Failed to notify supervisors of void/refund request ${voidId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { voidRefundId: voidId, status: 'pending' };
  }

  async approve(
    client: PoolClient,
    voidId: UUID,
    actorUserId: UUID,
    actorRole: RoleKey,
    pin: string,
  ): Promise<{ id: UUID; status: VoidRefundStatus; offlineAuthorized: boolean }> {
    await this.verifyPin(client, actorUserId, pin);

    const row = await this.loadVoidRefund(client, voidId);
    if (row.status !== 'pending') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Void/refund ${voidId} is already ${row.status}`,
      });
    }
    const sale = await this.loadSaleForVoid(client, row.sale_id);

    // ApprovalService.decide() maps an unauthorized role to ForbiddenException(ERR_APPROVAL_STEP_ROLE) —
    // this is the RBAC enforcement point: a Kasir is never in VOID_REFUND's eligible role set
    // (§5.2: SUPERVISOR, +MANAGER/OWNER by rank override), so a Kasir calling this endpoint on
    // their OWN request fails here, never by client-side convention.
    const decision = await this.approvals.approve(client, {
      documentType: ApprovalDocumentType.VOID_REFUND,
      documentId: voidId,
      currentState: row.status,
      actorUserId,
      actorRole,
    });

    const fullyApproved = decision.approvalState === 'approved';
    const nextStatus: VoidRefundStatus = fullyApproved
      ? VoidRefundStatus.APPROVED
      : VoidRefundStatus.PENDING;

    // `fullyApproved` decides `approved_at` in JS, not a repeated `$2` inside a SQL `CASE` — reusing
    // one placeholder in both a plain assignment and a comparison made `pg` infer inconsistent
    // wire types for it (`42P08`, text vs varchar) once a real value (not a hand-typed literal)
    // flowed through.
    await client.query(
      `UPDATE void_refunds SET status = $2, approved_by = $3, approved_at = CASE WHEN $4 THEN NOW() ELSE approved_at END
        WHERE id = $1`,
      [voidId, nextStatus, actorUserId, fullyApproved],
    );

    if (fullyApproved) {
      await this.executeReversal(client, row, sale, actorUserId);
      await this.syncEmit.emit(client, {
        entity: 'void_refunds',
        op: 'approved',
        entityId: voidId,
        locationId: sale.location_id,
        actorUserId,
        data: {},
      });
    }

    return { id: voidId, status: nextStatus, offlineAuthorized: false };
  }

  async reject(
    client: PoolClient,
    voidId: UUID,
    actorUserId: UUID,
    actorRole: RoleKey,
    reason: string,
  ): Promise<{ id: UUID; status: 'rejected' }> {
    const row = await this.loadVoidRefund(client, voidId);
    if (row.status !== 'pending') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Void/refund ${voidId} is already ${row.status}`,
      });
    }
    const sale = await this.loadSaleForVoid(client, row.sale_id);

    await this.approvals.reject(client, {
      documentType: ApprovalDocumentType.VOID_REFUND,
      documentId: voidId,
      currentState: row.status,
      actorUserId,
      actorRole,
      reason,
    });

    await client.query(
      `UPDATE void_refunds SET status = 'rejected', rejection_reason = $2 WHERE id = $1`,
      [voidId, reason],
    );

    await this.syncEmit.emit(client, {
      entity: 'void_refunds',
      op: 'rejected',
      entityId: voidId,
      locationId: sale.location_id,
      actorUserId,
      data: { reason },
    });

    return { id: voidId, status: 'rejected' };
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: UUID;
      status?: VoidRefundStatus;
      date?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<VoidRefundRow>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND s.location_id = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      where += ` AND vr.status = $${params.length}`;
    }
    if (query.date) {
      params.push(query.date);
      where += ` AND (vr.occurred_at AT TIME ZONE 'Asia/Makassar')::date = $${params.length}::date`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM void_refunds vr JOIN sales s ON s.id = vr.sale_id WHERE ${where}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const offset = (query.page - 1) * query.pageSize;
    params.push(query.pageSize, offset);
    // No `JOIN users` for the requester/approver names — see `notify-eligible-users.util.ts`'s
    // header: under a non-central caller's own RLS, `JOIN users ru` would silently drop a row
    // whenever the caller isn't the requester (a Supervisor listing void/refunds would see fewer
    // than actually exist).
    const res = await client.query<{
      id: UUID;
      sale_id: UUID;
      receipt_number: string;
      type: VoidRefundType;
      amount: Money;
      reason: string;
      status: VoidRefundStatus;
      requested_by: UUID;
      approved_by: UUID | null;
      offline_authorized: boolean;
      reverification_status: ReverificationStatus | null;
    }>(
      `SELECT vr.id, vr.sale_id, s.receipt_number, vr.type, vr.amount, vr.reason, vr.status,
              vr.requested_by, vr.approved_by,
              vr.offline_authorized, vr.reverification_status
         FROM void_refunds vr
         JOIN sales s ON s.id = vr.sale_id
        WHERE ${where}
        ORDER BY vr.occurred_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const names = await resolveUserNames(this.pool, [
      ...res.rows.map((r) => r.requested_by),
      ...res.rows.map((r) => r.approved_by),
    ]);
    const rows: VoidRefundRow[] = res.rows.map((r) => ({
      id: r.id,
      saleId: r.sale_id,
      receiptNumber: r.receipt_number,
      type: r.type,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      requestedBy: names.get(r.requested_by) ?? r.requested_by,
      approvedBy: r.approved_by ? (names.get(r.approved_by) ?? r.approved_by) : null,
      offlineAuthorized: r.offline_authorized,
      reverificationStatus: r.reverification_status,
    }));

    return { rows, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * `PosSyncProjector`'s `void_refunds.approved_offline` handler (D-17: PROVISIONAL only — the
   * `OfflineAuthService` re-verification outcome is computed AFTER this runs in
   * `runApplyHooks`'s call order, so this can only ever record the provisional grant, never a
   * final one). `isConflictLoser` (C3, SYNC-PROTOCOL §5.2/§5.3: an online decision always beats an
   * offline-provisional one) skips the flip entirely — the losing offline decision must not also
   * apply its effect. Idempotent: a non-`pending` row (already decided, by this call or a sibling)
   * is a safe no-op.
   */
  async applyVoidApprovedOffline(
    client: PoolClient,
    saleId: UUID,
    approverUserId: UUID,
    occurredAt: string,
    isConflictLoser: boolean,
  ): Promise<void> {
    if (isConflictLoser) return;
    const row = await client.query<{ id: UUID; status: string }>(
      `SELECT id, status FROM void_refunds WHERE sale_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [saleId],
    );
    if (!row.rows[0])
      throw new Error(
        `void_refunds.approved_offline: no void_refunds row for sale ${saleId} (its 'requested' sibling has not projected)`,
      );
    if (row.rows[0].status !== 'pending') return;

    await client.query(
      `UPDATE void_refunds SET status = 'approved', approved_by = $2, approved_at = $3, offline_authorized = true WHERE id = $1`,
      [row.rows[0].id, approverUserId, occurredAt],
    );
  }

  /**
   * The physical reversal fact (`void_refunds.executed`) — always applied once a void is
   * `approved`, regardless of which path (online `approve()` above, or the offline-provisional
   * path via `applyVoidApprovedOffline`) got it there. Idempotent: a sale that is no longer
   * `completed` has already been reversed (by this call or a replay) — safe no-op.
   */
  async applyVoidExecuted(client: PoolClient, saleId: UUID, actorUserId: UUID): Promise<void> {
    const voidRes = await client.query<{
      id: UUID;
      sale_id: UUID;
      type: VoidRefundType;
      amount: Money;
      status: VoidRefundStatus;
    }>(
      `SELECT id, sale_id, type, amount, status FROM void_refunds WHERE sale_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [saleId],
    );
    const voidRow = voidRes.rows[0];
    if (!voidRow) throw new Error(`void_refunds.executed: no void_refunds row for sale ${saleId}`);
    if (voidRow.status !== 'approved') return;

    const sale = await this.loadSaleForVoid(client, saleId);
    if (sale.status !== 'completed') return;

    await this.executeReversal(client, voidRow, sale, actorUserId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Reverses the sale's payments/status and the recipe usage it drove — CONTRACTS.md §1.6 comment on `void_refunds`. */
  private async executeReversal(
    client: PoolClient,
    voidRow: { sale_id: UUID; type: VoidRefundType; amount: Money },
    sale: SaleForVoid,
    actorId: UUID,
  ): Promise<void> {
    const newSaleStatus: SaleStatus =
      voidRow.type === 'void' ? SaleStatus.VOIDED : SaleStatus.REFUNDED;
    await client.query(`UPDATE sales SET status = $2 WHERE id = $1`, [
      voidRow.sale_id,
      newSaleStatus,
    ]);

    const lines = await client.query<{ product_id: UUID; qty: string }>(
      `SELECT product_id, qty FROM sale_lines WHERE sale_id = $1`,
      [voidRow.sale_id],
    );
    const areaId = await findKitchenLineAreaId(client, sale.location_id);
    if (areaId && lines.rows.length > 0) {
      const { usages } = await explodeRecipeUsage(
        client,
        lines.rows.map((l) => ({ productId: l.product_id, qty: l.qty })),
      );
      if (usages.length > 0) {
        const movements: PostMovementInput[] = usages.map((u) => ({
          locationId: sale.location_id,
          storageAreaId: areaId,
          itemId: u.itemId,
          movementType: MovementType.RETURN_IN,
          qty: u.qty,
          unitCost: u.unitCost,
          refType: 'void_refund',
          refId: voidRow.sale_id,
          actorId,
        }));
        // Reversal always applies (D-17a spirit) — a void reflects a real chicken NOT actually
        // consumed after all; 'strict' negative-balance rejection makes no sense for a return.
        await this.stockLedger.post(client, movements, 'fact');
      }
    }

    await this.eventBus.publish('journal.action', {
      eventType: JournalSystemEventType.SALE_VOID_REVERSAL,
      documentType: 'void_refund',
      documentId: voidRow.sale_id,
      locationId: sale.location_id,
      amount: voidRow.amount,
      context: { saleId: voidRow.sale_id, type: voidRow.type },
      occurredAt: new Date().toISOString(),
    });
  }

  private async verifyPin(client: PoolClient, actorUserId: UUID, pin: string): Promise<void> {
    const res = await client.query<{ pin_hash: string | null }>(
      `SELECT pin_hash FROM users WHERE id = $1`,
      [actorUserId],
    );
    const hash = res.rows[0]?.pin_hash;
    if (!hash) {
      throw new ForbiddenException({
        code: ERR_AUTH_PIN_INVALID,
        message: 'This user has no PIN configured',
      });
    }
    const ok = await bcrypt.compare(pin, hash);
    if (!ok) {
      throw new ForbiddenException({ code: ERR_AUTH_PIN_INVALID, message: 'Invalid PIN' });
    }
  }

  private async loadSaleForVoid(client: PoolClient, saleId: UUID): Promise<SaleForVoid> {
    const res = await client.query<SaleForVoid>(
      `SELECT id, location_id, shift_id, status, total FROM sales WHERE id = $1`,
      [saleId],
    );
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Sale not found' });
    return res.rows[0];
  }

  private async loadVoidRefund(
    client: PoolClient,
    id: UUID,
  ): Promise<{
    id: UUID;
    sale_id: UUID;
    type: VoidRefundType;
    amount: Money;
    status: VoidRefundStatus;
  }> {
    const res = await client.query<{
      id: UUID;
      sale_id: UUID;
      type: VoidRefundType;
      amount: Money;
      status: VoidRefundStatus;
    }>(`SELECT id, sale_id, type, amount, status FROM void_refunds WHERE id = $1 FOR UPDATE`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Void/refund not found' });
    return res.rows[0];
  }
}
