import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import type { Paginated } from '@mimi/shared';

export interface AuditQuery {
  entityType?: string;
  entityId?: string;
  userId?: string;
  module?: string;
  locationId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** CONTRACTS.md §4.0 `GET /api/audit` response row shape. */
export interface AuditRow {
  id: string;
  userId: string | null;
  userName: string | null;
  roleKey: string | null;
  module: string;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  offlineAuthorized: boolean;
  occurredAt: string;
}

/**
 * Read side of the audit kernel — backs `GET /api/audit` (F10 audit trail
 * viewer, FR-AUDIT-01/02). `AuditInterceptor` is the only writer; this
 * service never inserts, matching D-09 (audit_log is append-only by
 * construction — UPDATE/DELETE are revoked from `app_user` at the grant
 * level, migration 009).
 *
 * Runs on the CALLER's `request.dbClient` (passed in), so `audit_log_select`
 * RLS (owner/manager/finance only, migration 009) applies exactly as it does
 * for any other read in this codebase — no separate authorization logic
 * needed here beyond the controller's `@RequirePermission('audit.read')`.
 */
@Injectable()
export class AuditService {
  async query(client: PoolClient, filters: AuditQuery): Promise<Paginated<AuditRow>> {
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize =
      filters.pageSize && filters.pageSize > 0 ? Math.min(filters.pageSize, 200) : 50;

    const conditions: string[] = [];
    const params: unknown[] = [];

    const push = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('$$', `$${params.length}`));
    };

    if (filters.entityType) push('a.entity_type = $$', filters.entityType);
    if (filters.entityId) push('a.entity_id = $$', filters.entityId);
    if (filters.userId) push('a.user_id = $$', filters.userId);
    if (filters.module) push('a.module = $$', filters.module);
    if (filters.locationId) push('a.location_id = $$', filters.locationId);
    if (filters.from) push('a.occurred_at >= $$', filters.from);
    if (filters.to) push('a.occurred_at <= $$', filters.to);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log a ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rowsResult = await client.query(
      `SELECT a.id, a.user_id, u.name AS user_name, a.role_key, a.location_id, a.module, a.action,
              a.entity_type, a.entity_id, a.before_value, a.after_value, a.reason,
              a.offline_authorized, a.occurred_at
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ${where}
         ORDER BY a.occurred_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const rows: AuditRow[] = rowsResult.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      roleKey: r.role_key,
      module: r.module,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      beforeValue: r.before_value,
      afterValue: r.after_value,
      reason: r.reason,
      offlineAuthorized: r.offline_authorized,
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    }));

    return { rows, total, page, pageSize };
  }
}
