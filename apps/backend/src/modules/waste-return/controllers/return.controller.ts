import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  ApproveReturnDto,
  CompleteReturnDto,
  CreateReturnDto,
  ListReturnQueryDto,
  ReceiveReturnDto,
  RejectReturnDto,
  ShipReturnDto,
} from '../dto/return.dto';
import { ReturnService, type ActorContext } from '../return.service';

/** M12 `waste-return` — retur (CONTRACTS.md §4.12, both directions). */
@Controller('returns')
export class ReturnController {
  constructor(private readonly service: ReturnService) {}

  @Get()
  @RequirePermission('return.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListReturnQueryDto) {
    return this.service.list(req.dbClient!, { ...query, page: query.page ?? 1, pageSize: query.pageSize ?? 50 });
  }

  @Get(':id')
  @RequirePermission('return.read')
  getById(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.getDetail(req.dbClient!, id);
  }

  @Post()
  @RequirePermission('return.create')
  @Audited({ entityType: 'return', action: 'return.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateReturnDto) {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  @Post(':id/submit')
  @RequirePermission('return.create')
  @Audited({ entityType: 'return', action: 'return.create' })
  submit(@Req() req: RequestWithDbContext, @Param('id') id: string) {
    return this.service.submit(req.dbClient!, this.actor(req), id);
  }

  @Post(':id/approve')
  @RequirePermission('return.approve')
  @Audited({ entityType: 'return', action: 'return.approve' })
  approve(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ApproveReturnDto) {
    return this.service.approve(req.dbClient!, this.actor(req), id, dto.note);
  }

  @Post(':id/reject')
  @RequirePermission('return.approve')
  @Audited({ entityType: 'return', action: 'return.approve' })
  reject(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: RejectReturnDto) {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto.reason);
  }

  @Post(':id/ship')
  @RequirePermission('return.ship')
  @Audited({ entityType: 'return', action: 'return.ship' })
  ship(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ShipReturnDto) {
    return this.service.ship(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/receive')
  @RequirePermission('return.receive')
  @Audited({ entityType: 'return', action: 'return.receive' })
  receive(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: ReceiveReturnDto) {
    return this.service.receive(req.dbClient!, this.actor(req), id, dto);
  }

  @Post(':id/complete')
  @RequirePermission('return.approve')
  @Audited({ entityType: 'return', action: 'return.approve' })
  complete(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: CompleteReturnDto) {
    return this.service.complete(req.dbClient!, id, dto);
  }

  private actor(req: RequestWithDbContext): ActorContext {
    const user = req.user!;
    return { userId: user.sub, roleKey: user.roleKey as RoleKey, locationScope: req.locationScope ?? null };
  }
}
