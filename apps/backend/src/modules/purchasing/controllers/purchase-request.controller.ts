import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  ApprovePurchaseRequestDto,
  CreatePurchaseRequestDto,
  CreatePurchaseRequestFromReplenishmentDto,
  ListPurchaseRequestQueryDto,
  RejectPurchaseRequestDto,
  UpdatePurchaseRequestDto,
} from '../dto/purchase-request.dto';
import { PurchaseRequestService, type ActorContext } from '../purchase-request.service';

/** M11 `purchasing` — purchase requests (CONTRACTS.md §4.11). */
@Controller('purchasing/requests')
export class PurchaseRequestController {
  constructor(private readonly service: PurchaseRequestService) {}

  @Get()
  @RequirePermission('purchasing.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListPurchaseRequestQueryDto) {
    return this.service.list(req.dbClient!, {
      ...query,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Get(':id')
  @RequirePermission('purchasing.read')
  getById(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('purchasing.pr.create')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreatePurchaseRequestDto) {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  /**
   * The PR's audit trail — who created it, who edited it, who approved or
   * rejected it, each with a timestamp (owner, 2026-08-21). Read permission,
   * not write: anyone who may see the PR may see what happened to it.
   */
  @Get(':id/history')
  @RequirePermission('purchasing.read')
  history(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getHistory(req.dbClient!, id);
  }

  /**
   * Edit a draft or rejected PR. `@Audited` is what makes the edit show up in
   * `:id/history` with its before/after values — the endpoint and the trail are
   * the same feature, so neither ships without the other.
   */
  @Patch(':id')
  @RequirePermission('purchasing.pr.create')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.update' })
  update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseRequestDto,
  ) {
    return this.service.update(req.dbClient!, this.actor(req), id, dto);
  }

  /** Convert an outlet's replenishment request into a draft PR. */
  @Post('from-replenishment')
  @RequirePermission('purchasing.pr.create')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.create' })
  createFromReplenishment(
    @Req() req: RequestWithDbContext,
    @Body() dto: CreatePurchaseRequestFromReplenishmentDto,
  ) {
    return this.service.createFromReplenishment(req.dbClient!, this.actor(req), dto);
  }

  @Post(':id/submit')
  @RequirePermission('purchasing.pr.create')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.create' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.submit(req.dbClient!, this.actor(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('purchasing.pr.approve')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.approve' })
  approve(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: ApprovePurchaseRequestDto,
  ) {
    return this.service.approve(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('purchasing.pr.approve')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.approve' })
  reject(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: RejectPurchaseRequestDto,
  ) {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto);
  }

  private actor(req: RequestWithDbContext): ActorContext {
    const user = req.user!;
    return {
      userId: user.sub,
      roleKey: user.roleKey as RoleKey,
      locationScope: req.locationScope ?? null,
    };
  }
}
