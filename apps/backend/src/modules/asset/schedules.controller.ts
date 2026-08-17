import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { AssetsService } from './assets.service';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { DueItem, ScheduleDto, SchedulesService } from './schedules.service';

/**
 * CONTRACTS.md §4.16 — schedule endpoints (FR-PMS-02/03). Registered BEFORE
 * `AssetsController` in `asset.module.ts`'s `controllers` array so this
 * controller's literal `maintenance/due` and `schedules/:scheduleId` routes
 * bind onto the router ahead of `AssetsController`'s single-segment
 * `GET/PATCH :id` — Nest/Express matches overlapping route shapes in
 * REGISTRATION order, and `maintenance/due`'s two segments never actually
 * collide with `:id`'s one, but `schedules/:scheduleId` living under the
 * SAME `assets` prefix as `AssetsController` still means order is the
 * only thing keeping this predictable if either controller's shape ever
 * changes — flagged here rather than left as an implicit assumption.
 */
@Controller('assets')
export class SchedulesController {
  constructor(
    private readonly service: SchedulesService,
    private readonly assets: AssetsService,
  ) {}

  @Get(':id/schedules')
  @RequirePermission('asset.read')
  async list(@Req() req: RequestWithDbContext, @Param('id') id: string): Promise<ScheduleDto[]> {
    const assetLocationId = await this.assets.getAssetLocationId(req.dbClient!, id);
    return this.service.listForAsset(req.dbClient!, assetLocationId, id, req.user!, req.locationScope ?? null);
  }

  @Post(':id/schedules')
  @RequirePermission('asset.schedule.manage')
  @Audited({ module: 'asset', entityType: 'maintenance_schedules', action: 'asset.schedule.manage' })
  async create(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: CreateScheduleDto,
  ): Promise<ScheduleDto> {
    const assetLocationId = await this.assets.getAssetLocationId(req.dbClient!, id);
    return this.service.create(req.dbClient!, req.user!.sub, assetLocationId, id, dto, req.user!, req.locationScope ?? null);
  }

  @Patch('schedules/:scheduleId')
  @RequirePermission('asset.schedule.manage')
  @Audited({ module: 'asset', entityType: 'maintenance_schedules', action: 'asset.schedule.manage' })
  async update(
    @Req() req: RequestWithDbContext,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: UpdateScheduleDto,
  ): Promise<ScheduleDto> {
    return this.service.update(
      req.dbClient!,
      req.user!.sub,
      scheduleId,
      dto,
      (assetId) => this.assets.getAssetLocationId(req.dbClient!, assetId),
      req.user!,
      req.locationScope ?? null,
    );
  }

  @Get('maintenance/due')
  @RequirePermission('asset.read')
  async due(
    @Req() req: RequestWithDbContext,
    @Query('windowDays') windowDays?: string,
    @Query('locationId') locationId?: string,
  ): Promise<DueItem[]> {
    return this.service.due(
      req.dbClient!,
      windowDays ? parseInt(windowDays, 10) : 30,
      locationId,
      req.user!,
      req.locationScope ?? null,
    );
  }
}
