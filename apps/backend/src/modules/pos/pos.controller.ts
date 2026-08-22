import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  type CashVarianceProposal,
  type OnlineOrder,
  type Paginated,
  type RoleKey,
  type Sale,
  type Shift,
  type UUID,
  type VoidRefundStatus,
} from '@mimi/shared';
import { Audited, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { CatalogQueryDto, DailyStockQueryDto } from './dto/misc.dto';
import {
  CloseShiftDto,
  ListShiftsQueryDto,
  OpenShiftDto,
  ShiftsCurrentQueryDto,
} from './dto/shift.dto';
import { CreateSaleDto, ListSalesQueryDto } from './dto/sale.dto';
import {
  ApproveVoidDto,
  ListVoidRefundsQueryDto,
  RejectVoidDto,
  VoidRequestDto,
} from './dto/void-refund.dto';
import { CreateOnlineOrderDto, ListOnlineOrdersQueryDto } from './dto/online-order.dto';
import { CashVarianceDecisionDto, ListCashVariancesQueryDto } from './dto/cash-variance.dto';
import { PosCatalogService, type CatalogResponse } from './services/pos-catalog.service';
import { PosShiftService, type ShiftReport } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { PosVoidRefundService, type VoidRefundRow } from './services/pos-void-refund.service';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import { PosCashVarianceService } from './services/pos-cash-variance.service';
import { PosDailyStockService, type DailyStockRow } from './services/pos-daily-stock.service';

/**
 * M13 `pos` REST surface (CONTRACTS.md §4.13, FR-POS-01..07). Every mutating
 * route: `@RequirePermission()` + `@Audited()` (D-09's before/after diff
 * interceptor reads that metadata) +, where the entity's sync direction
 * allows it, a `SyncEmitService.emit()` call inside the service method
 * (`pos-void-refund.service.ts`) — see each service file's header for why
 * `sales`/`pos_shifts`/`online_orders` (class F, push-only) and
 * `cash_variance_proposals` (class X) do NOT emit one.
 *
 * Commit boundary: `RlsContextGuard` opens the request's transaction and
 * `RlsCleanupInterceptor` unconditionally rolls it back afterward (its own
 * header explains why) — every mutating action below issues the `COMMIT`
 * itself, once, after its service call returns successfully, so a thrown
 * exception anywhere in the call chain leaves nothing partially applied.
 */
@Controller('pos')
export class PosController {
  constructor(
    private readonly catalog: PosCatalogService,
    private readonly shifts: PosShiftService,
    private readonly sales: PosSaleService,
    private readonly voidRefunds: PosVoidRefundService,
    private readonly onlineOrders: PosOnlineOrderService,
    private readonly cashVariances: PosCashVarianceService,
    private readonly dailyStock: PosDailyStockService,
  ) {}

  // ── Catalog (FR-POS-01) ────────────────────────────────────────────────────

  @Get('catalog')
  @RequirePermission('pos.catalog.read')
  async getCatalog(
    @Req() req: RequestWithDbContext,
    @Query() _query: CatalogQueryDto,
  ): Promise<CatalogResponse> {
    return this.catalog.getCatalog(req.dbClient!);
  }

  // ── Shifts (FR-POS-02) ─────────────────────────────────────────────────────

  @Get('shifts/current')
  @RequirePermission('pos.shift.open')
  async getCurrentShift(
    @Req() req: RequestWithDbContext,
    @Query() query: ShiftsCurrentQueryDto,
  ): Promise<Shift | null> {
    return this.shifts.getCurrent(req.dbClient!, query.locationId, query.deviceId);
  }

  @Post('shifts/open')
  @RequirePermission('pos.shift.open')
  @Audited({ entityType: 'pos_shift', action: 'pos.shift.open' })
  async openShift(@Req() req: RequestWithDbContext, @Body() dto: OpenShiftDto): Promise<Shift> {
    const shift = await this.shifts.open(req.dbClient!, req.user!.sub, dto);
    await req.dbClient!.query('COMMIT');
    return shift;
  }

  @Post('shifts/:id/close')
  @RequirePermission('pos.shift.close')
  @Audited({ entityType: 'pos_shift', action: 'pos.shift.close' })
  async closeShift(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() dto: CloseShiftDto,
  ): Promise<Shift & { report: ShiftReport }> {
    const { shift, report } = await this.shifts.close(req.dbClient!, id, req.user!.sub, dto);
    await req.dbClient!.query('COMMIT');
    return { ...shift, report };
  }

  @Get('shifts')
  @RequirePermission('pos.sale.read')
  async listShifts(
    @Req() req: RequestWithDbContext,
    @Query() query: ListShiftsQueryDto,
  ): Promise<Paginated<Shift>> {
    return this.shifts.list(req.dbClient!, {
      locationId: query.locationId,
      date: query.date,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Get('shifts/:id/report')
  @RequirePermission('pos.sale.read')
  async getShiftReport(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
  ): Promise<ShiftReport> {
    return this.shifts.getReport(req.dbClient!, id);
  }

  // ── Sales (FR-POS-04/06) ───────────────────────────────────────────────────

  @Post('sales')
  @RequirePermission('pos.sale.create')
  @Audited({ entityType: 'sale', action: 'pos.sale.create' })
  async createSale(@Req() req: RequestWithDbContext, @Body() dto: CreateSaleDto): Promise<Sale> {
    const sale = await this.sales.create(req.dbClient!, req.user!.sub, dto, {
      roleKey: req.user!.roleKey,
      locationIds: req.locationScope ?? [],
    });
    await req.dbClient!.query('COMMIT');
    return sale;
  }

  @Get('sales')
  @RequirePermission('pos.sale.read')
  async listSales(
    @Req() req: RequestWithDbContext,
    @Query() query: ListSalesQueryDto,
  ): Promise<Paginated<Sale>> {
    return this.sales.list(req.dbClient!, {
      locationId: query.locationId,
      shiftId: query.shiftId,
      date: query.date,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Get('sales/:id')
  @RequirePermission('pos.sale.read')
  async getSale(@Req() req: RequestWithDbContext, @Param('id') id: UUID): Promise<Sale> {
    return this.sales.getById(req.dbClient!, id);
  }

  // ── Void / refund (FR-POS-03, APR-02, D-17) ───────────────────────────────

  @Post('sales/:id/void-request')
  @RequirePermission('pos.void.request')
  @Audited({ entityType: 'void_refund', action: 'pos.void.request' })
  async requestVoid(
    @Req() req: RequestWithDbContext,
    @Param('id') saleId: UUID,
    @Body() dto: VoidRequestDto,
  ): Promise<{ voidRefundId: UUID; status: 'pending' }> {
    const result = await this.voidRefunds.requestVoid(req.dbClient!, saleId, req.user!.sub, dto);
    await req.dbClient!.query('COMMIT');
    return result;
  }

  /**
   * B-15 — redeems the one-time code the approver issued, and commits their
   * decision.
   *
   * THE GUARD MOVED, AND THAT IS THE POINT: it was `pos.void.approve` (a key a
   * kasir does not hold), which forced the supervisor to log in at the register
   * and is why the unlimited `POST /auth/pin/verify` oracle existed as the
   * workaround. It is now `pos.void.request` — the person AT THE TILL, who
   * raised the void, is the one who types the code. Authority to approve is
   * carried by the code itself and verified in `ApprovalCodeService.redeem`,
   * which resolves the approver from the code row; it is never inferred from
   * this session. Per owner Q2, gating on the till role (rather than binding to
   * one named cashier) is deliberate: shifts get swapped and people call in
   * sick, and any cashier on that branch must be able to finish the sale.
   */
  @Post('void-refunds/:id/approve')
  @RequirePermission('pos.void.request')
  @Audited({ entityType: 'void_refund', action: 'pos.void.approve' })
  async approveVoid(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() dto: ApproveVoidDto,
  ): Promise<{ id: UUID; status: VoidRefundStatus; offlineAuthorized: boolean }> {
    const result = await this.voidRefunds.approve(req.dbClient!, id, req.user!.sub, dto.code);
    await req.dbClient!.query('COMMIT');
    return result;
  }

  @Post('void-refunds/:id/reject')
  @RequirePermission('pos.void.approve')
  @Audited({ entityType: 'void_refund', action: 'pos.void.approve' })
  async rejectVoid(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() dto: RejectVoidDto,
  ): Promise<{ id: UUID; status: 'rejected' }> {
    const result = await this.voidRefunds.reject(
      req.dbClient!,
      id,
      req.user!.sub,
      req.user!.roleKey as RoleKey,
      dto.reason,
    );
    await req.dbClient!.query('COMMIT');
    return result;
  }

  @Get('void-refunds')
  @RequirePermission('pos.sale.read')
  async listVoidRefunds(
    @Req() req: RequestWithDbContext,
    @Query() query: ListVoidRefundsQueryDto,
  ): Promise<Paginated<VoidRefundRow>> {
    return this.voidRefunds.list(req.dbClient!, {
      locationId: query.locationId,
      status: query.status,
      date: query.date,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  // ── GoFood / ShopeeFood (FR-POS-05/07) ─────────────────────────────────────

  @Post('online-orders')
  @RequirePermission('pos.online_order.record')
  @Audited({ entityType: 'online_order', action: 'pos.online_order.record' })
  async createOnlineOrder(
    @Req() req: RequestWithDbContext,
    @Body() dto: CreateOnlineOrderDto,
  ): Promise<OnlineOrder> {
    const order = await this.onlineOrders.create(req.dbClient!, req.user!.sub, dto);
    await req.dbClient!.query('COMMIT');
    return order;
  }

  @Get('online-orders')
  @RequirePermission('pos.online_order.read')
  async listOnlineOrders(
    @Req() req: RequestWithDbContext,
    @Query() query: ListOnlineOrdersQueryDto,
  ): Promise<Paginated<OnlineOrder>> {
    return this.onlineOrders.list(req.dbClient!, {
      locationId: query.locationId,
      platform: query.platform,
      from: query.from,
      to: query.to,
      settlement: query.settlement,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  // ── Daily stock (FR-POS-06) ────────────────────────────────────────────────

  @Get('daily-stock')
  @RequirePermission('pos.daily_stock.read')
  async getDailyStock(
    @Req() req: RequestWithDbContext,
    @Query() query: DailyStockQueryDto,
  ): Promise<DailyStockRow[]> {
    return this.dailyStock.getReport(req.dbClient!, query.locationId, query.date);
  }

  // ── Cash variance (D-19 / Amendment 2) ─────────────────────────────────────

  @Get('cash-variances')
  @RequirePermission('pos.cash_variance.read')
  async listCashVariances(
    @Req() req: RequestWithDbContext,
    @Query() query: ListCashVariancesQueryDto,
  ): Promise<Paginated<CashVarianceProposal>> {
    return this.cashVariances.list(req.dbClient!, {
      locationId: query.locationId,
      status: query.status,
      from: query.from,
      to: query.to,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Post('cash-variances/:id/approve')
  @RequirePermission('pos.cash_variance.approve')
  @Audited({ entityType: 'cash_variance_proposal', action: 'pos.cash_variance.approve' })
  async approveCashVariance(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() dto: CashVarianceDecisionDto,
  ): Promise<CashVarianceProposal> {
    const result = await this.cashVariances.approve(
      req.dbClient!,
      id,
      req.user!.sub,
      req.user!.roleKey as RoleKey,
      dto.reason,
    );
    await req.dbClient!.query('COMMIT');
    return result;
  }

  @Post('cash-variances/:id/reject')
  @RequirePermission('pos.cash_variance.approve')
  @Audited({ entityType: 'cash_variance_proposal', action: 'pos.cash_variance.approve' })
  async rejectCashVariance(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() dto: CashVarianceDecisionDto,
  ): Promise<CashVarianceProposal> {
    const result = await this.cashVariances.reject(
      req.dbClient!,
      id,
      req.user!.sub,
      req.user!.roleKey as RoleKey,
      dto.reason,
    );
    await req.dbClient!.query('COMMIT');
    return result;
  }
}
