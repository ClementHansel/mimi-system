import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { ReportController } from './report.controller';
import type { SalesReportService } from './services/sales-report.service';
import type { ShiftReportService } from './services/shift-report.service';
import type { DeliveryReportService } from './services/delivery-report.service';
import type { StockReportService } from './services/stock-report.service';
import type { WasteReportService } from './services/waste-report.service';
import type { HrReportService } from './services/hr-report.service';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import type { SalesReportQueryDto } from './dto/sales-report.query';

/**
 * WHAT THE CONTROLLER PUTS ON THE WIRE — the seam the Sales-tab crash lived in.
 *
 * `GET /api/reports/sales` returned a BARE ARRAY while the panel read
 * `res.rows`, so `rows` was `undefined`, `rows.map(...)` threw, and the owner's
 * dashboard answered "Application error: a client-side exception has occurred"
 * the moment anyone clicked Penjualan. It had never worked in production.
 *
 * NOTHING CAUGHT IT, and the reason matters for where this file sits:
 * `report.integration.spec.ts` exercises `SalesReportService`, which was
 * correct all along — it returns the full `SalesReportResult`. The controller
 * unwrapped it. A service test cannot see that, and neither can a type check,
 * because `res.json()` takes `any`. So the test has to be at the controller,
 * with the service stubbed, asserting the RESPONSE BODY — the same reasoning
 * as `supplier.controller.spec.ts` ("the argument handed across that boundary
 * IS the bug").
 *
 * There was also a warning about exactly this hazard sitting two files away,
 * in `report-api.ts`: "Guessing this wrong once already shipped a panel that
 * rendered 'no data' over 1,372 real rows."
 */

/** Captures whatever the handler sends, so the body can be asserted. */
function fakeResponse(): { res: Response; body: () => unknown } {
  let body: unknown;
  const res = {
    json: (value: unknown) => {
      body = value;
      return res;
    },
    // The non-JSON arm (csv/xlsx) sets headers and sends a buffer. Present so a
    // format change fails on a real assertion rather than on `undefined`.
    setHeader: () => res,
    send: (value: unknown) => {
      body = value;
      return res;
    },
  } as unknown as Response;
  return { res, body: () => body };
}

const SALES_RESULT = {
  groupBy: 'day' as const,
  from: '2026-08-26',
  to: '2026-09-01',
  rows: [
    {
      groupKey: '2026-08-26',
      groupLabel: '2026-08-26',
      txCount: 80,
      gross: '7632268.00',
      discount: '0.00',
      platformFees: '0.00',
      net: '7632268.00',
    },
  ],
};

function controllerWith(result: unknown): ReportController {
  const sales = {
    getSalesReport: () => Promise.resolve(result),
  } as unknown as SalesReportService;
  const unused = {} as never;
  return new ReportController(
    sales,
    unused as ShiftReportService,
    unused as DeliveryReportService,
    unused as StockReportService,
    unused as WasteReportService,
    unused as HrReportService,
  );
}

function ownerRequest(): RequestWithDbContext {
  return {
    user: { sub: 'u1', roleKey: 'owner' },
    locationScope: null,
    dbClient: {},
  } as unknown as RequestWithDbContext;
}

describe('ReportController.sales — the JSON envelope the dashboard reads', () => {
  it('sends the WHOLE SalesReportResult, not just its rows', async () => {
    const captured = fakeResponse();
    await controllerWith(SALES_RESULT).sales(
      ownerRequest(),
      { from: '2026-08-26', to: '2026-09-01', groupBy: 'day' } as SalesReportQueryDto,
      captured.res,
    );

    const body = captured.body() as Record<string, unknown>;

    // THE REGRESSION: an array here is what crashed the panel.
    expect(Array.isArray(body), 'the body is a bare array again — this is the crash').toBe(false);
    expect(body).toHaveProperty('rows');
    expect(Array.isArray(body.rows)).toBe(true);
    expect((body.rows as unknown[]).length).toBe(1);
  });

  it('carries the query context the panel echoes back to the reader', async () => {
    // `groupBy`/`from`/`to` are not decoration: the panel labels its own table
    // column from `groupBy` and shows the period it is displaying. Dropping
    // them would leave the screen unable to say what it is showing.
    const captured = fakeResponse();
    await controllerWith(SALES_RESULT).sales(
      ownerRequest(),
      { from: '2026-08-26', to: '2026-09-01', groupBy: 'day' } as SalesReportQueryDto,
      captured.res,
    );

    expect(captured.body()).toMatchObject({
      groupBy: 'day',
      from: '2026-08-26',
      to: '2026-09-01',
    });
  });

  it('an empty period still sends an envelope with an empty rows array', async () => {
    // The other half of the same bug class: a panel that reads `res.rows` must
    // get `[]`, never `undefined`, on a quiet week — otherwise "no sales" and
    // "we broke" look identical, and the crash comes back.
    const captured = fakeResponse();
    await controllerWith({ ...SALES_RESULT, rows: [] }).sales(
      ownerRequest(),
      { from: '2026-08-26', to: '2026-09-01', groupBy: 'day' } as SalesReportQueryDto,
      captured.res,
    );

    const body = captured.body() as Record<string, unknown>;
    expect(body.rows).toEqual([]);
  });
});
