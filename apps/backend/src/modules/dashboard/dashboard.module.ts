import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardGateway } from './dashboard.gateway';
import { MatviewRefreshService } from './matview-refresh.service';
import { OverviewService } from './services/overview.service';
import { OutletsService } from './services/outlets.service';
import { TopProductsService } from './services/top-products.service';
import { StaffKpiService } from './services/staff-kpi.service';
import { TrendService } from './services/trend.service';
import { OpsStatusService } from './services/ops-status.service';

/**
 * M18 `dashboard` — owned by Wave 4, agent W4-04.
 *
 * FR-DASH-01..04: Owner/Manager KPI tiles, revenue/profit, top produk, KPI
 * pegawai, drill-down, realtime updates via socket.io (CONTRACTS.md §4.18).
 * Reads materialized rollups (`mv_sales_daily` etc., migration block
 * 100-109) rather than aggregating raw tables per request, EXCEPT where the
 * ticket brief explicitly calls for a live-table read (top-products,
 * staff-kpi's role/name join, ops-status) — see each service's own header.
 *
 * `ScopeService`/`TokenService`/`DATABASE_POOL` are all `@Global()` providers
 * (`common/scope`, `common/jwt/jwt-core.module.ts`,
 * `common/database/database.module.ts`) — no explicit imports needed here to
 * inject them into `DashboardGateway`/`MatviewRefreshService`. Likewise
 * `RlsContextGuard`/`PermissionsGuard`/`RlsCleanupInterceptor` are wired as
 * `APP_GUARD`/`APP_INTERCEPTOR` in `app.module.ts` (untouched by this
 * ticket) — every route below already runs behind them.
 */
@Module({
  controllers: [DashboardController],
  providers: [
    OverviewService,
    OutletsService,
    TopProductsService,
    StaffKpiService,
    TrendService,
    OpsStatusService,
    DashboardGateway,
    MatviewRefreshService,
  ],
})
export class DashboardModule {}
