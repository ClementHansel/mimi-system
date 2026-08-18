import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { RoleKey } from '@mimi/shared';
import { Audited, CurrentUser, RequirePermission } from '../../../common/decorators';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { requireDbClient } from '../request-db-client';
import { DropService } from '../services/drop.service';
import { ArriveDropDto, DepartDropDto, FailDropDto, ReceiveDropDto } from '../dto/drop.dto';

/** M10 `delivery` — per-drop driver/outlet actions (CONTRACTS.md §4.10). */
@Controller('delivery/drops')
export class DropController {
  constructor(private readonly drops: DropService) {}

  @Post(':dropId/depart')
  @RequirePermission('delivery.drop.execute')
  @Audited({ entityType: 'sj_drop', action: 'delivery.drop.execute' })
  depart(
    @Req() req: Request,
    @Param('dropId') dropId: string,
    @Body() dto: DepartDropDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.drops.depart(requireDbClient(req), dropId, dto, user.sub);
  }

  @Post(':dropId/arrive')
  @RequirePermission('delivery.drop.execute')
  @Audited({ entityType: 'sj_drop', action: 'delivery.drop.execute' })
  arrive(
    @Req() req: Request,
    @Param('dropId') dropId: string,
    @Body() dto: ArriveDropDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.drops.arrive(requireDbClient(req), dropId, dto, user.sub);
  }

  @Post(':dropId/receive')
  @RequirePermission('delivery.receive')
  @Audited({ entityType: 'sj_drop', action: 'delivery.receive' })
  receive(
    @Req() req: Request,
    @Param('dropId') dropId: string,
    @Body() dto: ReceiveDropDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.drops.receive(requireDbClient(req), dropId, dto, user.sub, user.roleKey as RoleKey);
  }

  @Post(':dropId/fail')
  @RequirePermission('delivery.drop.execute')
  @Audited({ entityType: 'sj_drop', action: 'delivery.drop.execute' })
  fail(
    @Req() req: Request,
    @Param('dropId') dropId: string,
    @Body() dto: FailDropDto,
    @CurrentUser() user: JwtAccessPayload,
  ) {
    return this.drops.fail(requireDbClient(req), dropId, dto, user.sub);
  }
}
