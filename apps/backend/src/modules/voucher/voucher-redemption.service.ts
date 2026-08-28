/**
 * Redeeming a voucher against a sale — the half of this module the POS calls,
 * on BOTH the online REST path and the offline sync path.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE THREE RULES THIS FILE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE SERVER RECOMPUTES THE DISCOUNT. Always, from its own subtotal and
 *    its own copy of the batch rules, via the shared `checkVoucher()`. The
 *    device's claimed `discount` is never the number that reaches
 *    `voucher_redemptions.discount_amount`. A till is a tablet in a fried
 *    chicken shop; treating a number it sends as authoritative money would
 *    make "edit the outbox JSON" a discount generator.
 *
 * 2. THE UNIQUE INDEX IS THE DOUBLE-SPEND GUARD, not the status check.
 *    `evaluate()` reads `vouchers.status` and that read is a COURTESY — it
 *    gives the cashier a clean message in the common case. Two concurrent
 *    tills can both see `active` before either commits; nothing in TypeScript
 *    can close that. `commit()`'s INSERT into `voucher_redemptions` is what
 *    closes it, because `voucher_id` is UNIQUE and the loser gets SQLSTATE
 *    23505. See migration 254's header for the full argument.
 *
 * 3. AN OFFLINE-ORIGINATED SALE IS A FACT AND IS NEVER REJECTED. It already
 *    happened: food left the kitchen, money entered the drawer. So on the
 *    sync path a bad voucher does not fail the projection — it records the
 *    sale and opens a reconciliation exception. Rejecting it would mean an
 *    outlet's whole day silently failing to project because one coupon was
 *    stale, which is the exact class of failure D-17a's `'fact'` ledger mode
 *    exists to prevent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS TWO PHASES (`evaluate` then `commit`) AND NOT ONE CALL
 * ══════════════════════════════════════════════════════════════════════════
 * The discount has to be known BEFORE the `sales` row is written (it changes
 * `discount`, `total` and `change_amount`), but the redemption row cannot be
 * written until AFTER it (`voucher_redemptions.sale_id` is an FK to a row that
 * must exist). A single call would have to either write the redemption with a
 * NULL `sale_id` and back-fill it — an extra UPDATE and a window where an
 * orphan row exists — or let the caller apply a discount that the race guard
 * has not yet arbitrated.
 *
 * So: `evaluate()` is pure read and returns the priced answer;
 * `PosSaleService` folds that into its cart summary and inserts the sale;
 * `commit()` then writes the redemption on the SAME connection and inside the
 * SAME transaction, so the sale and its redemption land together or not at
 * all. That atomicity is the reason neither method opens a transaction of its
 * own — see `db-tx.ts`'s header for why `withWrite` is deliberately absent
 * here.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENS TO THE MONEY WHEN AN OFFLINE COUPON IS REFUSED
 * ══════════════════════════════════════════════════════════════════════════
 * This is the trade-off the brief asked to be made explicit, so here it is in
 * full.
 *
 * The customer already walked out with the discount. Three options existed:
 *
 *   (a) Record the sale at its UNDISCOUNTED total. The books would then say
 *       the till took Rp 85.000 when Rp 75.000 is in the drawer — a phantom
 *       cash shortfall that R7 would ALSO flag at shift close, so the same
 *       Rp 10.000 would be reported twice, in two queues, to two people, and
 *       the supervisor holding the drawer would be blamed for a discrepancy
 *       they did not cause.
 *   (b) Record the discount AND redeem the coupon anyway. That is not
 *       "accepting risk", it is deleting the guard: the second till to sync
 *       the same code would silently overwrite the first.
 *   (c) Record the sale exactly as it was rung — the discount the customer
 *       actually received stays on the sale, so `paid_amount == total` and
 *       the drawer reconciles — but write NO redemption row, leave the coupon
 *       as it was, and open a `sync_conflicts` exception naming the code, the
 *       amount given away and why it could not be redeemed.
 *
 * (c) is implemented. The loss is real and it is reported in exactly one
 * place, to the one role that can act on it (finance), with the numbers
 * needed to act. The cost of (c), recorded so it is findable: a sale can
 * carry a discount that no `voucher_redemptions` row accounts for, so
 * "sum of voucher redemptions" will not equal "sum of voucher discounts given"
 * whenever this fires. That inequality IS the exception queue's backlog, and
 * it is the honest number.
 *
 * When the coupon IS good but the device's arithmetic disagreed with the
 * server's, the SERVER's number wins on the redemption row (rule 1) and the
 * discrepancy gets its own exception — a device computing discounts
 * differently from the server is either a stale batch cache or tampering, and
 * both need a human.
 */
import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { DatabaseError } from 'pg';
import type { PoolClient } from 'pg';
import {
  ERR_VOUCHER_NOT_FOUND,
  ERR_VOUCHER_OFFLINE_BLOCKED,
  VoucherStatus,
  VoucherType,
  businessDateOf,
  checkVoucher,
  compareMoney,
  normalizeVoucherCode,
  type Money,
  type UUID,
  type VoucherRejection,
  type VoucherRules,
} from '@mimi/shared';
import type { LedgerMode } from '@mimi/sync-protocol';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { formatDateOnly } from '../../common/date-only.util';
import {
  UNIQUE_VIOLATION,
  VoucherRepository,
  type VoucherWithBatchRow,
} from './voucher.repository';
import { errorCodeForRejection } from './voucher-rejection.util';
import { getVoucherOfflinePolicy } from './voucher-settings.util';

/**
 * Why a redemption was refused. A superset of the shared `VoucherRejection`:
 * `'malformed'` and `'offline_blocked'` are refusals that happen BEFORE
 * `checkVoucher()` is consulted at all, so they cannot be members of that
 * union without giving the shared calculator reasons it can never return.
 */
export type VoucherRefusal = VoucherRejection | 'malformed' | 'offline_blocked';

export type VoucherEvaluation =
  | {
      ok: true;
      voucherId: UUID;
      /** The CANONICAL `MC-XXXX-XXXX` form, not whatever the cashier typed. */
      code: string;
      discount: Money;
      batchId: UUID;
      batchCode: string;
      batchName: string;
    }
  | { ok: false; reason: VoucherRefusal; code: string };

export interface EvaluateInput {
  /** Raw, as typed at the till or as it arrived in the sync payload. */
  code: string;
  /** Pre-voucher basket subtotal, AFTER line and sale discounts. Server-computed. */
  subtotal: Money;
  locationId: UUID;
  /** Instant of the sale; the WITA business date is derived from it (D-11). */
  occurredAt: string;
  /**
   * True when the device took this coupon while it could not reach the cloud.
   * Only meaningful on the sync path; the REST path is by definition online.
   */
  offlineAccepted: boolean;
}

export interface CommitInput {
  saleId: UUID;
  locationId: UUID;
  redeemedBy: UUID | null;
  offlineAccepted: boolean;
  /** Present only on the sync path — links the exception back to its event. */
  eventId?: UUID | null;
  /** What the DEVICE claimed the discount was. Recorded, never trusted. */
  claimedDiscount?: Money | null;
}

@Injectable()
export class VoucherRedemptionService {
  constructor(
    private readonly repo: VoucherRepository,
    private readonly conflicts: SyncConflictsRepository,
  ) {}

  /**
   * PHASE 1 — price the coupon against this basket. Reads only.
   *
   * NEVER THROWS on a refusal; it returns one. Three callers need three
   * different things from the same answer, and only one of them is an error:
   *   * `POST /api/vouchers/check` returns `{ ok: false, code }` with HTTP
   *     200 — the cashier ASKED a question and got an answer, which is not a
   *     failed request.
   *   * the online sale path turns it into a 400 via `refusalException()`.
   *   * the sync path records the sale anyway and opens an exception.
   * Baking `throw` into this method would have forced two of the three to
   * catch an exception to read a value, which is how a `catch {}` that
   * swallows a real database error eventually gets written.
   */
  async evaluate(client: PoolClient, input: EvaluateInput): Promise<VoucherEvaluation> {
    const refuse = (reason: VoucherRefusal, code: string): VoucherEvaluation => ({
      ok: false,
      reason,
      code,
    });

    // Accepts what a cashier actually types — lower case, missing dashes, an
    // `O` for a `0`. Normalising server-side rather than trusting the till to
    // have done it means the server accepts exactly the sloppiness the till
    // does, which is the only way the two can agree about what "this code" is.
    const code = normalizeVoucherCode(input.code);
    if (!code) return refuse('malformed', input.code);

    /**
     * The offline gate is checked BEFORE the coupon is even looked up, and
     * that ordering is deliberate. Under `pos.voucher_offline = 'reject'` the
     * answer is "this till may not accept coupons it cannot verify" — which is
     * true regardless of whether this particular coupon happens to be fine.
     * Looking it up first and refusing a VALID coupon with a lookup-shaped
     * reason would tell the operator the wrong story about why they lost the
     * money.
     */
    if (input.offlineAccepted) {
      const policy = await getVoucherOfflinePolicy(client);
      if (policy === 'reject') return refuse('offline_blocked', code);
    }

    const row = await this.repo.findByCode(client, code);
    if (!row) return refuse('not_found', code);

    const result = checkVoucher({
      rules: rulesFromRow(row),
      status: row.status as VoucherStatus,
      subtotal: input.subtotal,
      businessDate: businessDateOf(input.occurredAt),
      locationId: input.locationId,
    });

    if (!result.ok) return refuse(result.reason, code);

    return {
      ok: true,
      voucherId: row.id,
      code,
      discount: result.discount,
      batchId: row.batch_id,
      batchCode: row.batch_code,
      batchName: row.batch_name,
    };
  }

  /**
   * PHASE 2 — write the redemption. Must run in the SAME transaction as the
   * `sales` INSERT, after it (the FK needs the sale row).
   *
   * Returns `true` when the coupon was actually redeemed. `false` is only ever
   * returned on the `'fact'` path, and only after an exception has been
   * recorded — a silent `false` would be the "silently dropping money" failure
   * this whole design is arranged to avoid.
   */
  async commit(
    client: PoolClient,
    evaluation: Extract<VoucherEvaluation, { ok: true }>,
    input: CommitInput,
    mode: LedgerMode,
  ): Promise<boolean> {
    /**
     * THE INNER SAVEPOINT, and why it is not optional.
     *
     * A failed INSERT aborts the WHOLE transaction in Postgres: after a 23505,
     * every subsequent statement on this connection errors with "current
     * transaction is aborted" until something unwinds. Both callers are deep
     * inside a transaction they do not own — the REST path inside the one
     * `RlsContextGuard` opened, the sync path inside
     * `SyncEventsRepository.withTransaction` AND inside
     * `SyncProjectorRegistry`'s per-event `SAVEPOINT sp_<eventId>`.
     *
     * Without a savepoint of its own, a lost race on the SYNC path would
     * unwind to the projector's savepoint and take THE ENTIRE SALE with it —
     * a real sale, already rung, already paid for, discarded because a coupon
     * was stale. That is precisely the outcome rule 3 exists to prevent, and
     * it would be invisible: the projector would mark the projection failed
     * and the event would still be acked.
     *
     * So the INSERT gets its own savepoint. A lost race unwinds exactly that
     * one statement, the sale stands, and the caller is free to keep writing —
     * including the exception row that reports the give-away.
     *
     * The savepoint name is derived from the voucher id with its dashes
     * stripped, matching `SyncProjectorRegistry`'s own `sp_<eventIdNoDashes>`
     * convention. It is interpolated into SQL, which is safe ONLY because a
     * UUID that reached here came from `vouchers.id` — a `UUID` column, so
     * Postgres has already guaranteed its shape. The regex below enforces
     * that independently rather than trusting it, because "an identifier
     * cannot be parameterised" plus "this value is surely safe" is how
     * injection gets written.
     */
    const savepoint = `sp_v_${evaluation.voucherId.replace(/-/g, '')}`;
    if (!/^sp_v_[0-9a-f]{32}$/.test(savepoint)) {
      throw new Error(`refusing to build a savepoint name from '${evaluation.voucherId}'`);
    }

    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await this.repo.insertRedemption(client, {
        voucherId: evaluation.voucherId,
        saleId: input.saleId,
        locationId: input.locationId,
        // Rule 1: the SERVER's number, computed in `evaluate()` from the
        // server's own subtotal and the server's own copy of the batch rules.
        discountAmount: evaluation.discount,
        redeemedBy: input.redeemedBy,
        offlineAccepted: input.offlineAccepted,
      });
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (!isUniqueViolation(err)) throw err;

      /**
       * THE RACE, ARBITRATED. Another transaction inserted a redemption for
       * this same `voucher_id` first — a second till, a replayed outbox, or
       * two offline devices that both took the same paper coupon.
       *
       * On `'strict'` this throws. The request's transaction is never
       * committed (`RlsCleanupInterceptor` rolls it back), so the sale that
       * was inserted moments ago goes with it. That is correct: the cashier
       * re-rings without the coupon and the customer pays full price. The
       * message is the same `ERR_VOUCHER_NOT_ACTIVE` a coupon that was already
       * `redeemed` at lookup time produces, so a losing till shows exactly
       * what a slower till would have shown — the race is invisible to the
       * person at the counter, which is the right amount of detail for them.
       *
       * On `'fact'` it returns `false` and the caller records the exception.
       */
      if (mode === 'strict') {
        throw this.refusalException('not_active', evaluation.code);
      }
      return false;
    }

    // Keeps the denormalised column honest. NOT the guard — the INSERT above
    // already was. A `false` here means somebody else moved the row to a
    // terminal state between our INSERT and this UPDATE, which the unique
    // index makes impossible for another redemption and leaves only a
    // concurrent void; the redemption row stands either way and is the fact.
    await this.repo.markRedeemed(client, evaluation.voucherId);

    // Rule 1's audit trail: if the device computed a different number from the
    // server, somebody needs to know. A stale batch cache on a till is benign
    // and fixable; the same symptom is also what tampering looks like, and
    // neither is distinguishable from here.
    const claimed = input.claimedDiscount;
    if (claimed != null && compareMoney(claimed, evaluation.discount) !== 0) {
      await this.conflicts.recordConflictIfAbsent(client, {
        kind: 'poison',
        queue: 'finance',
        entity: 'sales',
        entityId: input.saleId,
        locationId: input.locationId,
        loserEventId: input.eventId ?? null,
        detail: {
          reason: 'voucher_discount_variance',
          code: evaluation.code,
          batchCode: evaluation.batchCode,
          claimedByDevice: claimed,
          computedByServer: evaluation.discount,
        },
        assigneeRole: 'finance',
      });
    }

    return true;
  }

  /**
   * The `'fact'`-path exception for a coupon that could NOT be redeemed —
   * either refused by `evaluate()` or lost the race in `commit()`.
   *
   * `kind: 'poison'` is not a great name for this and is chosen deliberately
   * anyway. `sync_conflicts.kind` is a CHECK-constrained closed list
   * (migration 123) with no voucher member, and this repo has an established,
   * documented precedent for reusing `'poison'` with the real reason in
   * `detail.reason` when no dedicated bucket exists — see
   * `reconciliation.service.ts`'s R4 price-variance call and its
   * `// no dedicated ... kind exists in the closed SyncConflictKind list`
   * comment, and `conflict-detector.service.ts`'s `recordProjectionFailure`.
   * Following that precedent keeps this feature out of the business of
   * altering a kernel table's constraint. A dedicated `'voucher_refused'` kind
   * would read better in the queue and is flagged as a follow-up.
   *
   * `queue: 'finance'` and `assigneeRole: 'finance'` rather than the generic
   * `'exception'` queue: this is lost margin with a rupiah figure on it, which
   * is a finance job, not a data-integrity job. R7's cash-variance rows make
   * the same call.
   */
  async recordRefusedRedemption(
    client: PoolClient,
    params: {
      saleId: UUID;
      locationId: UUID;
      code: string;
      reason: VoucherRefusal;
      discountGivenAway: Money | null;
      offlineAccepted: boolean;
      eventId?: UUID | null;
    },
  ): Promise<void> {
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'poison',
      queue: 'finance',
      entity: 'sales',
      entityId: params.saleId,
      locationId: params.locationId,
      loserEventId: params.eventId ?? null,
      detail: {
        reason: 'voucher_rejected',
        voucherRejection: params.reason,
        code: params.code,
        // The money the till handed over that no coupon now accounts for.
        // This is the number a human has to reconcile.
        discountGivenAway: params.discountGivenAway,
        offlineAccepted: params.offlineAccepted,
      },
      assigneeRole: 'finance',
    });
  }

  /**
   * One refusal → one `ERR_VOUCHER_*` body. The two non-`VoucherRejection`
   * refusals are handled here and everything else delegates to the exhaustive
   * switch in `voucher-rejection.util.ts`, so adding a shared rejection reason
   * still fails to compile there rather than falling through to a generic
   * message here.
   */
  refusalException(reason: VoucherRefusal, code: string): BadRequestException {
    if (reason === 'malformed') {
      return new BadRequestException({
        code: ERR_VOUCHER_NOT_FOUND,
        message: `'${code}' is not a valid voucher code`,
      });
    }
    if (reason === 'offline_blocked') {
      return new BadRequestException({
        code: ERR_VOUCHER_OFFLINE_BLOCKED,
        message:
          'this device was offline and pos.voucher_offline is set to reject — the voucher cannot be verified',
      });
    }
    return new BadRequestException({
      code: errorCodeForRejection(reason),
      message: `voucher '${code}' cannot be redeemed (${reason})`,
    });
  }
}

/** `voucher_batches` columns → the narrow view `checkVoucher()` wants. */
export function rulesFromRow(row: VoucherWithBatchRow): VoucherRules {
  return {
    type: row.batch_type as VoucherType,
    value: row.batch_value,
    minSubtotal: row.batch_min_subtotal,
    maxDiscount: row.batch_max_discount,
    // `valid_from`/`valid_until` are DATE columns: `node-pg` hands them back
    // as a Date built with the LOCAL constructor, and `.toISOString()` on that
    // shifts the calendar day by the process's UTC offset — under WITA
    // (UTC+8) by a full day, in the direction that would expire a coupon
    // twenty-four hours early. `formatDateOnly` recovers the original y/m/d.
    // See `common/date-only.util.ts`; four modules have hit this already.
    validFrom: formatDateOnly(row.batch_valid_from),
    validUntil: formatDateOnly(row.batch_valid_until),
    locationIds: row.batch_location_ids,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as DatabaseError | undefined)?.code === UNIQUE_VIOLATION;
}
