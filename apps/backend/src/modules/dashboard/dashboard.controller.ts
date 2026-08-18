import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { businessDateOf } from '@mimi/shared';
import { DateRangeQueryDto } from './dto/date-range.query';
import { SingleDateQueryDto } from './dto/single-date.query';
import { TopProductsQueryDto } from './dto/top-products.query';
import { TrendQueryDto } from './dto/trend.query';
import { OverviewService, type OverviewResponse } from './services/overview.service';
import { OutletsService, type OutletDrilldown, type OutletTile } from './services/outlets.service';
import { TopProductsService, type TopProductRow } from './services/top-products.service';
import { StaffKpiService, type StaffKpiRow } from './services/staff-kpi.service';
import { TrendService, type TrendPoint } from './services/trend.service';
import { OpsStatusService, type OpsStatusResponse } from './services/ops-status.service';
import { MatviewRefreshService } from './matview-refresh.service';

/**
 * M18 `dashboard` — CONTRACTS.md §4.18. All reads; every dashboard query explicitly applies `req.locationScope` (matviews carry no RLS of their own — see ticket header / `scope.util.ts`).
 *
 * Controller path is `dashboard`, NOT `api/dashboard` — `main.ts` already
 * applies a global `api` prefix (`app.setGlobalPrefix('api', ...)`), so an
 * `api/` prefix here would have doubled up to the live route
 * `/api/api/dashboard/...`, silently diverging from CONTRACTS.md §4.18's
 * documented `/api/dashboard/...` paths (verified against the running
 * backend while wiring F03's frontend — every correctly-routed controller in
 * this codebase, e.g. `auth`, `accounting`, `inventory`, omits the prefix for
 * the same reason).
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly overview: OverviewService,
    private readonly outlets: OutletsService,
    private readonly topProducts: TopProductsService,
    private readonly staffKpi: StaffKpiService,
    private readonly trend: TrendService,
    private readonly opsStatus: OpsStatusService,
    private readonly matviewRefresh: MatviewRefreshService,
  ) {}

  @Get('overview')
  @RequirePermission('dashboard.view')
  async getOverview(
    @Req() req: RequestWithDbContext,
    @Query() query: DateRangeQueryDto,
  ): Promise<OverviewResponse> {
    return this.overview.getOverview(req.dbClient!, req.locationScope!, query.from, query.to);
  }

  @Get('outlets')
  @RequirePermission('dashboard.view')
  async listOutlets(
    @Req() req: RequestWithDbContext,
    @Query() query: SingleDateQueryDto,
  ): Promise<OutletTile[]> {
    const date = query.date ?? businessDateOf(new Date().toISOString());
    return this.outlets.listOutlets(req.dbClient!, req.locationScope!, date);
  }

  @Get('outlet/:locationId')
  @RequirePermission('dashboard.outlet.view')
  async getOutletDrilldown(
    @Req() req: RequestWithDbContext,
    @Param('locationId') locationId: string,
    @Query() query: SingleDateQueryDto,
  ): Promise<OutletDrilldown> {
    const date = query.date ?? businessDateOf(new Date().toISOString());
    return this.outlets.getOutletDrilldown(req.dbClient!, req.locationScope!, locationId, date);
  }

  @Get('top-products')
  @RequirePermission('dashboard.view')
  async getTopProducts(
    @Req() req: RequestWithDbContext,
    @Query() query: TopProductsQueryDto,
  ): Promise<TopProductRow[]> {
    return this.topProducts.getTopProducts(
      req.dbClient!,
      req.locationScope!,
      query.from,
      query.to,
      query.locationId,
      query.limit ?? 10,
    );
  }

  @Get('staff-kpi')
  @RequirePermission('dashboard.view')
  async getStaffKpi(
    @Req() req: RequestWithDbContext,
    @Query() query: DateRangeQueryDto,
  ): Promise<StaffKpiRow[]> {
    return this.staffKpi.getStaffKpi(
      req.dbClient!,
      req.locationScope!,
      query.from,
      query.to,
      query.locationId,
    );
  }

  @Get('trend')
  @RequirePermission('dashboard.view')
  async getTrend(
    @Req() req: RequestWithDbContext,
    @Query() query: TrendQueryDto,
  ): Promise<TrendPoint[]> {
    return this.trend.getTrend(
      req.dbClient!,
      req.locationScope!,
      query.metric,
      query.granularity,
      query.from,
      query.to,
      query.locationId,
    );
  }

  @Get('ops-status')
  @RequirePermission('dashboard.view')
  async getOpsStatus(@Req() req: RequestWithDbContext): Promise<OpsStatusResponse> {
    return this.opsStatus.getOpsStatus(req.dbClient!, req.locationScope!);
  }

  /**
   * The ticket's "expose a manual refresh path" requirement. No more precise
   * permission key exists for this in CONTRACTS.md §3 than `dashboard.view`
   * (checked: no `dashboard.refresh`/`dashboard.manage` key exists in the
   * 137-key matrix) — flagged in the ticket report rather than inventing a
   * new key (RBAC matrix is frozen, owned by the architect).
   */
  @Post('refresh')
  @RequirePermission('dashboard.view')
  async refresh(): Promise<{ view: string; ok: boolean; error?: string }[]> {
    return this.matviewRefresh.refreshAll();
  }
}
