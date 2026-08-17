import { Module } from '@nestjs/common';

import { ReportController } from './report.controller';
import { DeliveryReportService } from './services/delivery-report.service';
import { HrReportService } from './services/hr-report.service';
import { SalesReportService } from './services/sales-report.service';
import { ShiftReportService } from './services/shift-report.service';
import { StockReportService } from './services/stock-report.service';
import { WasteReportService } from './services/waste-report.service';

/**
 * M19 `report` — owned by Wave 4, agent W4-04 (senior-be).
 *
 * Exports, rekap pengiriman harian (FR-LOG-04), laporan shift
 * (CONTRACTS.md §4.19). Gated by `report.export`/`report.sales.read`/
 * `report.logistics.read`/`report.hr.read` — a report endpoint is a read
 * path over other modules' data, but still location-scoped via RLS like
 * everything else (§1.14) — never a bulk unscoped dump.
 *
 * No kernel imports: every service here runs exclusively on
 * `request.dbClient` (the per-request RLS-scoped `PoolClient`
 * `RlsContextGuard` already opened) — no `SyncEmitService`/`ApprovalService`/
 * `StockLedgerService` dependency, because nothing in this module ever
 * writes. `DATABASE_POOL` is never injected anywhere in this module either
 * (unlike `asset`/`dashboard`) — every report request is a real acting
 * user's request, never a background/cross-location job.
 */
@Module({
  controllers: [ReportController],
  providers: [SalesReportService, ShiftReportService, DeliveryReportService, StockReportService, WasteReportService, HrReportService],
})
export class ReportModule {}
