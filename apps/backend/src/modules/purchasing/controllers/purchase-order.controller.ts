import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  ApprovePurchaseOrderDto,
  CancelPurchaseOrderDto,
  CreatePoReceiptDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrderQueryDto,
  RejectPurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from '../dto/purchase-order.dto';
import { PurchaseOrderService } from '../purchase-order.service';
import type { ActorContext } from '../purchase-request.service';

/** M11 `purchasing` — purchase orders + receiving (CONTRACTS.md §4.11). */
@Controller('purchasing/orders')
export class PurchaseOrderController {
  constructor(private readonly service: PurchaseOrderService) {}

  @Get()
  @RequirePermission('purchasing.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListPurchaseOrderQueryDto) {
    return this.service.list(req.dbClient!, { ...query, page: query.page ?? 1, pageSize: query.pageSize ?? 50 });
  }

  @Get(':id')
  @RequirePermission('purchasing.read')
  getById(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('purchasing.po.create')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreatePurchaseOrderDto) {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  @Patch(':id')
  @RequirePermission('purchasing.po.create')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.create' })
  update(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.service.update(req.dbClient!, id, dto);
  }

  @Post(':id/submit')
  @RequirePermission('purchasing.po.create')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.create' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.submit(req.dbClient!, this.actor(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('purchasing.po.approve')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.approve' })
  approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApprovePurchaseOrderDto) {
    return this.service.approve(req.dbClient!, this.actor(req), id, dto.note);
  }

  @Post(':id/reject')
  @RequirePermission('purchasing.po.approve')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.approve' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectPurchaseOrderDto) {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto.reason);
  }

  @Post(':id/issue')
  @RequirePermission('purchasing.po.create')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.create' })
  issue(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.issue(req.dbClient!, id);
  }

  @Post(':id/receipts')
  @RequirePermission('purchasing.po.receive')
  @Audited({ entityType: 'po_receipt', action: 'purchasing.po.receive' })
  receive(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: CreatePoReceiptDto) {
    return this.service.receive(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/cancel')
  @RequirePermission('purchasing.po.approve')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.approve' })
  cancel(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: CancelPurchaseOrderDto) {
    return this.service.cancel(req.dbClient!, id, dto.reason);
  }

  @Post(':id/close')
  @RequirePermission('purchasing.po.close')
  @Audited({ entityType: 'purchase_order', action: 'purchasing.po.close' })
  close(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.close(req.dbClient!, id);
  }

  private actor(req: RequestWithDbContext): ActorContext {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationScope: req.locationScope ?? null };
  }
}
