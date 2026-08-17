import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Opname, OpnameLine, Paginated } from '@mimi/shared';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../common/decorators';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { ApproveOpnameDto } from './dto/approve-opname.dto';
import { CreateOpnameDto } from './dto/create-opname.dto';
import { ListOpnameQueryDto } from './dto/list-opname.query';
import { RejectOpnameDto } from './dto/reject-opname.dto';
import { ResolveOpnameLineDto } from './dto/resolve-line.dto';
import { UpsertOpnameLinesDto } from './dto/upsert-lines.dto';
import { StockOpnameService, type ActorContext } from './stock-opname.service';

/**
 * M08 `stock-opname` HTTP surface (CONTRACTS.md §4.8). Every mutating route
 * carries `@RequirePermission` + `@Audited` + emits a sync event inside the
 * service (BUILD-PLAN §6 rule 6/collision rule template).
 */
@Controller('stock-opname')
export class StockOpnameController {
  constructor(private readonly service: StockOpnameService) {}

  @Get()
  @RequirePermission('opname.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListOpnameQueryDto): Promise<Paginated<Opname>> {
    return this.service.list(req.dbClient!, query);
  }

  @Get(':id')
  @RequirePermission('opname.read')
  detail(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<Opname & { lines: OpnameLine[] }> {
    return this.service.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('opname.create')
  @Audited({ entityType: 'stock_opname', action: 'opname.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateOpnameDto): Promise<Opname & { lines: OpnameLine[] }> {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  @Put(':id/lines')
  @RequirePermission('opname.create')
  @Audited({ entityType: 'stock_opname_lines', action: 'opname.lines.upsert' })
  upsertLines(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: UpsertOpnameLinesDto): Promise<OpnameLine[]> {
    return this.service.upsertLines(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/lines/:lineId/resolve')
  @RequirePermission('opname.approve')
  @Audited({ entityType: 'stock_opname_lines', action: 'opname.lines.resolve' })
  resolveLine(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: ResolveOpnameLineDto,
  ): Promise<OpnameLine> {
    return this.service.resolveLine(req.dbClient!, this.actor(req), id, lineId, dto);
  }

  @Post(':id/submit')
  @RequirePermission('opname.submit')
  @Audited({ entityType: 'stock_opname', action: 'opname.submit' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<Opname & { lines: OpnameLine[] }> {
    return this.service.submit(req.dbClient!, this.actor(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('opname.approve')
  @Audited({ entityType: 'stock_opname', action: 'opname.approve' })
  approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApproveOpnameDto): Promise<Opname & { lines: OpnameLine[] }> {
    return this.service.approve(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/reject')
  @RequirePermission('opname.approve')
  @Audited({ entityType: 'stock_opname', action: 'opname.reject' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectOpnameDto): Promise<Opname & { lines: OpnameLine[] }> {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto);
  }

  @Delete(':id')
  @RequirePermission('opname.create')
  @Audited({ entityType: 'stock_opname', action: 'opname.cancel' })
  cancel(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<{ id: string; status: string }> {
    return this.service.cancel(req.dbClient!, this.actor(req), id);
  }

  private actor(req: RequestWithDbContext): ActorContext {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationScope: req.locationScope ?? null };
  }
}
