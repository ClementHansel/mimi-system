import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Paginated } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { AssetsService, type AssetDto } from './assets.service';
import { CreateAssetDto, UpdateAssetDto } from './dto/asset.dto';
import type { JobDto } from './jobs.service';
import type { ScheduleDto } from './schedules.service';

/** CONTRACTS.md §4.16 — `/api/assets*` (asset register, FR-PMS-01). */
@Controller('assets')
export class AssetsController {
  constructor(private readonly service: AssetsService) {}

  @Get()
  @RequirePermission('asset.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('condition') condition?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<AssetDto>> {
    return this.service.list(
      req.dbClient!,
      {
        locationId,
        category,
        status,
        condition,
        q,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
      req.user!,
      req.locationScope ?? null,
    );
  }

  @Get(':id')
  @RequirePermission('asset.read')
  async getById(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
  ): Promise<AssetDto & { schedules: ScheduleDto[]; openJobs: JobDto[] }> {
    return this.service.getById(req.dbClient!, id, req.user!, req.locationScope ?? null);
  }

  @Post()
  @RequirePermission('asset.manage')
  @Audited({ module: 'asset', entityType: 'assets', action: 'asset.manage' })
  async create(@Req() req: RequestWithDbContext, @Body() dto: CreateAssetDto): Promise<AssetDto> {
    return this.service.create(
      req.dbClient!,
      req.user!.sub,
      dto,
      req.user!,
      req.locationScope ?? null,
    );
  }

  @Patch(':id')
  @RequirePermission('asset.manage')
  @Audited({ module: 'asset', entityType: 'assets', action: 'asset.manage' })
  async update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
  ): Promise<AssetDto> {
    return this.service.update(
      req.dbClient!,
      req.user!.sub,
      id,
      dto,
      req.user!,
      req.locationScope ?? null,
    );
  }
}
