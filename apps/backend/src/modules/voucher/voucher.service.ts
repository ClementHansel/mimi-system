/**
 * Voucher batches and the coupons inside them — authoring, minting, closing,
 * voiding, and the till's "what is this worth" lookup.
 *
 * The REDEMPTION path is deliberately not here: it lives in
 * `voucher-redemption.service.ts` because it is called from inside
 * `PosSaleService`'s transaction and must never open one of its own. This
 * file is the administrative surface, and every method in it that writes IS
 * wrapped in `withWrite` (see `db-tx.ts`'s header for why that is not
 * optional).
 *
 * `voucher_batches` and `vouchers` carry NO RLS — they are network-wide, and
 * `PermissionsGuard` is the only gate. Migration 254's header explains why a
 * location-scoped coupon table would make a valid coupon unfindable at the
 * outlet entitled to accept it.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  VoucherBatchStatus,
  VoucherStatus,
  VoucherType,
  compareMoney,
  type ErrorCode,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { formatDateOnly } from '../../common/date-only.util';
import { withWrite } from './db-tx';
import { mintVoucherCode } from './voucher-code.util';
import { errorCodeForRejection } from './voucher-rejection.util';
import { VoucherRepository, type VoucherBatchRow, type VoucherRow } from './voucher.repository';
import { VoucherRedemptionService } from './voucher-redemption.service';
import type {
  CheckVoucherDto,
  CreateBatchDto,
  IssueVouchersDto,
  ListBatchVouchersQueryDto,
  ListBatchesQueryDto,
  UpdateBatchDto,
} from './dto/voucher.dto';

export interface VoucherBatchRes {
  id: UUID;
  code: string;
  name: string;
  type: VoucherType;
  /** Rupiah for `fixed`; a percent with two decimals for `percentage` (`'10.00'` = 10%). */
  value: Money;
  minSubtotal: Money;
  maxDiscount: Money | null;
  validFrom: string;
  validUntil: string;
  /** `null` = every outlet. */
  locationIds: UUID[] | null;
  terms: string | null;
  status: VoucherBatchStatus;
  /** How many coupons have been minted, and how many of those are spent. */
  voucherCount: number;
  redeemedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoucherRes {
  id: UUID;
  batchId: UUID;
  code: string;
  status: VoucherStatus;
  issuedAt: string;
  printedAt: string | null;
}

/**
 * `POST /api/vouchers/check`'s response. Deliberately a 200 in BOTH arms.
 *
 * A refusal is an ANSWER, not a failed request: the cashier asked what a code
 * is worth and the server told them. Returning 400 would make the till's
 * fetch layer treat "this coupon is expired" the same as "the network is
 * down" — and the difference between those two is exactly what the person at
 * the counter needs to know. The machine-readable `code` is the same
 * `ERR_VOUCHER_*` the sale path would have thrown, so the till has one
 * message table for both paths.
 */
export type VoucherCheckRes =
  | { ok: true; voucherId: UUID; code: string; discount: Money; batchName: string }
  | { ok: false; code: ErrorCode };

@Injectable()
export class VoucherService {
  constructor(
    private readonly repo: VoucherRepository,
    private readonly redemption: VoucherRedemptionService,
  ) {}

  // ── batches ───────────────────────────────────────────────────────────────

  async listBatches(
    client: PoolClient,
    query: ListBatchesQueryDto,
  ): Promise<Paginated<VoucherBatchRes>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const { rows, total } = await this.repo.listBatches(client, {
      status: query.status,
      page,
      pageSize,
    });
    return { rows: rows.map(mapBatch), total, page, pageSize };
  }

  async getBatch(client: PoolClient, id: UUID): Promise<VoucherBatchRes> {
    return mapBatch(await this.mustGetBatch(client, id));
  }

  async createBatch(
    client: PoolClient,
    dto: CreateBatchDto,
    createdBy: UUID,
  ): Promise<VoucherBatchRes> {
    this.assertBatchShape(
      dto.type,
      dto.value,
      dto.maxDiscount ?? null,
      dto.validFrom,
      dto.validUntil,
    );

    return withWrite(client, async () => {
      const id = await this.repo.insertBatch(client, {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        value: dto.value,
        minSubtotal: dto.minSubtotal ?? '0.00',
        maxDiscount: dto.maxDiscount ?? null,
        validFrom: dto.validFrom,
        validUntil: dto.validUntil,
        locationIds: dto.locationIds ?? null,
        terms: dto.terms ?? null,
        createdBy,
      });
      return mapBatch(await this.mustGetBatch(client, id));
    });
  }

  /**
   * Draft-only. The `WHERE status = 'draft'` lives in the UPDATE itself rather
   * than in a check-then-write pair here — see
   * `VoucherRepository.updateDraftBatch`'s comment for why that difference
   * matters. This method's own read is purely to turn "0 rows updated" into a
   * message that says WHICH of the two reasons applied.
   */
  async updateBatch(client: PoolClient, id: UUID, dto: UpdateBatchDto): Promise<VoucherBatchRes> {
    const existing = await this.mustGetBatch(client, id);
    if (existing.status !== VoucherBatchStatus.Draft) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `batch '${existing.code}' is ${existing.status} — only a draft batch can be edited, because its coupons are already printed`,
      });
    }

    // Validate the POST-MERGE shape, not the patch: a PATCH that only sets
    // `type: 'fixed'` on a batch that already carries a `maxDiscount` would
    // otherwise slip past a patch-only check and land on migration 254's
    // `chk_voucher_batch_cap` as an opaque 500.
    const type = dto.type ?? (existing.type as VoucherType);
    const value = dto.value ?? existing.value;
    const maxDiscount = dto.maxDiscount !== undefined ? dto.maxDiscount : existing.max_discount;
    const validFrom = dto.validFrom ?? formatDateOnly(existing.valid_from);
    const validUntil = dto.validUntil ?? formatDateOnly(existing.valid_until);
    this.assertBatchShape(type, value, maxDiscount, validFrom, validUntil);

    return withWrite(client, async () => {
      const updated = await this.repo.updateDraftBatch(client, id, {
        code: dto.code,
        name: dto.name,
        type: dto.type,
        value: dto.value,
        min_subtotal: dto.minSubtotal,
        max_discount: dto.maxDiscount,
        valid_from: dto.validFrom,
        valid_until: dto.validUntil,
        location_ids: dto.locationIds,
        terms: dto.terms,
      });
      if (!updated) {
        // The batch left `draft` between the read above and this UPDATE.
        throw new ConflictException({
          code: ERR_CONFLICT,
          message: `batch '${id}' is no longer a draft`,
        });
      }
      return mapBatch(await this.mustGetBatch(client, id));
    });
  }

  /**
   * Mints `quantity` coupons and flips the batch to `issued`.
   *
   * COLLISIONS ARE EXPECTED, NOT EXCEPTIONAL, and the retry below is why this
   * is a loop and not a bulk INSERT. The code space is 32^8 ≈ 1.1e12. By the
   * birthday bound, a network that has issued 100 000 coupons in total has
   * roughly a 1-in-250 000 chance of any given new code colliding — small per
   * code, but multiplied by every code ever minted it is a thing that WILL
   * happen, and the first time it does it must not fail a print run. So each
   * insert retries with fresh entropy.
   *
   * `MAX_ATTEMPTS_PER_CODE` is a circuit breaker, not a collision budget: five
   * consecutive collisions on a space this size is not bad luck, it is a
   * broken entropy source (a seeded PRNG, a container with no `/dev/urandom`),
   * and minting forgeable coupons is far worse than failing the request.
   *
   * The whole loop runs in ONE transaction. Up to 5000 inserts is a large but
   * bounded unit of work, and partial issuance — 3200 coupons in the database,
   * a batch still marked `draft`, and no record of which of the 5000 the owner
   * is about to print — is a far worse state to recover from than a failed
   * request the owner simply repeats.
   */
  async issue(
    client: PoolClient,
    batchId: UUID,
    dto: IssueVouchersDto,
  ): Promise<{ issued: number; batch: VoucherBatchRes }> {
    const batch = await this.mustGetBatch(client, batchId);
    if (batch.status === VoucherBatchStatus.Closed) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `batch '${batch.code}' is closed — reopen is not supported; author a new batch`,
      });
    }

    const MAX_ATTEMPTS_PER_CODE = 5;

    return withWrite(client, async () => {
      for (let i = 0; i < dto.quantity; i++) {
        let placed = false;
        for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_CODE && !placed; attempt++) {
          placed = await this.repo.insertVoucher(client, batchId, mintVoucherCode());
        }
        if (!placed) {
          throw new ConflictException({
            code: ERR_CONFLICT,
            message: `could not mint a unique voucher code after ${MAX_ATTEMPTS_PER_CODE} attempts — this indicates a broken entropy source, not exhaustion of the code space`,
          });
        }
      }

      // `draft` → `issued`. Already-`issued` is a legitimate second print run,
      // so `allowedFrom` includes it and this is then a no-op.
      await this.repo.setBatchStatus(client, batchId, VoucherBatchStatus.Issued, [
        VoucherBatchStatus.Draft,
        VoucherBatchStatus.Issued,
      ]);

      return {
        issued: dto.quantity,
        batch: mapBatch(await this.mustGetBatch(client, batchId)),
      };
    });
  }

  /**
   * Closes a batch. Coupons already in customers' hands are NOT voided — a
   * closed batch means "stop issuing", not "stop honouring". Recalling a print
   * run is `POST /vouchers/:id/void`, one coupon at a time, deliberately: a
   * bulk void is an irreversible act on real bearer instruments and should not
   * be one button away from "stop printing these".
   */
  async closeBatch(client: PoolClient, batchId: UUID): Promise<VoucherBatchRes> {
    await this.mustGetBatch(client, batchId);
    return withWrite(client, async () => {
      await this.repo.setBatchStatus(client, batchId, VoucherBatchStatus.Closed, [
        VoucherBatchStatus.Draft,
        VoucherBatchStatus.Issued,
      ]);
      return mapBatch(await this.mustGetBatch(client, batchId));
    });
  }

  // ── vouchers ──────────────────────────────────────────────────────────────

  async listBatchVouchers(
    client: PoolClient,
    batchId: UUID,
    query: ListBatchVouchersQueryDto,
  ): Promise<Paginated<VoucherRes>> {
    await this.mustGetBatch(client, batchId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    const { rows, total } = await this.repo.listVouchersByBatch(client, batchId, {
      status: query.status,
      page,
      pageSize,
    });
    return { rows: rows.map(mapVoucher), total, page, pageSize };
  }

  /**
   * Voids ONE coupon — a misprint, a card recalled before it was handed out.
   *
   * Only reachable from `active`. Voiding a spent coupon is refused rather
   * than made a no-op, because the two are different things an operator might
   * mean and only one of them is possible: the money is already gone, and
   * saying "done" would be a lie.
   */
  async voidVoucher(client: PoolClient, voucherId: UUID): Promise<VoucherRes> {
    const existing = await this.repo.findVoucherById(client, voucherId);
    if (!existing) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `voucher '${voucherId}' not found`,
      });
    }
    if (existing.status !== VoucherStatus.Active) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `voucher '${existing.code}' is ${existing.status} — only an active voucher can be voided`,
      });
    }

    return withWrite(client, async () => {
      const voided = await this.repo.markVoid(client, voucherId);
      if (!voided) {
        // Redeemed or voided between the read and the UPDATE.
        throw new ConflictException({
          code: ERR_CONFLICT,
          message: `voucher '${existing.code}' is no longer active`,
        });
      }
      const row = await this.repo.findVoucherById(client, voucherId);
      return mapVoucher(row!);
    });
  }

  /**
   * "What is this code worth on this basket?" — the question a cashier asks
   * with a customer in front of them.
   *
   * Reads only, reserves nothing (see `CheckVoucherDto`'s header for the
   * trade-off that represents), and delegates every RULE to the shared
   * `checkVoucher()` through `VoucherRedemptionService.evaluate` rather than
   * reimplementing any of them here. That indirection is the point: the device
   * runs the same calculator offline, and the one thing that must never differ
   * between the two is what a coupon is worth.
   *
   * `businessDate` comes from the SERVER's clock, not the request. A till whose
   * clock is a day fast must not be able to redeem a coupon that has not
   * started.
   */
  async check(client: PoolClient, dto: CheckVoucherDto): Promise<VoucherCheckRes> {
    const evaluation = await this.redemption.evaluate(client, {
      code: dto.code,
      subtotal: dto.subtotal,
      locationId: dto.locationId,
      occurredAt: new Date().toISOString(),
      // This endpoint is by definition reachable only while online.
      offlineAccepted: false,
    });

    if (!evaluation.ok) {
      return { ok: false, code: refusalToErrorCode(evaluation.reason) };
    }
    return {
      ok: true,
      voucherId: evaluation.voucherId,
      code: evaluation.code,
      discount: evaluation.discount,
      batchName: evaluation.batchName,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async mustGetBatch(client: PoolClient, id: UUID): Promise<VoucherBatchRow> {
    const row = await this.repo.findBatchById(client, id);
    if (!row) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `voucher batch '${id}' not found`,
      });
    }
    return row;
  }

  /**
   * The invariants migration 254 also enforces as CHECK constraints, checked
   * here too so the caller gets a legible 400 naming the field instead of a
   * 500 carrying a constraint name.
   *
   * Duplicating them is deliberate and is the same call `settings.service.ts`
   * makes: the constraint is the AUTHORITY (it survives a future second
   * writer, a psql session, a data migration), and this is the MESSAGE. Losing
   * either one would be worse than maintaining both.
   */
  private assertBatchShape(
    type: VoucherType,
    value: Money,
    maxDiscount: Money | null,
    validFrom: string,
    validUntil: string,
  ): void {
    const fail = (message: string): never => {
      throw new BadRequestException({ code: ERR_VALIDATION, message });
    };

    if (compareMoney(value, '0.00') <= 0) {
      fail('value must be greater than zero — a voucher worth nothing or less is not a voucher');
    }
    if (type === VoucherType.Percentage && compareMoney(value, '100.00') > 0) {
      fail('a percentage voucher cannot exceed 100 — value is a percent, not a rate (10.00 = 10%)');
    }
    if (type === VoucherType.Fixed && maxDiscount !== null) {
      fail('maxDiscount caps a percentage voucher; on a fixed voucher `value` is already the cap');
    }
    if (maxDiscount !== null && compareMoney(maxDiscount, '0.00') <= 0) {
      fail('maxDiscount must be greater than zero when set');
    }
    // Plain string comparison is correct for `YYYY-MM-DD` — ISO dates sort
    // lexicographically, which is the same property `checkVoucher()` relies on.
    if (validUntil < validFrom) {
      fail('validUntil must not be earlier than validFrom');
    }
  }
}

/**
 * `VoucherRefusal` → `ErrorCode`, covering the two refusals that are not
 * `VoucherRejection` members. Everything else delegates to the exhaustive
 * switch, so a new shared rejection reason still fails to compile there.
 */
function refusalToErrorCode(
  reason: Parameters<typeof errorCodeForRejection>[0] | 'malformed' | 'offline_blocked',
): ErrorCode {
  // A code that cannot even be parsed into the `MC-XXXX-XXXX` shape is
  // reported as "not found" rather than as its own code: to the cashier the
  // two are the same event (this piece of paper is not a coupon we know), and
  // a distinct code would only add a message nobody can act on differently.
  if (reason === 'malformed') return 'ERR_VOUCHER_NOT_FOUND';
  if (reason === 'offline_blocked') return 'ERR_VOUCHER_OFFLINE_BLOCKED';
  return errorCodeForRejection(reason);
}

function mapBatch(row: VoucherBatchRow): VoucherBatchRes {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as VoucherType,
    value: row.value,
    minSubtotal: row.min_subtotal,
    maxDiscount: row.max_discount,
    // DATE columns — never `.toISOString()`. See `common/date-only.util.ts`.
    validFrom: formatDateOnly(row.valid_from),
    validUntil: formatDateOnly(row.valid_until),
    locationIds: row.location_ids,
    terms: row.terms,
    status: row.status as VoucherBatchStatus,
    voucherCount: row.voucher_count ? parseInt(row.voucher_count, 10) : 0,
    redeemedCount: row.redeemed_count ? parseInt(row.redeemed_count, 10) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVoucher(row: VoucherRow): VoucherRes {
  return {
    id: row.id,
    batchId: row.batch_id,
    code: row.code,
    status: row.status as VoucherStatus,
    issuedAt: row.issued_at,
    printedAt: row.printed_at,
  };
}
