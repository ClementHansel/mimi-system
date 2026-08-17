import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../common/decorators';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { requireDbClient } from './request-db-client';
import { UnitService } from './unit.service';
import { CreateUnitDto } from './dto/item.dto';

/** `units` — CONTRACTS.md §4.4 (top-level path, distinct from `/api/items`). */
@Controller('units')
export class UnitController {
  constructor(private readonly units: UnitService) {}

  @Get()
  @RequirePermission('item.read')
  list(@Req() req: Request) {
    return this.units.listUnits(requireDbClient(req));
  }

  @Post()
  @RequirePermission('unit.manage')
  @Audited({ entityType: 'unit', action: 'unit.manage' })
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: Request, @Body() dto: CreateUnitDto, @CurrentUser() user: JwtAccessPayload) {
    return this.units.createUnit(requireDbClient(req), dto, user.sub);
  }
}
