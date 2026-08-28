/**
 * `/api/vouchers/**` — voucher batches and the coupons inside them.
 *
 * PERMISSION SPLIT, and why it is four keys and not one:
 *   * `voucher.read`   — see batches and the codes in them. Reaches the outlet
 *     floor (a supervisor or kasir has to look a coupon up) but not the
 *     warehouse, HR, drivers or cooks, none of whom ever handle one.
 *   * `voucher.manage` — author, edit, close a batch; void a single coupon.
 *   * `voucher.issue`  — MINT. Separate from `manage` because minting a print
 *     run is minting bearer instruments; authoring a promotion is not.
 *   * `voucher.redeem` — take a coupon at the till. The one key that reaches a
 *     kasir, because it is the cashier's job.
 *
 * Every mutating route carries `@Audited` (CONTRACTS.md §0). Note that `check`
 * is a POST but is NOT audited and NOT mutating — it is a question with a
 * body, POSTed only because a basket subtotal and a location id do not belong
 * in a query string that ends up in access logs.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import type { Paginated } from '@mimi/shared';
import {
  VoucherService,
  type VoucherBatchRes,
  type VoucherCheckRes,
  type VoucherRes,
} from './voucher.service';
import {
  CheckVoucherDto,
  CreateBatchDto,
  IssueVouchersDto,
  ListBatchVouchersQueryDto,
  ListBatchesQueryDto,
  UpdateBatchDto,
} from './dto/voucher.dto';

@Controller('vouchers')
export class VoucherController {
  constructor(private readonly service: VoucherService) {}

  // ── batches ───────────────────────────────────────────────────────────────

  @Get('batches')
  @RequirePermission('voucher.read')
  listBatches(
    @Query() query: ListBatchesQueryDto,
    @Req() req: RequestWithDbContext,
  ): Promise<Paginated<VoucherBatchRes>> {
    return this.service.listBatches(req.dbClient!, query);
  }

  @Post('batches')
  @RequirePermission('voucher.manage')
  @Audited({ entityType: 'voucher_batch', action: 'voucher.manage' })
  @HttpCode(HttpStatus.CREATED)
  createBatch(
    @Body() dto: CreateBatchDto,
    @CurrentUser() caller: JwtAccessPayload,
    @Req() req: RequestWithDbContext,
  ): Promise<VoucherBatchRes> {
    return this.service.createBatch(req.dbClient!, dto, caller.sub);
  }

  @Get('batches/:id')
  @RequirePermission('voucher.read')
  getBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithDbContext,
  ): Promise<VoucherBatchRes> {
    return this.service.getBatch(req.dbClient!, id);
  }

  @Patch('batches/:id')
  @RequirePermission('voucher.manage')
  @Audited({ entityType: 'voucher_batch', action: 'voucher.manage' })
  updateBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBatchDto,
    @Req() req: RequestWithDbContext,
  ): Promise<VoucherBatchRes> {
    return this.service.updateBatch(req.dbClient!, id, dto);
  }

  /**
   * Mints coupons. `voucher.issue`, NOT `voucher.manage` — see the class
   * header. This is the endpoint that creates money.
   */
  @Post('batches/:id/issue')
  @RequirePermission('voucher.issue')
  @Audited({ entityType: 'voucher_batch', action: 'voucher.issue' })
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueVouchersDto,
    @Req() req: RequestWithDbContext,
  ): Promise<{ issued: number; batch: VoucherBatchRes }> {
    return this.service.issue(req.dbClient!, id, dto);
  }

  @Post('batches/:id/close')
  @RequirePermission('voucher.manage')
  @Audited({ entityType: 'voucher_batch', action: 'voucher.manage' })
  closeBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithDbContext,
  ): Promise<VoucherBatchRes> {
    return this.service.closeBatch(req.dbClient!, id);
  }

  @Get('batches/:id/vouchers')
  @RequirePermission('voucher.read')
  listBatchVouchers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListBatchVouchersQueryDto,
    @Req() req: RequestWithDbContext,
  ): Promise<Paginated<VoucherRes>> {
    return this.service.listBatchVouchers(req.dbClient!, id, query);
  }

  // ── the till ──────────────────────────────────────────────────────────────

  /**
   * "What is this code worth on this basket?" Returns HTTP 200 in BOTH the
   * accepted and the refused case — see `VoucherCheckRes`'s doc for why a
   * refusal is an answer rather than an error.
   *
   * `@HttpCode(OK)` because Nest defaults a POST to 201, and this creates
   * nothing.
   */
  @Post('check')
  @RequirePermission('voucher.redeem')
  @HttpCode(HttpStatus.OK)
  check(@Body() dto: CheckVoucherDto, @Req() req: RequestWithDbContext): Promise<VoucherCheckRes> {
    return this.service.check(req.dbClient!, dto);
  }

  @Post(':id/void')
  @RequirePermission('voucher.manage')
  @Audited({ entityType: 'voucher', action: 'voucher.void' })
  @HttpCode(HttpStatus.OK)
  voidVoucher(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithDbContext,
  ): Promise<VoucherRes> {
    return this.service.voidVoucher(req.dbClient!, id);
  }
}
