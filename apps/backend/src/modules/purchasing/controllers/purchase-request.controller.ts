import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import { ApprovePurchaseRequestDto, CreatePurchaseRequestDto, ListPurchaseRequestQueryDto, RejectPurchaseRequestDto } from '../dto/purchase-request.dto';
import { PurchaseRequestService, type ActorContext } from '../purchase-request.service';

/** M11 `purchasing` — purchase requests (CONTRACTS.md §4.11). */
@Controller('purchasing/requests')
export class PurchaseRequestController {
  constructor(private readonly service: PurchaseRequestService) {}

  @Get()
  @RequirePermission('purchasing.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListPurchaseRequestQueryDto) {
    return this.service.list(req.dbClient!, { ...query, page: query.page ?? 1, pageSize: query.pageSize ?? 50 });
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

  @Post(':id/submit')
  @RequirePermission('purchasing.pr.create')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.create' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.submit(req.dbClient!, this.actor(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('purchasing.pr.approve')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.approve' })
  approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApprovePurchaseRequestDto) {
    return this.service.approve(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('purchasing.pr.approve')
  @Audited({ entityType: 'purchase_request', action: 'purchasing.pr.approve' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectPurchaseRequestDto) {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto);
  }

  private actor(req: RequestWithDbContext): ActorContext {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationScope: req.locationScope ?? null };
  }
}
