/**
 * Raw `pg` access for the voucher module (migration 254).
 *
 * RLS POSTURE — the thing to hold in mind reading every query below:
 *   * `voucher_batches` and `vouchers` carry NO row security. They are
 *     network-wide master data, gated only by `PermissionsGuard`, because a
 *     till must be able to look up a code its own outlet is entitled to accept
 *     no matter which office authored the batch. See migration 254's header.
 *   * `voucher_redemptions` IS location-scoped (`app_has_location(location_id)`,
 *     the same policy `sales` has carried since migration 055). So a read of
 *     that table from an outlet session returns only that outlet's rows — and
 *     the code below never relies on it to answer "was this spent". The
 *     network-wide answer is `vouchers.status`; the AUTHORITATIVE answer is
 *     the unique index, which arbitrates rows the inserting session cannot
 *     see.
 *
 * Every method takes the caller's own `PoolClient` — the one
 * `RlsContextGuard` opened for this request — never a fresh pool connection,
 * matching `settings.repository.ts` and every other module here.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';

/** `voucher_batches` row, column-for-column. Decimals arrive as strings (D-10) and stay strings. */
export interface VoucherBatchRow {
  id: UUID;
  code: string;
  name: string;
  type: string;
  value: string;
  min_subtotal: string;
  max_discount: string | null;
  valid_from: Date | string;
  valid_until: Date | string;
  location_ids: UUID[] | null;
  terms: string | null;
  status: string;
  created_by: UUID | null;
  created_at: string;
  updated_at: string;
  /** Aggregates for the list/detail screens; absent on the redemption-path lookups. */
  voucher_count?: string;
  redeemed_count?: string;
}

export interface VoucherRow {
  id: UUID;
  batch_id: UUID;
  code: string;
  status: string;
  issued_at: string;
  printed_at: string | null;
  created_at: string;
}

/** A voucher joined to the batch rules `checkVoucher()` needs — one round trip, not two. */
export interface VoucherWithBatchRow extends VoucherRow {
  batch_code: string;
  batch_name: string;
  batch_type: string;
  batch_value: string;
  batch_min_subtotal: string;
  batch_max_discount: string | null;
  batch_valid_from: Date | string;
  batch_valid_until: Date | string;
  batch_location_ids: UUID[] | null;
  batch_status: string;
}

/**
 * SQLSTATE 23505. The redemption path catches exactly this on
 * `voucher_redemptions_voucher_id_key` and turns it into
 * `ERR_VOUCHER_NOT_ACTIVE` — see `voucher-redemption.service.ts`. Exported so
 * the catch site and the integration test that provokes a real race name the
 * same constant instead of two copies of a magic string.
 */
export const UNIQUE_VIOLATION = '23505';

const BATCH_COLUMNS = `
  b.id, b.code, b.name, b.type, b.value, b.min_subtotal, b.max_discount,
  b.valid_from, b.valid_until, b.location_ids, b.terms, b.status,
  b.created_by, b.created_at, b.updated_at
`;

@Injectable()
export class VoucherRepository {
  // ── batches ───────────────────────────────────────────────────────────────

  /**
   * The counts are correlated subqueries rather than `LEFT JOIN ... GROUP BY`
   * on purpose: the batch list is paginated, and grouping over `vouchers`
   * before the `LIMIT` would materialise every coupon in every batch on the
   * page's behalf. `idx_vouchers_batch_status` covers both subqueries.
   */
  async listBatches(
    client: PoolClient,
    filter: { status?: string; page: number; pageSize: number },
  ): Promise<{ rows: VoucherBatchRow[]; total: number }> {
    const params: unknown[] = [];
    let where = '';
    if (filter.status) {
      params.push(filter.status);
      where = `WHERE b.status = $${params.length}`;
    }

    const totalRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM voucher_batches b ${where}`,
      params,
    );

    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize);
    const res = await client.query<VoucherBatchRow>(
      `SELECT ${BATCH_COLUMNS},
              (SELECT COUNT(*)::text FROM vouchers v WHERE v.batch_id = b.id) AS voucher_count,
              (SELECT COUNT(*)::text FROM vouchers v WHERE v.batch_id = b.id AND v.status = 'redeemed') AS redeemed_count
         FROM voucher_batches b
         ${where}
        ORDER BY b.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: res.rows, total: parseInt(totalRes.rows[0]!.count, 10) };
  }

  async findBatchById(client: PoolClient, id: UUID): Promise<VoucherBatchRow | undefined> {
    const res = await client.query<VoucherBatchRow>(
      `SELECT ${BATCH_COLUMNS},
              (SELECT COUNT(*)::text FROM vouchers v WHERE v.batch_id = b.id) AS voucher_count,
              (SELECT COUNT(*)::text FROM vouchers v WHERE v.batch_id = b.id AND v.status = 'redeemed') AS redeemed_count
         FROM voucher_batches b
        WHERE b.id = $1`,
      [id],
    );
    return res.rows[0];
  }

  async insertBatch(
    client: PoolClient,
    input: {
      code: string;
      name: string;
      type: string;
      value: string;
      minSubtotal: string;
      maxDiscount: string | null;
      validFrom: string;
      validUntil: string;
      locationIds: UUID[] | null;
      terms: string | null;
      createdBy: UUID;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO voucher_batches
         (code, name, type, value, min_subtotal, max_discount, valid_from, valid_until, location_ids, terms, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
       RETURNING id`,
      [
        input.code,
        input.name,
        input.type,
        input.value,
        input.minSubtotal,
        input.maxDiscount,
        input.validFrom,
        input.validUntil,
        input.locationIds,
        input.terms,
        input.createdBy,
      ],
    );
    return res.rows[0]!.id;
  }

  /**
   * Partial update, built from whichever fields the caller actually supplied.
   *
   * `WHERE status = 'draft'` is part of the STATEMENT, not a prior check, and
   * that is deliberate: a "read the batch, see it is draft, then update it"
   * pair can interleave with a concurrent issue/close, and an edit that
   * silently repriced a batch whose coupons are already in customers' hands is
   * exactly the failure this guard exists to prevent. `rowCount === 0` then
   * means EITHER "no such batch" OR "not a draft any more"; the service
   * distinguishes the two with a follow-up read purely to produce a good error
   * message, which is safe to do because by then nothing has been written.
   */
  async updateDraftBatch(
    client: PoolClient,
    id: UUID,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return true;

    const params: unknown[] = [id];
    const sets = entries.map(([column, value]) => {
      params.push(value);
      return `${column} = $${params.length}`;
    });

    const res = await client.query(
      `UPDATE voucher_batches SET ${sets.join(', ')} WHERE id = $1 AND status = 'draft'`,
      params,
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Guarded the same way `updateDraftBatch` is, and for the same reason. */
  async setBatchStatus(
    client: PoolClient,
    id: UUID,
    next: string,
    allowedFrom: readonly string[],
  ): Promise<boolean> {
    const res = await client.query(
      `UPDATE voucher_batches SET status = $2 WHERE id = $1 AND status = ANY($3::text[])`,
      [id, next, allowedFrom],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── vouchers ──────────────────────────────────────────────────────────────

  /**
   * Mints ONE coupon. Returns `false` on a `code` collision so the caller can
   * retry with fresh entropy — `ON CONFLICT (code) DO NOTHING` rather than a
   * thrown 23505, because at this one call site a collision is an EXPECTED,
   * recoverable event (see `VoucherService.issue`'s birthday-problem note) and
   * not the exceptional condition an exception is for. Contrast
   * `insertRedemption` below, where 23505 IS the exceptional condition and is
   * deliberately allowed to throw.
   */
  async insertVoucher(client: PoolClient, batchId: UUID, code: string): Promise<boolean> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO vouchers (batch_id, code, status) VALUES ($1,$2,'active')
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [batchId, code],
    );
    return !!res.rows[0];
  }

  async listVouchersByBatch(
    client: PoolClient,
    batchId: UUID,
    filter: { status?: string; page: number; pageSize: number },
  ): Promise<{ rows: VoucherRow[]; total: number }> {
    const params: unknown[] = [batchId];
    let statusClause = '';
    if (filter.status) {
      params.push(filter.status);
      statusClause = ` AND status = $${params.length}`;
    }

    const totalRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vouchers WHERE batch_id = $1${statusClause}`,
      params,
    );

    params.push(filter.pageSize, (filter.page - 1) * filter.pageSize);
    const res = await client.query<VoucherRow>(
      `SELECT id, batch_id, code, status, issued_at, printed_at, created_at
         FROM vouchers
        WHERE batch_id = $1${statusClause}
        ORDER BY code
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: res.rows, total: parseInt(totalRes.rows[0]!.count, 10) };
  }

  /** The till's hot path: one code → the coupon plus every rule needed to price it. */
  async findByCode(client: PoolClient, code: string): Promise<VoucherWithBatchRow | undefined> {
    const res = await client.query<VoucherWithBatchRow>(
      `SELECT v.id, v.batch_id, v.code, v.status, v.issued_at, v.printed_at, v.created_at,
              b.code AS batch_code, b.name AS batch_name, b.type AS batch_type, b.value AS batch_value,
              b.min_subtotal AS batch_min_subtotal, b.max_discount AS batch_max_discount,
              b.valid_from AS batch_valid_from, b.valid_until AS batch_valid_until,
              b.location_ids AS batch_location_ids, b.status AS batch_status
         FROM vouchers v
         JOIN voucher_batches b ON b.id = v.batch_id
        WHERE v.code = $1`,
      [code],
    );
    return res.rows[0];
  }

  async findVoucherById(client: PoolClient, id: UUID): Promise<VoucherRow | undefined> {
    const res = await client.query<VoucherRow>(
      `SELECT id, batch_id, code, status, issued_at, printed_at, created_at FROM vouchers WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  /**
   * Flips a coupon to `redeemed`. `WHERE status = 'active'` again, for the
   * same reason the batch guards carry theirs — but note this UPDATE is NOT
   * the double-spend guard and must not be mistaken for one. By the time it
   * runs, `insertRedemption` has already won or lost the unique index. This
   * only keeps the denormalised column honest.
   */
  async markRedeemed(client: PoolClient, voucherId: UUID): Promise<boolean> {
    const res = await client.query(
      `UPDATE vouchers SET status = 'redeemed' WHERE id = $1 AND status = 'active'`,
      [voucherId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Void is only reachable from `active`: a spent coupon cannot be un-spent by voiding it. */
  async markVoid(client: PoolClient, voucherId: UUID): Promise<boolean> {
    const res = await client.query(
      `UPDATE vouchers SET status = 'void' WHERE id = $1 AND status = 'active'`,
      [voucherId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── redemptions ───────────────────────────────────────────────────────────

  /**
   * THE RACE ARBITER. Deliberately has no `ON CONFLICT` clause: a unique
   * violation here is the signal the caller needs, and swallowing it would
   * turn a double-spend into a silent no-op that still discounted the sale.
   * `voucher-redemption.service.ts` catches SQLSTATE `23505` around this exact
   * call. See migration 254's header for the full argument.
   *
   * `sale_id` is passed and NOT NULL in practice on both live paths — the sale
   * row is inserted first, in the same transaction — but the column is
   * nullable so a future offline-reconciliation path can record a redemption
   * whose sale has not been projected yet.
   */
  async insertRedemption(
    client: PoolClient,
    input: {
      voucherId: UUID;
      saleId: UUID | null;
      locationId: UUID;
      discountAmount: string;
      redeemedBy: UUID | null;
      offlineAccepted: boolean;
    },
  ): Promise<UUID> {
    const res = await client.query<{ id: UUID }>(
      `INSERT INTO voucher_redemptions
         (voucher_id, sale_id, location_id, discount_amount, redeemed_by, offline_accepted)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        input.voucherId,
        input.saleId,
        input.locationId,
        input.discountAmount,
        input.redeemedBy,
        input.offlineAccepted,
      ],
    );
    return res.rows[0]!.id;
  }
}
