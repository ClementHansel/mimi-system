import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { RoleKey } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

import { AttendanceReportQueryDto } from './dto/attendance-report.query';
import { DeliveryDailyQueryDto } from './dto/delivery-daily.query';
import { FormatQueryDto } from './dto/format.query';
import { OnlineOrdersReportQueryDto } from './dto/online-orders-report.query';
import { SalesReportQueryDto } from './dto/sales-report.query';
import { StockMovementsQueryDto } from './dto/stock-movements.query';
import { StockUsageQueryDto } from './dto/stock-usage.query';
import { WasteReportQueryDto } from './dto/waste-report.query';

import { assertExportPermission, sendReportObject, sendReportRows } from './report-response.util';
import type { ReportCallerContext } from './report.types';

import { DeliveryReportService } from './services/delivery-report.service';
import { HrReportService } from './services/hr-report.service';
import { SalesReportService } from './services/sales-report.service';
import { ShiftReportService } from './services/shift-report.service';
import { StockReportService } from './services/stock-report.service';
import { WasteReportService } from './services/waste-report.service';

/**
 * M19 `report` — CONTRACTS.md §4.19. Every route below is a READ over other
 * modules' already-existing data (`request.dbClient`, the same RLS-scoped
 * `PoolClient` `RlsContextGuard` opens for every request — never
 * `DATABASE_POOL`, this module has no legitimate background/cross-location
 * path per the ticket).
 *
 * No `@Audited()` anywhere in this file, deliberately: that decorator is
 * for MUTATIONS (`@Audited({...})` writes an `audit_log` row keyed on what
 * changed), and every route here is a `@Get()` that changes nothing — same
 * omission rationale `inventory.controller.ts`'s read routes (`balances`,
 * `summary`, `movements`, ...) already follow without comment per route,
 * stated once here for the whole controller instead of repeated ten times.
 *
 * `format=csv|xlsx` needs the additional `report.export` permission
 * (CONTRACTS.md §4.19) — a PER-REQUEST decision keyed on `?format=`, so it
 * cannot live in a static `@RequirePermission()` the way the base
 * `report.sales.read`/`report.logistics.read`/`report.hr.read` keys do; see
 * `report-response.util.ts#assertExportPermission`, called explicitly in
 * every handler right after resolving `format`.
 */
@Controller('reports')
export class ReportController {
  constructor(
    private readonly salesReport: SalesReportService,
    private readonly shiftReport: ShiftReportService,
    private readonly deliveryReport: DeliveryReportService,
    private readonly stockReport: StockReportService,
    private readonly wasteReport: WasteReportService,
    private readonly hrReport: HrReportService,
  ) {}

  private callerOf(req: RequestWithDbContext): ReportCallerContext {
    const user = req.user!;
    return {
      userId: user.sub,
      roleKey: user.roleKey as RoleKey,
      locationScope: req.locationScope ?? null,
    };
  }

  // ── GET /sales ────────────────────────────────────────────────────────────
  @Get('sales')
  @RequirePermission('report.sales.read')
  async sales(
    @Req() req: RequestWithDbContext,
    @Query() query: SalesReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.salesReport.getSalesReport(req.dbClient!, caller, {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      groupBy: query.groupBy,
    });
    sendReportRows(res, query.format, 'sales-report', result.rows, {
      header: ['groupKey', 'groupLabel', 'txCount', 'gross', 'discount', 'platformFees', 'net'],
      toRow: (r) => [
        r.groupKey,
        r.groupLabel,
        r.txCount,
        r.gross,
        r.discount,
        r.platformFees,
        r.net,
      ],
    });
  }

  // ── GET /shift/:shiftId ──────────────────────────────────────────────────
  @Get('shift/:shiftId')
  @RequirePermission('report.sales.read')
  async shift(
    @Req() req: RequestWithDbContext,
    @Param('shiftId') shiftId: string,
    @Query() query: FormatQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.shiftReport.getShiftReport(req.dbClient!, caller, shiftId);
    // csv/xlsx export of a single-shift report is the SALES LIST (the tabular part); `format=json`
    // returns the full `{shift, report, sales}` object.
    sendReportObject(res, query.format, `shift-report-${shiftId}`, result, result.sales, {
      header: ['receiptNumber', 'status', 'subtotal', 'discount', 'total', 'occurredAt'],
      toRow: (r) => [r.receiptNumber, r.status, r.subtotal, r.discount, r.total, r.occurredAt],
    });
  }

  // ── GET /delivery-daily ──────────────────────────────────────────────────
  @Get('delivery-daily')
  @RequirePermission('report.logistics.read')
  async deliveryDaily(
    @Req() req: RequestWithDbContext,
    @Query() query: DeliveryDailyQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.deliveryReport.getDailyRecap(req.dbClient!, caller, query.date);
    // Flattened one-row-per-(city,item) for csv/xlsx — the nested `byCity[].items[]` json shape
    // has no single flat row rendering, so the export walks it into that grain, printable per FR-LOG-04.
    const flatRows = result.byCity.flatMap((city) => city.items.map((item) => ({ city, item })));
    sendReportObject(res, query.format, `delivery-recap-${query.date}`, result, flatRows, {
      header: ['city', 'outlets', 'itemId', 'itemName', 'qty'],
      toRow: (r) => [r.city.city, r.city.outlets, r.item.itemId, r.item.itemName, r.item.qty],
    });
  }

  // ── GET /stock-usage ─────────────────────────────────────────────────────
  @Get('stock-usage')
  @RequirePermission('report.logistics.read')
  async stockUsage(
    @Req() req: RequestWithDbContext,
    @Query() query: StockUsageQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const rows = await this.stockReport.getStockUsage(req.dbClient!, caller, {
      locationId: query.locationId,
      from: query.from,
      to: query.to,
    });
    sendReportRows(res, query.format, 'stock-usage', rows, {
      header: ['itemId', 'itemName', 'opening', 'in', 'usage', 'waste', 'adjustment', 'closing'],
      toRow: (r) => [
        r.itemId,
        r.itemName,
        r.opening,
        r.in,
        r.usage,
        r.waste,
        r.adjustment,
        r.closing,
      ],
    });
  }

  // ── GET /stock-movements ─────────────────────────────────────────────────
  @Get('stock-movements')
  @RequirePermission('report.logistics.read')
  async stockMovements(
    @Req() req: RequestWithDbContext,
    @Query() query: StockMovementsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.stockReport.getStockMovements(
      req.dbClient!,
      caller,
      {
        locationId: query.locationId,
        from: query.from,
        to: query.to,
        movementType: query.movementType,
      },
      1,
      // Exports (csv/xlsx) get the full window in one file, not one paginated page — a printable
      // export the reader can open in Excel is expected to be complete, matching the ticket's
      // "attachment" framing rather than the JSON API's normal pagination contract.
      query.format && query.format !== 'json' ? 100000 : 100,
    );
    sendReportRows(res, query.format, 'stock-movements', result.rows, {
      header: [
        'occurredAt',
        'locationName',
        'storageAreaName',
        'itemName',
        'movementType',
        'qty',
        'unitCost',
        'refType',
      ],
      toRow: (r) => [
        r.occurredAt,
        r.locationName,
        r.storageAreaName,
        r.itemName,
        r.movementType,
        r.qty,
        r.unitCost,
        r.refType,
      ],
    });
  }

  // ── GET /waste ───────────────────────────────────────────────────────────
  @Get('waste')
  @RequirePermission('report.sales.read')
  async waste(
    @Req() req: RequestWithDbContext,
    @Query() query: WasteReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const rows = await this.wasteReport.getWasteReport(req.dbClient!, caller, {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
    });
    sendReportRows(res, query.format, 'waste-report', rows, {
      header: ['locationName', 'reason', 'count', 'qty', 'value'],
      toRow: (r) => [r.locationName, r.reason, r.count, r.qty, r.value],
    });
  }

  // ── GET /attendance ──────────────────────────────────────────────────────
  @Get('attendance')
  @RequirePermission('report.hr.read')
  async attendance(
    @Req() req: RequestWithDbContext,
    @Query() query: AttendanceReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const rows = await this.hrReport.getAttendanceMatrix(req.dbClient!, caller, {
      periodCode: query.periodCode,
      locationId: query.locationId,
    });
    // Flattened one-row-per-(employee,day) for csv/xlsx — a matrix's natural flat-file rendering.
    const flatRows = rows.flatMap((emp) => emp.days.map((day) => ({ emp, day })));
    sendReportObject(res, query.format, `attendance-${query.periodCode}`, rows, flatRows, {
      header: ['employeeName', 'locationName', 'date', 'status', 'lateMinutes', 'overtimeMinutes'],
      toRow: (r) => [
        r.emp.employeeName,
        r.emp.locationName,
        r.day.date,
        r.day.status,
        r.day.lateMinutes,
        r.day.overtimeMinutes,
      ],
    });
  }

  // ── GET /payroll/:runId ──────────────────────────────────────────────────
  @Get('payroll/:runId')
  @RequirePermission('report.hr.read')
  async payroll(
    @Req() req: RequestWithDbContext,
    @Param('runId') runId: string,
    @Query() query: FormatQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.hrReport.getPayrollRegister(req.dbClient!, caller, runId);
    // Flattened one-row-per-(employee,component) for csv/xlsx.
    const flatRows = result.employees.flatMap((e) => e.components.map((c) => ({ e, c })));
    sendReportObject(res, query.format, `payroll-register-${runId}`, result, flatRows, {
      header: ['employeeName', 'componentCode', 'componentName', 'componentType', 'amount'],
      toRow: (r) => [r.e.employeeName, r.c.code, r.c.name, r.c.type, r.c.amount],
    });
  }

  // ── GET /opname/:opnameId ────────────────────────────────────────────────
  @Get('opname/:opnameId')
  @RequirePermission('report.logistics.read')
  async opname(
    @Req() req: RequestWithDbContext,
    @Param('opnameId') opnameId: string,
    @Query() query: FormatQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const result = await this.stockReport.getOpnameVariance(req.dbClient!, caller, opnameId);
    sendReportObject(res, query.format, `opname-variance-${opnameId}`, result, result.lines, {
      header: [
        'itemName',
        'storageAreaName',
        'systemQty',
        'countedQty',
        'diffQty',
        'varianceReason',
      ],
      toRow: (r) => [
        r.itemName,
        r.storageAreaName,
        r.systemQty,
        r.countedQty,
        r.diffQty,
        r.varianceReason,
      ],
    });
  }

  // ── GET /online-orders ───────────────────────────────────────────────────
  @Get('online-orders')
  @RequirePermission('report.sales.read')
  async onlineOrders(
    @Req() req: RequestWithDbContext,
    @Query() query: OnlineOrdersReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const caller = this.callerOf(req);
    assertExportPermission(caller.roleKey, query.format ?? 'json');
    const rows = await this.salesReport.getOnlineOrdersReport(req.dbClient!, caller, {
      from: query.from,
      to: query.to,
      platform: query.platform,
      locationId: query.locationId,
    });
    sendReportRows(res, query.format, 'online-orders-report', rows, {
      header: [
        'orderRef',
        'orderDate',
        'locationName',
        'platform',
        'grossAmount',
        'discountAmount',
        'platformFee',
        'otherFee',
        'netReceived',
        'status',
        'settlementStatus',
      ],
      toRow: (r) => [
        r.orderRef,
        r.orderDate,
        r.locationName,
        r.platform,
        r.grossAmount,
        r.discountAmount,
        r.platformFee,
        r.otherFee,
        r.netReceived,
        r.status,
        r.settlementStatus,
      ],
    });
  }
}
