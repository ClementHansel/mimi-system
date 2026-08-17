/**
 * M23 `sync` admin/monitoring surface — CONTRACTS.md §4.23's `/api/sync/*`
 * rows (F12 topology + conflict/exception queues). User-JWT authenticated,
 * goes through the normal global guard chain (`JwtAuthGuard` ->
 * `RlsContextGuard` -> `PermissionsGuard`), unlike `kernel/sync`'s
 * device-token `/sync/v1/*` routes.
 */
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { ERR_LOCATION_OUT_OF_SCOPE } from '@mimi/shared';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ReconciliationService } from '../../kernel/sync/reconciliation.service';

function assertLocationInScope(req: RequestWithDbContext, locationId: string | undefined): void {
  if (!locationId) return;
  const scope = req.locationScope;
  if (scope !== null && scope !== undefined && !scope.includes(locationId)) {
    throw new BadRequestException({ code: ERR_LOCATION_OUT_OF_SCOPE, message: `locationId '${locationId}' is outside your assigned scope` });
  }
}

@Controller('sync')
export class SyncAdminController {
  constructor(
    private readonly conflicts: SyncConflictsRepository,
    private readonly reconciliation: ReconciliationService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @RequirePermission('sync.status.read')
  @Get('status')
  async status(@Req() req: RequestWithDbContext, @Query('locationId') locationId?: string) {
    assertLocationInScope(req, locationId);
    const scope = req.locationScope;
    const client = req.dbClient ?? this.pool;

    const locationsRes = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM locations
        WHERE ($1::uuid IS NULL OR id = $1) AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
        ORDER BY name`,
      [locationId ?? null, scope],
    );

    const results = [];
    for (const loc of locationsRes.rows) {
      const devicesRes = await client.query(
        `SELECT id AS "deviceId", name, queue_depth AS "queueDepth", last_sync_at AS "lastSyncAt", status
           FROM devices WHERE location_id = $1`,
        [loc.id],
      );
      const quarantineRes = await client.query<{ device_id: string; n: string }>(
        `SELECT origin_device_id AS device_id, COUNT(*)::text AS n FROM sync_events
          WHERE location_id = $1 AND apply_status = 'quarantined' GROUP BY origin_device_id`,
        [loc.id],
      );
      const quarantineByDevice = new Map(quarantineRes.rows.map((r) => [r.device_id, Number(r.n)]));
      const devices = devicesRes.rows.map((d) => ({
        ...d,
        quarantineDepth: quarantineByDevice.get(d.deviceId) ?? 0,
        cursorLag: 0, // see report note: exact per-device pull lag needs sync_cursors joined by device — left as a follow-up refinement
      }));

      const nodeRes = await client.query(`SELECT id AS "nodeId" FROM branch_nodes WHERE location_id = $1 LIMIT 1`, [loc.id]);
      const openConflicts = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sync_conflicts WHERE location_id = $1 AND queue = 'conflict' AND status = 'open'`,
        [loc.id],
      );
      const openExceptions = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sync_conflicts WHERE location_id = $1 AND queue IN ('exception', 'finance', 'hr') AND status = 'open'`,
        [loc.id],
      );

      results.push({
        locationId: loc.id,
        locationName: loc.name,
        devices,
        node: nodeRes.rows[0] ?? null,
        openConflicts: Number(openConflicts.rows[0]?.n ?? '0'),
        openExceptions: Number(openExceptions.rows[0]?.n ?? '0'),
      });
    }
    return results;
  }

  @RequirePermission('sync.status.read')
  @Get('conflicts')
  async listConflicts(
    @Req() req: RequestWithDbContext,
    @Query('kind') kind?: string,
    @Query('queue') queue?: string,
    @Query('status') status?: string,
    @Query('locationId') locationId?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    assertLocationInScope(req, locationId);
    const client = req.dbClient ?? this.pool;
    const locationIds = locationId ? [locationId] : req.locationScope;
    const { rows, total } = await this.conflicts.list(client, {
      kind,
      queue,
      status,
      locationIds,
      page: Number(page),
      pageSize: Number(pageSize),
    });
    return {
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        queue: r.queue,
        entity: r.entity,
        entityId: r.entity_id,
        locationId: r.location_id,
        winnerEventId: r.winner_event_id,
        loserEventId: r.loser_event_id,
        detail: r.detail,
        physicalEffectSuspected: r.physical_effect_suspected,
        status: r.status,
        createdAt: r.created_at,
        resolveInUrl: resolveInUrlFor(r.entity),
      })),
      total,
      page: Number(page),
      pageSize: Number(pageSize),
    };
  }

  @RequirePermission('sync.conflict.resolve')
  @Audited({ entityType: 'sync_conflict', action: 'sync.conflict.dismiss' })
  @Post('conflicts/:id/dismiss')
  async dismissConflict(@Req() req: RequestWithDbContext, @Param('id') id: string, @Body() body: { reason: string }) {
    if (!body?.reason) throw new BadRequestException({ code: 'ERR_REASON_REQUIRED', message: 'reason is required' });
    const client = req.dbClient ?? this.pool;

    // Entries whose kind requires resolution in the owning domain UI (C1 opname, C2 SJ receipt, C3
    // decision race) reject with ERR_RESOLVE_IN_DOMAIN per CONTRACTS.md §4.23 — that machine code is
    // NOT yet in packages/shared/src/error-codes.ts's closed union (flagged as a follow-up in the W2-D
    // report); used here as a literal string so the wire contract matches CONTRACTS exactly today.
    const DOMAIN_RESOLVED_KINDS = new Set(['double_count', 'duplicate_receipt', 'decision_race']);
    const existing = await client.query<{ kind: string }>(`SELECT kind FROM sync_conflicts WHERE id = $1`, [id]);
    if (existing.rows[0] && DOMAIN_RESOLVED_KINDS.has(existing.rows[0].kind)) {
      throw new BadRequestException({ code: 'ERR_RESOLVE_IN_DOMAIN', message: 'This conflict must be resolved in its owning domain screen, not dismissed here' });
    }

    const dismissed = await this.conflicts.dismiss(client, id, req.user!.sub, body.reason);
    if (!dismissed) throw new BadRequestException({ code: 'ERR_NOT_FOUND', message: 'Conflict not found or not open' });
    // BE-TXN-ROLLBACK: `RlsContextGuard` opens this request's transaction and
    // `RlsCleanupInterceptor` unconditionally rolls it back afterward — this
    // write must commit itself, exactly like `pos.controller.ts`'s
    // controller-commit convention (no service layer here to wrap instead).
    await client.query('COMMIT');
    return dismissed;
  }

  @RequirePermission('sync.status.read')
  @Get('reconciliations')
  async listReconciliations(
    @Req() req: RequestWithDbContext,
    @Query('status') status?: string,
    @Query('locationId') locationId?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    assertLocationInScope(req, locationId);
    const client = req.dbClient ?? this.pool;
    const locationIds = locationId ? [locationId] : req.locationScope;
    const offset = (Number(page) - 1) * Number(pageSize);
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (status) { conds.push(`sr.status = $${i++}`); args.push(status); }
    if (locationIds) { conds.push(`sr.location_id = ANY($${i++}::uuid[])`); args.push(locationIds); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await client.query(
      `SELECT sr.id, l.name AS "locationName", sa.name AS "storageAreaName", it.name AS "itemName",
              sr.tier, sr.expected_qty AS "expectedQty", sr.stored_qty AS "storedQty",
              sr.divergence, sr.status, sr.detected_at AS "detectedAt"
         FROM stock_reconciliations sr
         JOIN locations l ON l.id = sr.location_id
         LEFT JOIN storage_areas sa ON sa.id = sr.storage_area_id
         JOIN items it ON it.id = sr.item_id
         ${where}
        ORDER BY sr.detected_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...args, Number(pageSize), offset],
    );
    const count = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM stock_reconciliations sr ${where}`, args);
    return { rows: rows.rows, total: Number(count.rows[0]?.n ?? '0'), page: Number(page), pageSize: Number(pageSize) };
  }

  @RequirePermission('sync.conflict.resolve')
  @Audited({ entityType: 'stock_reconciliation', action: 'sync.reconciliation.resolve' })
  @Post('reconciliations/:id/resolve')
  async resolveReconciliation(
    @Req() req: RequestWithDbContext,
    @Param('id') id: string,
    @Body() body: { resolution: string; adjustmentId?: string },
  ) {
    if (!body?.resolution) throw new BadRequestException({ code: 'ERR_REASON_REQUIRED', message: 'resolution is required' });
    const client = req.dbClient ?? this.pool;
    const res = await client.query(
      `UPDATE stock_reconciliations
          SET status = 'resolved', resolved_by = $2, resolved_at = NOW(), resolution = $3
        WHERE id = $1 AND status = 'open'
        RETURNING *`,
      [id, req.user!.sub, body.adjustmentId ? `${body.resolution} (adjustment: ${body.adjustmentId})` : body.resolution],
    );
    if (!res.rows[0]) throw new BadRequestException({ code: 'ERR_NOT_FOUND', message: 'Reconciliation not found or not open' });
    // BE-TXN-ROLLBACK: same controller-commit convention as `dismissConflict`
    // above and `pos.controller.ts` — see that comment for why.
    await client.query('COMMIT');
    return res.rows[0];
  }

  @RequirePermission('sync.conflict.resolve')
  @Post('reconcile/:locationId')
  async triggerReconcile(@Req() req: RequestWithDbContext, @Param('locationId') locationId: string) {
    assertLocationInScope(req, locationId);
    const jobId = randomUUID();
    // Fire-and-continue: R1 is a straightforward SQL pass, cheap enough to run inline for one location;
    // a real job queue is out of this ticket's scope (no new dependency without W1-A, collision rule 2).
    const r1 = await this.reconciliation.runR1(locationId);
    return { jobId, started: true, r1 };
  }

  @RequirePermission('sync.status.read')
  @Get('events')
  async listEvents(
    @Req() req: RequestWithDbContext,
    @Query('originDeviceId') originDeviceId?: string,
    @Query('entity') entity?: string,
    @Query('applyStatus') applyStatus?: string,
    @Query('from') from?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    const client = req.dbClient ?? this.pool;
    const locationIds = req.locationScope;
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (originDeviceId) { conds.push(`origin_device_id = $${i++}`); args.push(originDeviceId); }
    if (entity) { conds.push(`entity = $${i++}`); args.push(entity); }
    if (applyStatus) { conds.push(`apply_status = $${i++}`); args.push(applyStatus); }
    if (from) { conds.push(`occurred_at >= $${i++}`); args.push(from); }
    if (locationIds) { conds.push(`(location_id IS NULL OR location_id = ANY($${i++}::uuid[]))`); args.push(locationIds); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (Number(page) - 1) * Number(pageSize);

    const rows = await client.query(
      `SELECT event_id, origin_tier, origin_device_id, location_id, entity, entity_id, op, client_seq,
              occurred_at, apply_status, reject_code, LEFT(payload::text, 500) AS payload_truncated
         FROM sync_events ${where} ORDER BY server_seq DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...args, Number(pageSize), offset],
    );
    const count = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM sync_events ${where}`, args);
    return { rows: rows.rows, total: Number(count.rows[0]?.n ?? '0'), page: Number(page), pageSize: Number(pageSize) };
  }
}

/** §5.4: "Resolution always happens in the owning domain UI... F12 links there." Best-effort route map. */
function resolveInUrlFor(entity: string): string {
  const routes: Record<string, string> = {
    stock_opname: '/outlet/stock-opname',
    sj_drops: '/warehouse/surat-jalan',
    void_refunds: '/pos/void-refunds',
    replenishment_requests: '/outlet/replenishment',
    waste_records: '/outlet/waste',
    attendance: '/hr/attendance',
    online_orders: '/pos/online-orders',
  };
  return routes[entity] ?? '/topology/conflicts';
}
