import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import {
  calculateCartSummary,
  calculateChange,
  compareMoney,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  MovementType,
  PayeeType,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationRefType,
  sumMoney,
  ZERO_MONEY,
  type Money,
  type Paginated,
  type Sale,
  type SaleStatus,
  type UUID,
} from '@mimi/shared';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import {
  StockInsufficientError,
  type PostMovementInput,
} from '../../../kernel/stock-ledger/stock-ledger.types';
import type { LedgerMode } from '@mimi/sync-protocol';
import { PaymentVerificationsService } from '../../accounting/payment-verifications.service';
import { allocateReceiptNumber } from '../doc-numbering.util';
import { explodeRecipeUsage, findKitchenLineAreaId } from '../recipe-usage.util';
import { resolveUserNames } from '../notify-eligible-users.util';
import { mapSale, type SaleLineRow, type SalePaymentRow, type SaleRow } from './pos-mappers';

export interface SaleLineInput {
  productId: UUID;
  qty: string;
  unitPrice: Money;
  discount?: Money;
}

export interface SalePaymentInput {
  method: PaymentMethod;
  amount: Money;
  reference?: string;
  proofAttachmentId?: UUID;
}

export interface CreateSaleInput {
  clientId: UUID;
  shiftId: UUID;
  locationId: UUID;
  occurredAt: string;
  lines: SaleLineInput[];
  payments: SalePaymentInput[];
  discount?: Money;
}

/**
 * The shared apply core `PosSyncProjector` calls too (coordinator feedback:
 * "an offline-synced fact and an online one must produce identical rows,
 * not a parallel implementation that happens to agree today"). `id` and
 * `receiptNumber` are the two fields ONLY the sync path supplies explicitly
 * (`event.entityId` — SYNC-PROTOCOL §2.1's "the sale id" — and the device's
 * own printed receipt number, CONTRACTS §1.5); the REST path leaves both
 * `undefined` and lets this method mint them (a fresh `gen_random_uuid()`
 * default, a freshly-allocated device-local-shaped number).
 */
export interface ApplySaleFactInput {
  id?: UUID;
  clientId: UUID;
  kasirId: UUID;
  shiftId: UUID;
  locationId: UUID;
  occurredAt: string;
  lines: SaleLineInput[];
  payments: SalePaymentInput[];
  discount?: Money;
  receiptNumber?: string;
  /**
   * The ACTING session's own role/location scope — needed only to restore it after the one
   * escalated `payment_verifications` INSERT a `bank_transfer` payment triggers (FR-ACCT-03; see
   * `PaymentVerificationsService.createSystemVerification`'s doc comment). The sync projector,
   * whose connection is already running under `kernel/sync`'s own system/central context
   * (`SyncEventsRepository.withTransaction`), passes `{roleKey: 'owner', locationIds: []}` — the
   * escalation is then a same-role no-op restore, which is correct, not a workaround.
   */
  callerContext: { roleKey: string; locationIds: readonly UUID[] };
}

// No `JOIN users` for `kasir_name` — see `notify-eligible-users.util.ts`'s header: under a
// non-central caller's own RLS, that INNER JOIN would silently drop a sale from the result
// whenever the caller isn't the sale's own kasir (e.g. a Supervisor listing the outlet's sales).
const SALE_SELECT = `
  SELECT s.id, s.receipt_number, s.location_id, s.shift_id, s.kasir_id, s.status,
         s.subtotal, s.discount, s.total, s.paid_amount, s.change_amount, s.offline_created, s.occurred_at
    FROM sales s
`;

interface RawSaleRow extends Omit<SaleRow, 'kasir_name'> {
  kasir_id: UUID;
}

/** The payment-status ladder (FR-ACCT-03) — the ONE place either path computes it, from `method` alone, never a wire field (there isn't one). Exported only because `ApplySaleFactInput`'s caller-visible contract already routes both paths through `applySaleFact` below; kept as a free function (not inlined) so a future direct unit test can pin the ladder down without standing up the whole service. */
export function paymentStatusForMethod(method: PaymentMethod): PaymentStatus {
  switch (method) {
    case PaymentMethod.CASH:
      return PaymentStatus.PAID;
    case PaymentMethod.QRIS:
      return PaymentStatus.VERIFIED;
    case PaymentMethod.BANK_TRANSFER:
      return PaymentStatus.PENDING;
  }
}

/**
 * `PosSaleService` — FR-POS-01/04/06.
 *
 * `create()` (the interactive REST path) does REST-specific validation
 * (shift must be open, `locationId` must match the shift, at least one
 * line, payment must cover the total) and then calls `applySaleFact()` —
 * the ONE place that writes `sales`/`sale_lines`/`sale_payments` and posts
 * recipe-explosion usage. `PosSyncProjector.projectSaleCompleted` calls
 * `applySaleFact()` directly, skipping those interactive-only checks (a
 * replayed offline fact is the chicken having really been sold — D-17a —
 * not something to re-litigate), with `mode: 'fact'` instead of `'strict'`.
 */
@Injectable()
export class PosSaleService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly stockLedger: StockLedgerService,
    private readonly paymentVerifications: PaymentVerificationsService,
  ) {}

  async create(
    client: PoolClient,
    kasirId: UUID,
    input: CreateSaleInput,
    callerContext: { roleKey: string; locationIds: readonly UUID[] },
    mode: LedgerMode = 'strict',
  ): Promise<Sale> {
    const shiftRes = await client.query<{ id: UUID; location_id: UUID; status: string }>(
      `SELECT id, location_id, status FROM pos_shifts WHERE id = $1 FOR UPDATE`,
      [input.shiftId],
    );
    const shift = shiftRes.rows[0];
    if (!shift) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Shift not found' });
    if (shift.status !== 'open') {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'Shift is not open' });
    }
    if (shift.location_id !== input.locationId) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: "locationId does not match the shift's location",
      });
    }
    if (input.lines.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'A sale must have at least one line',
      });
    }
    const paidAmount = sumMoney(input.payments.map((p) => p.amount));
    const provisionalTotal = calculateCartSummary(
      input.lines.map((l) => ({
        productId: l.productId,
        unitPrice: l.unitPrice,
        qty: l.qty,
        discount: l.discount ?? ZERO_MONEY,
      })),
      input.discount ?? ZERO_MONEY,
    ).total;
    if (compareMoney(paidAmount, provisionalTotal) < 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Paid amount ${paidAmount} is less than sale total ${provisionalTotal}`,
      });
    }

    return this.applySaleFact(client, { ...input, kasirId, callerContext }, mode);
  }

  /**
   * The shared apply core (see file header). Idempotent on `id` (when the
   * caller supplies one — the projector always does) OR `client_id`
   * (either path) — dedupes BELOW `SyncProjectorRegistry`'s own event-id
   * guarantee, so a re-projection sweep (same fact, different internal
   * retry path) can never double-insert, and so the REST and sync paths
   * can never both materialize the same client action.
   */
  async applySaleFact(
    client: PoolClient,
    input: ApplySaleFactInput,
    mode: LedgerMode,
  ): Promise<Sale> {
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM sales WHERE client_id = $1 ${input.id ? 'OR id = $2' : ''}`,
      input.id ? [input.clientId, input.id] : [input.clientId],
    );
    if (existing.rows[0]) return this.mustGetById(client, existing.rows[0].id);

    const summary = calculateCartSummary(
      input.lines.map((l) => ({
        productId: l.productId,
        unitPrice: l.unitPrice,
        qty: l.qty,
        discount: l.discount ?? ZERO_MONEY,
      })),
      input.discount ?? ZERO_MONEY,
    );
    const paidAmount = sumMoney(input.payments.map((p) => p.amount));
    const changeAmount = calculateChange(paidAmount, summary.total);

    // `id` is ALWAYS explicit (never a DB `DEFAULT`) so both paths run the exact same INSERT shape —
    // the projector supplies `event.entityId`; the REST path mints a fresh one right here.
    const saleId = input.id ?? randomUUID();

    const insertOne = async (receiptNumber: string) => {
      const inserted = await client.query<{ id: UUID }>(
        `INSERT INTO sales (id, receipt_number, client_id, location_id, shift_id, kasir_id, status, subtotal, discount, total, paid_amount, change_amount, offline_created, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          saleId,
          receiptNumber,
          input.clientId,
          input.locationId,
          input.shiftId,
          input.kasirId,
          summary.subtotal,
          summary.discount,
          summary.total,
          paidAmount,
          changeAmount,
          !!input.id,
          input.occurredAt,
        ],
      );
      return !!inserted.rows[0];
    };

    let inserted: boolean;
    if (input.receiptNumber) {
      inserted = await insertOne(input.receiptNumber);
    } else {
      // No device-assigned receipt number (REST path, or a sync payload that omitted it — see the
      // registry's field comment) — allocate our own, retrying on a collision.
      const { locationCode, deviceCode } = await this.resolveNumberingCodes(
        client,
        input.locationId,
        input.shiftId,
      );
      inserted = false;
      await allocateReceiptNumber(client, locationCode, deviceCode, async (num) => {
        inserted = await insertOne(num);
      });
    }
    if (!inserted) {
      // `ON CONFLICT (id) DO NOTHING` matched an existing row — a race with another concurrent
      // apply of the SAME fact (the `existing` check above missed it by a hair). Idempotent no-op.
      return this.mustGetById(client, saleId);
    }

    for (const [i, line] of summary.lines.entries()) {
      await client.query(
        `INSERT INTO sale_lines (sale_id, product_id, qty, unit_price, discount, line_total, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, line.productId, line.qty, line.unitPrice, line.discount, line.lineTotal, i],
      );
    }

    for (const payment of input.payments) {
      // FR-ACCT-03's ladder, computed from `method` ALONE, identically on both paths.
      const paymentRow = await client.query<{ id: UUID }>(
        `INSERT INTO sale_payments (sale_id, method, amount, reference, payment_status, proof_attachment_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          saleId,
          payment.method,
          payment.amount,
          payment.reference ?? null,
          paymentStatusForMethod(payment.method),
          payment.proofAttachmentId ?? null,
        ],
      );

      if (payment.method === PaymentMethod.BANK_TRANSFER) {
        // FR-ACCT-03's other half: a transfer never marks itself paid, but Finance's queue must
        // still learn there is something to verify. `createSystemVerification` escalates ONLY
        // around this one INSERT (migration 095's `payment_verifications_role` RLS is central-role
        // only) and restores `input.callerContext` immediately after — see that method's own doc
        // comment. Fire-and-forget the returned id: reading the row back needs the SAME escalation
        // (that method's own caveat), and this module has no read path for it — Finance's own
        // `payment.read`-gated surface is where it gets seen.
        await this.paymentVerifications.createSystemVerification(
          client,
          {
            role: input.callerContext.roleKey,
            userId: input.kasirId,
            locationIds: input.callerContext.locationIds,
          },
          {
            refType: PaymentVerificationRefType.SALE_PAYMENT,
            refId: paymentRow.rows[0]!.id,
            payeeType: PayeeType.OTHER,
            payeeId: null,
            amount: payment.amount,
            locationId: input.locationId,
            submittedBy: input.kasirId,
          },
        );
      }
    }

    await client.query(
      `UPDATE pos_shifts SET sales_count = sales_count + 1, gross_sales = gross_sales + $2 WHERE id = $1`,
      [input.shiftId, summary.total],
    );

    await this.postUsage(
      client,
      input.locationId,
      saleId,
      input.kasirId,
      input.occurredAt,
      summary.lines,
      mode,
    );

    return this.mustGetById(client, saleId);
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: UUID;
      shiftId?: UUID;
      date?: string;
      status?: SaleStatus;
      page: number;
      pageSize: number;
    },
  ): Promise<Paginated<Sale>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND s.location_id = $${params.length}`;
    }
    if (query.shiftId) {
      params.push(query.shiftId);
      where += ` AND s.shift_id = $${params.length}`;
    }
    if (query.date) {
      params.push(query.date);
      where += ` AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date = $${params.length}::date`;
    }
    if (query.status) {
      params.push(query.status);
      where += ` AND s.status = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM sales s WHERE ${where}`,
      params,
    );
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const offset = (query.page - 1) * query.pageSize;
    params.push(query.pageSize, offset);
    const res = await client.query<RawSaleRow>(
      `${SALE_SELECT} WHERE ${where} ORDER BY s.occurred_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      rows: await this.hydrateRows(client, res.rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getById(client: PoolClient, id: UUID): Promise<Sale> {
    return this.mustGetById(client, id);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async postUsage(
    client: PoolClient,
    locationId: UUID,
    saleId: UUID,
    actorId: UUID,
    occurredAt: string,
    lines: readonly { productId: UUID; qty: string }[],
    mode: LedgerMode,
  ): Promise<void> {
    const areaId = await findKitchenLineAreaId(client, locationId);
    if (!areaId) return; // no kitchen_line area configured at this location — nothing to post against (see recipe-usage.util.ts header)

    const { usages } = await explodeRecipeUsage(client, lines);
    if (usages.length === 0) return;

    const movements: PostMovementInput[] = usages.map((u) => ({
      locationId,
      storageAreaId: areaId,
      itemId: u.itemId,
      movementType: MovementType.USAGE_OUT,
      qty: u.qty,
      unitCost: u.unitCost,
      refType: 'sale',
      refId: saleId,
      actorId,
      occurredAt,
    }));

    if (mode === 'fact') {
      // D-17a, unconditionally: the chicken really was sold; never reject, may go negative + open a
      // `stock_reconciliations` exception instead (StockLedgerService's own C5 handling).
      await this.stockLedger.post(client, movements, 'fact');
      return;
    }

    try {
      await this.stockLedger.post(client, movements, mode);
    } catch (err) {
      if (err instanceof StockInsufficientError) {
        // FR-POS-06's usage explosion is an ESTIMATE feeding reporting, never a sale gate — a
        // recipe pulling more of an ingredient than is on hand must not block a completed sale.
        // The underlying divergence is still visible: re-post in 'fact' mode so the exception is
        // recorded (a `stock_reconciliations` row) rather than silently dropped.
        await this.stockLedger.post(client, movements, 'fact');
      } else {
        throw err;
      }
    }
  }

  private async resolveNumberingCodes(
    client: PoolClient,
    locationId: UUID,
    shiftId: UUID,
  ): Promise<{ locationCode: string; deviceCode: string }> {
    const location = await client.query<{ code: string }>(
      `SELECT code FROM locations WHERE id = $1`,
      [locationId],
    );
    const locationCode = location.rows[0]?.code ?? 'LOC';
    const shift = await client.query<{ device_id: UUID | null }>(
      `SELECT device_id FROM pos_shifts WHERE id = $1`,
      [shiftId],
    );
    const deviceCode = await this.resolveDeviceCode(client, shift.rows[0]?.device_id ?? null);
    return { locationCode, deviceCode };
  }

  private async resolveDeviceCode(client: PoolClient, deviceId: UUID | null): Promise<string> {
    if (!deviceId) return 'WEB';
    const device = await client.query<{ name: string }>(`SELECT name FROM devices WHERE id = $1`, [
      deviceId,
    ]);
    const name = device.rows[0]?.name;
    if (!name) return 'WEB';
    const sanitized = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10);
    return sanitized || 'WEB';
  }

  private async mustGetById(client: PoolClient, id: UUID): Promise<Sale> {
    const res = await client.query<RawSaleRow>(`${SALE_SELECT} WHERE s.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Sale not found' });
    const names = await resolveUserNames(this.pool, [res.rows[0].kasir_id]);
    return this.hydrate(
      client,
      res.rows[0],
      names.get(res.rows[0].kasir_id) ?? res.rows[0].kasir_id,
    );
  }

  /** `notify-eligible-users.util.ts`'s `resolveUserNames` — see `SALE_SELECT`'s comment for why `kasir_name` can't be a plain `JOIN users` under the caller's own RLS. */
  private async hydrateRows(client: PoolClient, rows: readonly RawSaleRow[]): Promise<Sale[]> {
    const names = await resolveUserNames(
      this.pool,
      rows.map((r) => r.kasir_id),
    );
    const out: Sale[] = [];
    for (const row of rows)
      out.push(await this.hydrate(client, row, names.get(row.kasir_id) ?? row.kasir_id));
    return out;
  }

  private async hydrate(client: PoolClient, row: RawSaleRow, kasirName: string): Promise<Sale> {
    const lines = await client.query<SaleLineRow>(
      `SELECT sl.product_id, p.name AS product_name, sl.qty, sl.unit_price, sl.discount, sl.line_total
         FROM sale_lines sl JOIN products p ON p.id = sl.product_id
        WHERE sl.sale_id = $1 ORDER BY sl.sort_order`,
      [row.id],
    );
    const payments = await client.query<SalePaymentRow>(
      `SELECT method, amount, reference, payment_status FROM sale_payments WHERE sale_id = $1`,
      [row.id],
    );
    return mapSale({ ...row, kasir_name: kasirName }, lines.rows, payments.rows);
  }
}
