import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import {
  addMoney,
  compareMoney,
  DEFAULT_CASH_VARIANCE_PROPOSE_ABOVE,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  OnlinePlatform,
  PaymentMethod,
  subMoney,
  ZERO_MONEY,
  type Money,
  type Paginated,
  type Shift,
  type ShiftStatus,
  type UUID,
} from '@mimi/shared';
import { ApprovalDocumentType } from '@mimi/shared';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { allocateShiftNumber } from '../doc-numbering.util';
import { findUsersByRoleAtLocation, resolveUserNames } from '../notify-eligible-users.util';
import { mapShift, type ShiftRow } from './pos-mappers';

export interface OpenShiftInput {
  clientId: UUID;
  locationId: UUID;
  deviceId?: UUID;
  openingCash: Money;
  openedAt?: string;
}

/** The shared apply core's input — `id`/`shiftNumber` explicit only from `PosSyncProjector` (`event.entityId`, the device's own printed number); the REST path leaves both `undefined` and lets `applyShiftOpened` mint them. */
export interface ApplyShiftOpenedInput extends OpenShiftInput {
  id?: UUID;
  openedByUserId: UUID;
  shiftNumber?: string;
}

export interface CloseShiftInput {
  closingCashCounted: Money;
  notes?: string;
  closedAt?: string;
}

export interface ShiftReport {
  byMethod: { method: PaymentMethod; amount: Money; count: number }[];
  voids: number;
  voidAmount: Money;
  onlineOrders: { platform: OnlinePlatform; count: number; net: Money }[];
  cashVarianceProposalId: UUID | null;
}

// Deliberately no `JOIN users` for `opened_by`'s name — see `notify-eligible-users.util.ts`'s
// header (`resolveUserNames`): under a non-central caller's own RLS, an INNER JOIN against a
// `users` row that isn't the caller's own would silently DROP THE WHOLE SHIFT ROW, not just null
// the name (a Supervisor listing an outlet's shifts would see fewer rows than actually exist,
// whenever they didn't open a given shift themselves — caught by this module's own test suite).
const SHIFT_SELECT = `
  SELECT s.id, s.shift_number, s.location_id, s.device_id, s.opened_by,
         s.opened_at, s.opening_cash, s.status, s.closed_at, s.closing_cash_counted,
         s.expected_cash, s.cash_variance, s.sales_count, s.gross_sales
    FROM pos_shifts s
`;

interface RawShiftRow extends Omit<ShiftRow, 'opened_by_name'> {
  opened_by: UUID;
}

@Injectable()
export class PosShiftService {
  private readonly logger = new Logger(PosShiftService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
  ) {}

  async getCurrent(client: PoolClient, locationId?: UUID, deviceId?: UUID): Promise<Shift | null> {
    const params: unknown[] = ['open'];
    let where = 's.status = $1';
    if (locationId) {
      params.push(locationId);
      where += ` AND s.location_id = $${params.length}`;
    }
    if (deviceId) {
      params.push(deviceId);
      where += ` AND s.device_id = $${params.length}`;
    }
    const res = await client.query<RawShiftRow>(
      `${SHIFT_SELECT} WHERE ${where} ORDER BY s.opened_at DESC LIMIT 1`,
      params,
    );
    if (!res.rows[0]) return null;
    return (await this.hydrateShifts([res.rows[0]]))[0]!;
  }

  async open(client: PoolClient, openedByUserId: UUID, input: OpenShiftInput): Promise<Shift> {
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM pos_shifts WHERE client_id = $1`,
      [input.clientId],
    );
    if (existing.rows[0]) return this.mustGetById(client, existing.rows[0].id);

    // Interactive-only: a laptop-style single-kasir workflow refuses a second concurrent shift for
    // the same location/device. Deliberately NOT enforced in `applyShiftOpened` (the shared core the
    // projector also calls) — SYNC-PROTOCOL's own model is "a shift belongs to (device, cashier);
    // two tablets cannot open 'the same' shift, so no cross-device conflict exists by construction"
    // — a LAN-node outlet legitimately runs several concurrent open shifts, one per tablet.
    const openAlready = await client.query<{ id: UUID }>(
      `SELECT id FROM pos_shifts WHERE location_id = $1 AND status = 'open' ${input.deviceId ? 'AND device_id = $2' : ''} LIMIT 1`,
      input.deviceId ? [input.locationId, input.deviceId] : [input.locationId],
    );
    if (openAlready.rows[0]) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: 'A shift is already open for this location/device',
      });
    }

    return this.applyShiftOpened(client, { ...input, openedByUserId });
  }

  /**
   * The shared apply core `PosSyncProjector` calls too (coordinator feedback: an offline-synced
   * fact and an online one must produce identical rows). Idempotent on `id` (projector) or
   * `client_id` (either path) — dedupes below `SyncProjectorRegistry`'s own event-id guarantee.
   */
  async applyShiftOpened(client: PoolClient, input: ApplyShiftOpenedInput): Promise<Shift> {
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM pos_shifts WHERE client_id = $1 ${input.id ? 'OR id = $2' : ''}`,
      input.id ? [input.clientId, input.id] : [input.clientId],
    );
    if (existing.rows[0]) return this.mustGetById(client, existing.rows[0].id);

    const shiftId = input.id ?? randomUUID();
    const insertOne = async (shiftNumber: string): Promise<void> => {
      await client.query(
        `INSERT INTO pos_shifts (id, shift_number, location_id, device_id, opened_by, opened_at, opening_cash, client_id)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW()),$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          shiftId,
          shiftNumber,
          input.locationId,
          input.deviceId ?? null,
          input.openedByUserId,
          input.openedAt ?? null,
          input.openingCash,
          input.clientId,
        ],
      );
    };

    if (input.shiftNumber) {
      await insertOne(input.shiftNumber);
    } else {
      const location = await client.query<{ code: string }>(
        `SELECT code FROM locations WHERE id = $1`,
        [input.locationId],
      );
      if (!location.rows[0])
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Location not found' });
      const deviceCode = await this.resolveDeviceCode(client, input.deviceId);
      await allocateShiftNumber(client, location.rows[0].code, deviceCode, insertOne);
    }

    return this.mustGetById(client, shiftId);
  }

  /**
   * The shared apply core for `pos_shifts.closed` too — no REST-only checks exist here beyond what
   * a projector also needs (a shift must exist and not already be closed), so this method serves
   * BOTH paths directly with no wrapper. Idempotent: an already-closed shift returns its current
   * state + report rather than throwing, so a projector replaying the same fact (or a REST retry)
   * is a safe no-op, not a spurious error.
   */
  async close(
    client: PoolClient,
    shiftId: UUID,
    closedByUserId: UUID,
    input: CloseShiftInput,
  ): Promise<{ shift: Shift; report: ShiftReport }> {
    const shiftRes = await client.query<{
      id: UUID;
      location_id: UUID;
      status: ShiftStatus;
      opening_cash: Money;
    }>(`SELECT id, location_id, status, opening_cash FROM pos_shifts WHERE id = $1 FOR UPDATE`, [
      shiftId,
    ]);
    const shift = shiftRes.rows[0];
    if (!shift) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Shift not found' });
    if (shift.status !== 'open') {
      const cvp = await client.query<{ id: UUID }>(
        `SELECT id FROM cash_variance_proposals WHERE shift_id = $1`,
        [shiftId],
      );
      return {
        shift: await this.mustGetById(client, shiftId),
        report: await this.buildReport(client, shiftId, cvp.rows[0]?.id ?? null),
      };
    }

    // R7-equivalent recompute (SYNC-PROTOCOL §5.5 R7), read from the REAL domain tables this
    // module owns — never trust a client-declared total. kernel/sync's own R7
    // (`ReconciliationService.runR7ForClosedShift`) ALSO runs, unconditionally, right after this
    // projector call in `runApplyHooks` — it reads `sync_events.payload` instead and creates the
    // `cash_variance_proposals` row independently; this method never touches that table on the
    // sync path either, to avoid two different formulas racing to decide the same shortfall (see
    // `PosSyncProjector`'s header for the pre-existing discrepancy this surfaces, flagged in the
    // module report rather than patched here).
    const cashSalesRes = await client.query<{ total: Money }>(
      `SELECT COALESCE(SUM(sp.amount), '0.00') AS total
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
        WHERE s.shift_id = $1 AND sp.method = 'cash'`,
      [shiftId],
    );
    const cashRefundsRes = await client.query<{ total: Money }>(
      `SELECT COALESCE(SUM(vr.amount), '0.00') AS total
         FROM void_refunds vr
         JOIN sales s ON s.id = vr.sale_id
        WHERE s.shift_id = $1 AND vr.status = 'approved'
          AND EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = 'cash')`,
      [shiftId],
    );

    const expectedCash = subMoney(
      addMoney(shift.opening_cash, cashSalesRes.rows[0]!.total),
      cashRefundsRes.rows[0]!.total,
    );
    const cashVariance = subMoney(input.closingCashCounted, expectedCash);

    await client.query(
      `UPDATE pos_shifts
          SET status = 'closed', closed_by = $2, closed_at = COALESCE($3, NOW()),
              closing_cash_counted = $4, expected_cash = $5, cash_variance = $6, notes = $7
        WHERE id = $1`,
      [
        shiftId,
        closedByUserId,
        input.closedAt ?? null,
        input.closingCashCounted,
        expectedCash,
        cashVariance,
        input.notes ?? null,
      ],
    );

    let cashVarianceProposalId: UUID | null = null;
    if (compareMoney(cashVariance, ZERO_MONEY) < 0) {
      // Shortfall (D-19): auto-propose, never auto-deduct. An overage (cashVariance > 0) is
      // deliberately NOT a proposal (§5.9: "a surplus drawer is not a debt") — it stays visible
      // only via the shift's own `cashVariance` field on the report below.
      const shortfall = subMoney(expectedCash, input.closingCashCounted);
      const threshold = DEFAULT_CASH_VARIANCE_PROPOSE_ABOVE; // settings['pos.cash_variance_propose_above'] — read via M20 once that surface exists; this is its documented default (0.00 = always propose).
      if (compareMoney(shortfall, threshold) > 0 || compareMoney(threshold, ZERO_MONEY) === 0) {
        cashVarianceProposalId = await this.createCashVarianceProposal(
          client,
          shiftId,
          shift.location_id,
          closedByUserId,
          shortfall,
        );
      }
    }

    const report = await this.buildReport(client, shiftId, cashVarianceProposalId);
    return { shift: await this.mustGetById(client, shiftId), report };
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: UUID;
      date?: string;
      status?: ShiftStatus;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<Shift>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND s.location_id = $${params.length}`;
    }
    if (query.date) {
      params.push(query.date);
      where += ` AND (s.opened_at AT TIME ZONE 'Asia/Makassar')::date = $${params.length}::date`;
    }
    if (query.status) {
      params.push(query.status);
      where += ` AND s.status = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM pos_shifts s WHERE ${where}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const offset = (query.page - 1) * query.pageSize;
    params.push(query.pageSize, offset);
    const res = await client.query<RawShiftRow>(
      `${SHIFT_SELECT} WHERE ${where} ORDER BY s.opened_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: await this.hydrateShifts(res.rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getReport(client: PoolClient, shiftId: UUID): Promise<ShiftReport> {
    await this.mustGetById(client, shiftId);
    const cvp = await client.query<{ id: UUID }>(
      `SELECT id FROM cash_variance_proposals WHERE shift_id = $1`,
      [shiftId],
    );
    return this.buildReport(client, shiftId, cvp.rows[0]?.id ?? null);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async buildReport(
    client: PoolClient,
    shiftId: UUID,
    cashVarianceProposalId: UUID | null,
  ): Promise<ShiftReport> {
    const byMethodRes = await client.query<{ method: PaymentMethod; amount: Money; count: string }>(
      `SELECT sp.method, COALESCE(SUM(sp.amount), '0.00') AS amount, COUNT(*)::int AS count
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
        WHERE s.shift_id = $1 AND s.status = 'completed'
        GROUP BY sp.method`,
      [shiftId],
    );

    const voidsRes = await client.query<{ count: string; amount: Money }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(vr.amount), '0.00') AS amount
         FROM void_refunds vr
         JOIN sales s ON s.id = vr.sale_id
        WHERE s.shift_id = $1 AND vr.status = 'approved'`,
      [shiftId],
    );

    // Migration 249 retired `online_orders` as a write path — GoFood/ShopeeFood
    // orders rung up after that cutover are ordinary `sales` rows with
    // `channel` set (never written to `online_orders` again), so this UNIONs
    // both sources rather than reading `online_orders` alone. Without this, a
    // shift closed after the cutover would report an empty `onlineOrders` box
    // even when it genuinely rang up GoFood/ShopeeFood sales — the exact
    // silent-flatline bug migration 251 exists to fix (see that migration's
    // header for the matview half of the same bug). The two sources cannot
    // double-count: a GoFood order lives in `online_orders` (pre-cutover) OR
    // as a `sales.channel` row (post-cutover), never both — 249 retired the
    // write path, it did not leave both paths live.
    const onlineRes = await client.query<{ platform: OnlinePlatform; count: string; net: Money }>(
      `SELECT platform, COUNT(*)::int AS count, COALESCE(SUM(net), '0.00') AS net
         FROM (
           SELECT channel AS platform, total AS net
             FROM sales
            WHERE shift_id = $1 AND status = 'completed' AND channel <> 'walk_in'
           UNION ALL
           SELECT platform, net_received AS net
             FROM online_orders
            WHERE shift_id = $1 AND status = 'completed'
         ) x
        GROUP BY platform`,
      [shiftId],
    );

    return {
      byMethod: byMethodRes.rows.map((r) => ({
        method: r.method,
        amount: r.amount,
        count: Number(r.count),
      })),
      voids: Number(voidsRes.rows[0]?.count ?? 0),
      voidAmount: voidsRes.rows[0]?.amount ?? ZERO_MONEY,
      onlineOrders: onlineRes.rows.map((r) => ({
        platform: r.platform,
        count: Number(r.count),
        net: r.net,
      })),
      cashVarianceProposalId,
    };
  }

  private async createCashVarianceProposal(
    client: PoolClient,
    shiftId: UUID,
    locationId: UUID,
    kasirUserId: UUID,
    amount: Money,
  ): Promise<UUID> {
    const inserted = await client.query<{ id: UUID }>(
      `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, amount, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
      [shiftId, locationId, kasirUserId, amount],
    );
    const proposalId = inserted.rows[0]!.id;

    const submission = await this.approvals.submit(client, {
      documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
      documentId: proposalId,
      requestedBy: kasirUserId,
      amount,
      locationId,
    });
    await client.query(`UPDATE cash_variance_proposals SET approval_id = $2 WHERE id = $1`, [
      proposalId,
      submission.approvalId,
    ]);

    // `users`/`user_locations` RLS (migration 009) is `app_is_central() OR app_is_self(...)` — the
    // closing Kasir's own RLS context cannot see a supervisor's row on `client`. See
    // `notify-eligible-users.util.ts`'s header for why this needs its own connection.
    const supervisorIds = await findUsersByRoleAtLocation(this.pool, ['supervisor'], locationId);
    if (supervisorIds.length > 0) {
      const shiftRow = await client.query<{ shift_number: string; location_name: string }>(
        `SELECT s.shift_number, l.name AS location_name FROM pos_shifts s JOIN locations l ON l.id = s.location_id WHERE s.id = $1`,
        [shiftId],
      );
      // A notification failure must never roll back a real cash-variance proposal that already
      // exists — same "log and swallow" stance `kernel/audit`'s interceptor takes for its own
      // best-effort write. See the module report: `NotificationService.notify()` queries `users`
      // on its OWN injected `DATABASE_POOL` connection, never on `client` — that connection has no
      // `SET ROLE app_user` of its own, so it fails under D-22's `mimi_app` grants regardless of
      // caller; this is a `kernel/notification` gap, not something to paper over by widening a
      // policy or routing this call through `client`.
      try {
        await this.notifications.notify({
          templateKey: 'approval_pending',
          userIds: supervisorIds,
          params: {
            documentType: 'cash_variance_proposal',
            documentNumber: shiftRow.rows[0]?.shift_number ?? shiftId,
            locationName: shiftRow.rows[0]?.location_name ?? '',
          },
          locationId,
        });
      } catch (err) {
        this.logger.error(
          `Failed to notify supervisors of cash-variance proposal ${proposalId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return proposalId;
  }

  private async resolveDeviceCode(client: PoolClient, deviceId: UUID | undefined): Promise<string> {
    if (!deviceId) return 'WEB';
    const res = await client.query<{ name: string }>(`SELECT name FROM devices WHERE id = $1`, [
      deviceId,
    ]);
    const name = res.rows[0]?.name;
    if (!name) return 'WEB';
    const sanitized = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10);
    return sanitized || 'WEB';
  }

  private async mustGetById(client: PoolClient, id: UUID): Promise<Shift> {
    const res = await client.query<RawShiftRow>(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Shift not found' });
    return (await this.hydrateShifts([res.rows[0]]))[0]!;
  }

  /** Batch-resolves `opened_by_name` via the central-context helper (`resolveUserNames`) — see `SHIFT_SELECT`'s comment for why this can't be a plain `JOIN users` under the caller's own RLS. */
  private async hydrateShifts(rows: readonly RawShiftRow[]): Promise<Shift[]> {
    const names = await resolveUserNames(
      this.pool,
      rows.map((r) => r.opened_by),
    );
    return rows.map((r) =>
      mapShift({ ...r, opened_by_name: names.get(r.opened_by) ?? r.opened_by }),
    );
  }
}
