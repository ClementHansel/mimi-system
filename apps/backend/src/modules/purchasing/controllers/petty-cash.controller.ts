import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RoleKey } from '@mimi/shared';
import { Audited, RequirePermission } from '../../../common/decorators';
import type { RequestWithDbContext } from '../../../common/guards/rls-context.guard';
import {
  CreatePettyCashDto,
  ListPettyCashQueryDto,
  RejectPettyCashDto,
  VerifyPettyCashDto,
} from '../dto/petty-cash.dto';
import { PettyCashService } from '../petty-cash.service';
import type { ActorContext } from '../purchase-request.service';

/** M11 `purchasing` — petty cash (CONTRACTS.md §4.11, PRD 8.6.1). */
@Controller('purchasing/petty-cash')
export class PettyCashController {
  constructor(private readonly service: PettyCashService) {}

  @Get()
  @RequirePermission('pettycash.read')
  list(@Req() req: RequestWithDbContext, @Query() query: ListPettyCashQueryDto) {
    return this.service.list(req.dbClient!, {
      ...query,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
    });
  }

  @Post()
  @RequirePermission('pettycash.create')
  @Audited({ entityType: 'petty_cash', action: 'pettycash.create' })
  create(@Req() req: RequestWithDbContext, @Body() dto: CreatePettyCashDto) {
    return this.service.create(req.dbClient!, this.actor(req), dto);
  }

  @Post(':id/verify')
  @RequirePermission('pettycash.verify')
  @Audited({ entityType: 'petty_cash', action: 'pettycash.verify' })
  verify(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: VerifyPettyCashDto,
  ) {
    return this.service.verify(req.dbClient!, this.actor(req), id, dto.note);
  }

  @Post(':id/reject')
  @RequirePermission('pettycash.verify')
  @Audited({ entityType: 'petty_cash', action: 'pettycash.verify' })
  reject(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: RejectPettyCashDto,
  ) {
    return this.service.reject(req.dbClient!, this.actor(req), id, dto.reason);
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
