import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LocationScope } from '../../../common/scope/scope.service';
import { scopeClause } from '../scope.util';

export interface OpsStatusResponse {
  lowStockOutlets: number;
  sjInTransit: number;
  pendingApprovals: number;
  pendingPayments: number;
  offlineOutlets: number;
  openConflicts: number;
  coldChainBreaches24h: number;
  maintenanceDue: number;
}

/**
 * FR-DASH-04 — operational monitoring counters, each read from a LIVE table
 * (not a matview) per the ticket brief. Every count is scoped by
 * `locationScope` via `scopeClause` on that table's own location dimension —
 * see each private method's comment for which column that is.
 */
@Injectable()
export class OpsStatusService {
  async getOpsStatus(client: PoolClient, locationScope: LocationScope): Promise<OpsStatusResponse> {
    const [
      lowStockOutlets,
      sjInTransit,
      pendingApprovals,
      pendingPayments,
      offlineOutlets,
      openConflicts,
      coldChainBreaches24h,
      maintenanceDue,
    ] = await Promise.all([
      this.lowStockOutlets(client, locationScope),
      this.sjInTransit(client, locationScope),
      this.pendingApprovals(client, locationScope),
      this.pendingPayments(client, locationScope),
      this.offlineOutlets(client, locationScope),
      this.openConflicts(client, locationScope),
      this.coldChainBreaches24h(client, locationScope),
      this.maintenanceDue(client, locationScope),
    ]);

    return {
      lowStockOutlets,
      sjInTransit,
      pendingApprovals,
      pendingPayments,
      offlineOutlets,
      openConflicts,
      coldChainBreaches24h,
      maintenanceDue,
    };
  }

  /** Distinct locations with at least one active `min_stock_rules` row whose summed `stock_balances` is below `min_qty`. */
  private async lowStockOutlets(client: PoolClient, locationScope: LocationScope): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'msr.location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT msr.location_id) AS n
         FROM min_stock_rules msr
         JOIN (
           SELECT location_id, item_id, SUM(qty_on_hand) AS qty_on_hand
             FROM stock_balances GROUP BY location_id, item_id
         ) bal ON bal.location_id = msr.location_id AND bal.item_id = msr.item_id
        WHERE msr.is_active AND bal.qty_on_hand < msr.min_qty ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /**
   * Surat Jalan actually in transit, from the live `surat_jalan` table. The
   * ticket instructed that this counter must not come from
   * `mv_delivery_recap_daily`, which had no `location_id` grain at all; that
   * view has since been dropped outright (migration 261, D-21) for the related
   * reason that its counts could not be aggregated. Scoped by EITHER the
   * SJ's origin warehouse OR any of its drop outlets being in the caller's
   * scope, matching `ScopeService`'s own kepala-gudang/driver "origin UNION
   * destinations" scoping shape.
   */
  private async sjInTransit(client: PoolClient, locationScope: LocationScope): Promise<number> {
    if (locationScope === null) {
      const res = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM surat_jalan WHERE status = 'in_transit'`,
      );
      return parseInt(res.rows[0]!.n, 10);
    }
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT sj.id) AS n
         FROM surat_jalan sj
         LEFT JOIN sj_drops d ON d.sj_id = sj.id
        WHERE sj.status = 'in_transit'
          AND (sj.origin_location_id = ANY($1::uuid[]) OR d.location_id = ANY($1::uuid[]))`,
      [locationScope],
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /** `approvals.location_id` (nullable for company-wide document types) — a scoped caller sees only their own locations' pending approvals, never the location-less ones. */
  private async pendingApprovals(
    client: PoolClient,
    locationScope: LocationScope,
  ): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending' ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /** Same nullable-`location_id` shape as `approvals`. */
  private async pendingPayments(client: PoolClient, locationScope: LocationScope): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payment_verifications WHERE status = 'pending' ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /**
   * Locations whose most recent `outlet_offline`/`outlet_online`
   * `device_events` row is `outlet_offline` — the same edge the D-13
   * staleness sweep (`device-registry/staleness-sweep.service.ts`) writes,
   * read back here rather than re-deriving offline status from raw
   * device/node rows (single source of truth for "is this outlet currently
   * flagged offline").
   */
  private async offlineOutlets(client: PoolClient, locationScope: LocationScope): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM (
          SELECT DISTINCT ON (location_id) location_id, type
            FROM device_events
           WHERE location_id IS NOT NULL AND device_id IS NULL AND node_id IS NULL
             AND type IN ('outlet_offline', 'outlet_online') ${scope}
           ORDER BY location_id, created_at DESC
        ) latest
        WHERE latest.type = 'outlet_offline'`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  private async openConflicts(client: PoolClient, locationScope: LocationScope): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM sync_conflicts WHERE status = 'open' ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /** `sj_temperature_logs` has no `location_id` of its own — joined via the drop's outlet, falling back to the SJ's origin warehouse for load-stage (`drop_id IS NULL`) readings. */
  private async coldChainBreaches24h(
    client: PoolClient,
    locationScope: LocationScope,
  ): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(
      locationScope,
      'COALESCE(d.location_id, sj.origin_location_id)',
      params,
    );
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM sj_temperature_logs t
         JOIN surat_jalan sj ON sj.id = t.sj_id
         LEFT JOIN sj_drops d ON d.id = t.drop_id
        WHERE t.is_breach AND t.logged_at >= NOW() - INTERVAL '24 hours' ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }

  /** `maintenance_jobs.status = 'due'`, scoped via the job's `assets.location_id`. */
  private async maintenanceDue(client: PoolClient, locationScope: LocationScope): Promise<number> {
    const params: unknown[] = [];
    const scope = scopeClause(locationScope, 'a.location_id', params);
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM maintenance_jobs mj
         JOIN assets a ON a.id = mj.asset_id
        WHERE mj.status = 'due' ${scope}`,
      params,
    );
    return parseInt(res.rows[0]!.n, 10);
  }
}
