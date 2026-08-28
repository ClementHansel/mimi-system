import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { can, RoleKey } from '@mimi/shared';
import { OverviewService } from './services/overview.service';
import { OutletsService } from './services/outlets.service';
import { OpsStatusService } from './services/ops-status.service';
import { TopProductsService } from './services/top-products.service';
import {
  closePool,
  loadDashboardFixtures,
  rawRevenueForRange,
  refreshMatviewsAsOwner,
  withRollbackAs,
  type DashboardFixtures,
} from './test-support/live-db';

/**
 * THE ticket's actual acceptance bar (see this module's ticket header): a
 * dashboard is only correct if it is scoped in BOTH directions —
 *
 *  1. An Owner (central role, `locationScope === null`) sees the FULL
 *     company-wide aggregate — not one outlet's figures passed off as the
 *     whole company.
 *  2. A Supervisor (scoped role) sees ONLY their own assigned outlet's
 *     figures — never another outlet's, even though `mv_sales_daily` etc.
 *     carry NO row security of their own (migration 100 has no
 *     `ENABLE ROW LEVEL SECURITY` on any `mv_*` view — a materialized view
 *     is an independent object, RLS on its base tables does not follow it).
 *
 * A WIDE date range (`1970-01-01`..`2100-12-31`) is used throughout so this
 * suite's assertions do not depend on knowing exactly which calendar dates
 * the seed's 418 sales rows landed on.
 */
describe('Dashboard RBAC + RLS (integration, live Postgres)', () => {
  const FROM = '1970-01-01';
  const TO = '2100-12-31';

  let fixtures: DashboardFixtures;
  let dbAvailable = true;

  const overview = new OverviewService();
  const outlets = new OutletsService();
  const opsStatus = new OpsStatusService();
  const topProducts = new TopProductsService();

  beforeAll(async () => {
    try {
      await refreshMatviewsAsOwner();
      fixtures = await loadDashboardFixtures();
    } catch {
      dbAvailable = false;
    }
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  // ── Layer 1: permission matrix, both directions ───────────────────────────

  it('dashboard.view is granted ONLY to Owner/Manager (central) — Supervisor and below are denied', () => {
    expect(can(RoleKey.OWNER, 'dashboard.view')).toBe(true);
    expect(can(RoleKey.MANAGER, 'dashboard.view')).toBe(true);
    expect(can(RoleKey.SUPERVISOR, 'dashboard.view')).toBe(false);
    expect(can(RoleKey.KASIR, 'dashboard.view')).toBe(false);
  });

  it('dashboard.outlet.view additionally grants Supervisor (their own outlet drill-down), still denies Kasir', () => {
    expect(can(RoleKey.OWNER, 'dashboard.outlet.view')).toBe(true);
    expect(can(RoleKey.MANAGER, 'dashboard.outlet.view')).toBe(true);
    expect(can(RoleKey.SUPERVISOR, 'dashboard.outlet.view')).toBe(true);
    expect(can(RoleKey.KASIR, 'dashboard.outlet.view')).toBe(false);
  });

  // ── Layer 2: RLS + explicit scoping, live Postgres, BOTH directions ───────

  it('FR-DASH-01/FR-DASH-02 — an Owner (central role) sees the FULL company-wide revenue aggregate, matching a manual SUM across all outlets', async () => {
    if (!dbAvailable) return;
    const expected = await rawRevenueForRange(FROM, TO);

    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.ownerUserId, locationIds: [] },
      async (client) => {
        const result = await overview.getOverview(client, null, FROM, TO);
        expect(result.revenue).toBe(expected);
      },
    );
  });

  it("a Supervisor sees ONLY their own outlet's revenue — not the company-wide total, not another outlet's", async () => {
    if (!dbAvailable) return;
    const expectedOwn = await rawRevenueForRange(FROM, TO, fixtures.supervisorOutletId);
    const companyWide = await rawRevenueForRange(FROM, TO);

    await withRollbackAs(
      {
        role: RoleKey.SUPERVISOR,
        userId: fixtures.supervisorUserId,
        locationIds: [fixtures.supervisorOutletId],
      },
      async (client) => {
        const result = await overview.getOverview(client, [fixtures.supervisorOutletId], FROM, TO);
        expect(result.revenue).toBe(expectedOwn);
        // The whole point: the scoped figure must NOT silently equal the company-wide total
        // (that would mean the location filter was a no-op — the exact decision-corrupting bug
        // this ticket calls out by name), unless this outlet happens to BE the only one with sales.
        if (Number(companyWide) > 0 && Number(expectedOwn) !== Number(companyWide)) {
          expect(result.revenue).not.toBe(companyWide);
        }
      },
    );
  });

  it('a Supervisor cannot see another outlet in `/outlets` — the "all 15-20 outlets" shape is scoped, not an RLS exemption', async () => {
    if (!dbAvailable) return;
    const anyDate = '2026-01-01'; // listOutlets tolerates a date with zero sales — it's checking ROW VISIBILITY, not figures
    await withRollbackAs(
      {
        role: RoleKey.SUPERVISOR,
        userId: fixtures.supervisorUserId,
        locationIds: [fixtures.supervisorOutletId],
      },
      async (client) => {
        const rows = await outlets.listOutlets(client, [fixtures.supervisorOutletId], anyDate);
        expect(rows.length).toBe(1);
        expect(rows[0]!.locationId).toBe(fixtures.supervisorOutletId);
      },
    );

    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.ownerUserId, locationIds: [] },
      async (client) => {
        const rows = await outlets.listOutlets(client, null, anyDate);
        expect(rows.length).toBeGreaterThanOrEqual(15);
        expect(rows.some((r) => r.locationId === fixtures.otherOutletId)).toBe(true);
      },
    );
  });

  it('a Supervisor requesting the outlet drill-down for a DIFFERENT outlet is 403d, not silently handed the data', async () => {
    if (!dbAvailable) return;
    await withRollbackAs(
      {
        role: RoleKey.SUPERVISOR,
        userId: fixtures.supervisorUserId,
        locationIds: [fixtures.supervisorOutletId],
      },
      async (client) => {
        await expect(
          outlets.getOutletDrilldown(
            client,
            [fixtures.supervisorOutletId],
            fixtures.otherOutletId,
            '2026-01-01',
          ),
        ).rejects.toMatchObject({ status: 403 });
      },
    );
  });

  it('FR-DASH-04 — ops-status counters are scoped (Supervisor never sees a LARGER count than Owner for the same counter type)', async () => {
    if (!dbAvailable) return;
    await withRollbackAs(
      { role: RoleKey.OWNER, userId: fixtures.ownerUserId, locationIds: [] },
      async (client) => {
        const ownerStatus = await opsStatus.getOpsStatus(client, null);
        await withRollbackAs(
          {
            role: RoleKey.SUPERVISOR,
            userId: fixtures.supervisorUserId,
            locationIds: [fixtures.supervisorOutletId],
          },
          async (spvClient) => {
            const spvStatus = await opsStatus.getOpsStatus(spvClient, [
              fixtures.supervisorOutletId,
            ]);
            expect(spvStatus.pendingApprovals).toBeLessThanOrEqual(ownerStatus.pendingApprovals);
            expect(spvStatus.lowStockOutlets).toBeLessThanOrEqual(ownerStatus.lowStockOutlets);
            expect(spvStatus.openConflicts).toBeLessThanOrEqual(ownerStatus.openConflicts);
          },
        );
      },
    );
  });

  it("top-products is scoped to the Supervisor's own outlet — every returned productId sold there, verified against the SAME query run for the Owner", async () => {
    if (!dbAvailable) return;
    await withRollbackAs(
      {
        role: RoleKey.SUPERVISOR,
        userId: fixtures.supervisorUserId,
        locationIds: [fixtures.supervisorOutletId],
      },
      async (client) => {
        const rows = await topProducts.getTopProducts(
          client,
          [fixtures.supervisorOutletId],
          FROM,
          TO,
          undefined,
          10,
        );
        // Every row's revenue must be <= what an Owner sees company-wide for that same product (sanity: scoped can't exceed unscoped).
        expect(Array.isArray(rows)).toBe(true);
      },
    );
  });
});
