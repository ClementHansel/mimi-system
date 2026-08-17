import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Audited, CurrentUser, RequirePermission } from '../../../common/decorators';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';
import { requireDbClient } from '../request-db-client';
import { SuratJalanService } from '../services/surat-jalan.service';
import { CreateSuratJalanDto, ListSuratJalanQueryDto, LoadSuratJalanDto, ReasonDto, UpdateSuratJalanDto } from '../dto/surat-jalan.dto';

/** M10 `delivery` — Surat Jalan lifecycle (CONTRACTS.md §4.10). */
@Controller('delivery/surat-jalan')
export class SuratJalanController {
  constructor(private readonly sj: SuratJalanService) {}

  @Get()
  @RequirePermission('delivery.read')
  list(@Req() req: Request, @Query() query: ListSuratJalanQueryDto) {
    return this.sj.list(requireDbClient(req), query);
  }

  @Get(':id')
  @RequirePermission('delivery.read')
  getById(@Req() req: Request, @Param('id') id: string) {
    return this.sj.getById(requireDbClient(req), id);
  }

  @Post()
  @RequirePermission('delivery.sj.create')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.create' })
  create(@Req() req: Request, @Body() dto: CreateSuratJalanDto, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.create(requireDbClient(req), dto, user.sub);
  }

  @Patch(':id')
  @RequirePermission('delivery.sj.create')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.create' })
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateSuratJalanDto, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.update(requireDbClient(req), id, dto, user.sub);
  }

  @Post(':id/ready')
  @RequirePermission('delivery.sj.create')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.create' })
  ready(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.ready(requireDbClient(req), id, user.sub);
  }

  @Post(':id/load')
  @RequirePermission('delivery.sj.dispatch')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.dispatch' })
  load(@Req() req: Request, @Param('id') id: string, @Body() dto: LoadSuratJalanDto, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.load(requireDbClient(req), id, dto, user.sub);
  }

  @Post(':id/dispatch')
  @RequirePermission('delivery.sj.dispatch')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.dispatch' })
  dispatch(@Req() req: Request, @Param('id') id: string, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.dispatch(requireDbClient(req), id, user.sub);
  }

  @Post(':id/cancel')
  @RequirePermission('delivery.sj.cancel')
  @Audited({ entityType: 'surat_jalan', action: 'delivery.sj.cancel' })
  cancel(@Req() req: Request, @Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() user: JwtAccessPayload) {
    return this.sj.cancel(requireDbClient(req), id, dto.reason, user.sub);
  }
}
