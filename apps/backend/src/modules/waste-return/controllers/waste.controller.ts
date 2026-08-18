import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  ApproveWasteDto,
  CreateWasteDto,
  ListWasteQueryDto,
  RejectWasteDto,
} from '../dto/waste.dto';
import { WasteService, type ActorContext } from '../waste.service';

/** M12 `waste-return` — waste (CONTRACTS.md §4.12). */
@Controller('waste')
export class WasteController {
  constructor(private readonly service: WasteService) {}

  @Get()
  @RequirePermission('waste.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListWasteQueryDto) {
    return this.service.list(req.dbClient!, {
      ...query,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Post()
  @RequirePermission('waste.create')
  @Audited({ entityType: 'waste_record', action: 'waste.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreateWasteDto) {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  @Post(':batchId/approve')
  @RequirePermission('waste.approve')
  @Audited({ entityType: 'waste_record', action: 'waste.approve' })
  approve(
    @Req() req: RequestWithDbContext,
    @Param('batchId') batchId: string,
    @Body() dto: ApproveWasteDto,
  ) {
    return this.service.approve(req.dbClient!, this.actor(req), batchId, dto);
  }

  @Post(':batchId/reject')
  @RequirePermission('waste.approve')
  @Audited({ entityType: 'waste_record', action: 'waste.approve' })
  reject(
    @Req() req: RequestWithDbContext,
    @Param('batchId') batchId: string,
    @Body() dto: RejectWasteDto,
  ) {
    return this.service.reject(req.dbClient!, this.actor(req), batchId, dto);
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
