import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Paginated, Replenishment, RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../common';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { CallerScope } from '../../kernel/approvals';
import { ApproveReplenishmentDto } from './dto/approve-replenishment.dto';
import { CreateReplenishmentDto } from './dto/create-replenishment.dto';
import { ListReplenishmentQueryDto } from './dto/list-replenishment.query';
import { RejectReplenishmentDto } from './dto/reject-replenishment.dto';
import { UpdateReplenishmentDto } from './dto/update-replenishment.dto';
import { WarehouseQueueQueryDto } from './dto/warehouse-queue.query';
import { ReplenishmentHistoryRow, ReplenishmentService } from './replenishment.service';

/**
 * `/api/replenishment/*` (CONTRACTS.md §4.9, FR-LOG-06..13). Every mutating
 * route: `@RequirePermission()` + `@Audited()` + a sync event (the last one
 * inside `ReplenishmentService`, per BUILD-PLAN §0/§6 rule 6).
 *
 * `approve`/`reject` accept EITHER chain step's permission key — CONTRACTS
 * §4.9's own row: "step 1: replenishment.approve.supervisor · step 2:
 * replenishment.approve.warehouse". `PermissionsGuard` only needs to know the
 * caller holds ONE of the two; `ApprovalService.decide()` (inside the
 * service) is what actually enforces WHICH step the caller may act on, by
 * checking their role against `approval_steps.approver_role` for the
 * document's CURRENT step — the same two-layer shape the RBAC matrix uses
 * everywhere else (coarse permission gate + fine-grained runtime check).
 */
@Controller('replenishment')
export class ReplenishmentController {
  constructor(private readonly service: ReplenishmentService) {}

  @Get('queue/warehouse')
  @RequirePermission('replenishment.approve.warehouse')
  warehouseQueue(@Req() req: RequestWithDbContext, @Query() query: WarehouseQueueQueryDto): Promise<Paginated<Replenishment>> {
    return this.service.warehouseQueue(req.dbClient!, query);
  }

  @Get()
  @RequirePermission('replenishment.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListReplenishmentQueryDto): Promise<Paginated<Replenishment>> {
    return this.service.list(req.dbClient!, query);
  }

  @Get(':id')
  @RequirePermission('replenishment.read')
  getById(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<Replenishment> {
    return this.service.getById(req.dbClient!, id);
  }

  @Get(':id/history')
  @RequirePermission('replenishment.read')
  history(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<ReplenishmentHistoryRow[]> {
    return this.service.getHistory(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('replenishment.create')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateReplenishmentDto): Promise<Replenishment> {
    return this.service.create(req.dbClient!, this.caller(req), dto);
  }

  @Patch(':id')
  @RequirePermission('replenishment.create')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.create' })
  update(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: UpdateReplenishmentDto): Promise<Replenishment> {
    return this.service.update(req.dbClient!, this.caller(req), id, dto);
  }

  @Delete(':id')
  @RequirePermission('replenishment.create')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.create' })
  remove(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<{ id: string; deleted: true }> {
    return this.service.remove(req.dbClient!, this.caller(req), id);
  }

  @Post(':id/submit')
  @RequirePermission('replenishment.submit')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.submit' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<Replenishment> {
    return this.service.submit(req.dbClient!, this.caller(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('replenishment.approve.supervisor', 'replenishment.approve.warehouse')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.approve' })
  approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApproveReplenishmentDto): Promise<Replenishment> {
    return this.service.approve(req.dbClient!, this.caller(req), id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('replenishment.approve.supervisor', 'replenishment.approve.warehouse')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.reject' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectReplenishmentDto): Promise<Replenishment> {
    return this.service.reject(req.dbClient!, this.caller(req), id, dto);
  }

  @Post(':id/process')
  @RequirePermission('replenishment.approve.warehouse')
  @Audited({ entityType: 'replenishment_request', action: 'replenishment.approve.warehouse' })
  process(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<Replenishment> {
    return this.service.process(req.dbClient!, this.caller(req), id);
  }

  private caller(req: RequestWithDbContext): CallerScope {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationIds: req.locationScope ?? null };
  }
}
