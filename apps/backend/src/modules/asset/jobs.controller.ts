import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Money, Paginated } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { AssetsService } from './assets.service';
import { CompleteJobDto, CreateJobDto, VerifyJobDto } from './dto/job.dto';
import { JobDto, JobsService } from './jobs.service';

/**
 * CONTRACTS.md §4.16 — job + service-history endpoints (FR-PMS-02/04).
 * Registered BEFORE `AssetsController` in `asset.module.ts` so this
 * controller's literal `GET jobs` route binds ahead of `AssetsController`'s
 * `GET :id` — both are single-segment under `api/assets`, and Nest/Express
 * resolves overlapping shapes in registration order (see
 * `schedules.controller.ts`'s header for the fuller note).
 */
@Controller('api/assets')
export class JobsController {
  constructor(
    private readonly service: JobsService,
    private readonly assets: AssetsService,
  ) {}

  @Get('jobs')
  @RequirePermission('asset.read')
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('assetId') assetId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Paginated<JobDto>> {
    return this.service.list(
      req.dbClient!,
      { locationId, status, assetId, page: page ? parseInt(page, 10) : undefined, pageSize: pageSize ? parseInt(pageSize, 10) : undefined },
      req.user!,
      req.locationScope ?? null,
    );
  }

  @Post(':id/jobs')
  @RequirePermission('asset.job.execute')
  @Audited({ module: 'asset', entityType: 'maintenance_jobs', action: 'asset.job.execute' })
  async create(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() dto: CreateJobDto): Promise<JobDto> {
    const assetLocationId = await this.assets.getAssetLocationId(req.dbClient!, id);
    return this.service.create(req.dbClient!, req.user!.sub, id, assetLocationId, dto, req.user!, req.locationScope ?? null);
  }

  @Post('jobs/:jobId/start')
  @RequirePermission('asset.job.execute')
  @Audited({ module: 'asset', entityType: 'maintenance_jobs', action: 'asset.job.execute' })
  async start(@Req() req: RequestWithDbContext, @Param('jobId') jobId: string): Promise<JobDto> {
    return this.service.start(req.dbClient!, jobId, req.user!, req.locationScope ?? null);
  }

  @Post('jobs/:jobId/complete')
  @RequirePermission('asset.job.execute')
  @Audited({ module: 'asset', entityType: 'maintenance_jobs', action: 'asset.job.execute' })
  async complete(@Req() req: RequestWithDbContext, @Param('jobId') jobId: string, @Body() dto: CompleteJobDto): Promise<JobDto> {
    return this.service.complete(req.dbClient!, req.user!.sub, jobId, dto, req.user!, req.locationScope ?? null);
  }

  @Post('jobs/:jobId/verify')
  @RequirePermission('asset.job.verify')
  @Audited({ module: 'asset', entityType: 'maintenance_jobs', action: 'asset.job.verify' })
  async verify(@Req() req: RequestWithDbContext, @Param('jobId') jobId: string, @Body() dto: VerifyJobDto): Promise<JobDto> {
    return this.service.verify(req.dbClient!, req.user!.sub, jobId, dto, req.user!, req.locationScope ?? null);
  }

  @Get(':id/history')
  @RequirePermission('asset.read')
  async history(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<
    Paginated<{
      serviceDate: string;
      description: string;
      vendor: string | null;
      cost: Money;
      conditionAfter: string;
      odometerKm: number | null;
      recordedBy: string;
      proofUrls: string[];
    }>
  > {
    const assetLocationId = await this.assets.getAssetLocationId(req.dbClient!, id);
    return this.service.history(
      req.dbClient!,
      assetLocationId,
      id,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
      req.user!,
      req.locationScope ?? null,
    );
  }
}
