import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Money } from '@mimi/shared';
import type { LocationScope } from '../../../common/scope/scope.service';
import { assertLocationInScope, scopeClause } from '../scope.util';

export interface StaffKpiRow {
  employeeId: string;
  name: string;
  role: string;
  salesCount: number;
  salesAmount: Money;
  attendanceRate: string;
  lateCount: number;
}

/** FR-DASH-03 — KPI pegawai, from `mv_employee_kpi_daily` (one row per employee per attendance date). */
@Injectable()
export class StaffKpiService {
  async getStaffKpi(
    client: PoolClient,
    locationScope: LocationScope,
    from: string,
    to: string,
    locationId: string | undefined,
  ): Promise<StaffKpiRow[]> {
    assertLocationInScope(locationScope, locationId);

    const params: unknown[] = [from, to];
    let where = '';
    const scope = scopeClause(locationScope, 'k.location_id', params);
    if (locationId) {
      params.push(locationId);
      where = ` AND k.location_id = $${params.length}`;
    }

    const res = await client.query<{
      employee_id: string;
      name: string;
      role: string;
      sales_count: string;
      sales_amount: string;
      days_present: string;
      days_total: string;
      late_count: string;
    }>(
      `SELECT
          e.id AS employee_id, e.name, r.key AS role,
          COALESCE(SUM(k.sales_count), 0)::text AS sales_count,
          COALESCE(SUM(k.sales_amount), 0)::text AS sales_amount,
          COUNT(*) FILTER (WHERE k.kpi_date IS NOT NULL AND k.attendance_status = 'present')::text AS days_present,
          COUNT(*) FILTER (WHERE k.kpi_date IS NOT NULL)::text AS days_total,
          COUNT(*) FILTER (WHERE k.late_minutes > 0)::text AS late_count
        FROM mv_employee_kpi_daily k
        JOIN employees e ON e.id = k.employee_id
        LEFT JOIN users u ON u.id = e.user_id
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE (k.kpi_date IS NULL OR k.kpi_date BETWEEN $1 AND $2)
         ${scope}${where}
       GROUP BY e.id, e.name, r.key
       ORDER BY e.name`,
      params,
    );

    return res.rows.map((r) => {
      const daysTotal = parseInt(r.days_total, 10);
      const daysPresent = parseInt(r.days_present, 10);
      const attendanceRate = daysTotal > 0 ? ((daysPresent / daysTotal) * 100).toFixed(2) : '0.00';
      return {
        employeeId: r.employee_id,
        name: r.name,
        role: r.role ?? 'unknown',
        salesCount: parseInt(r.sales_count, 10),
        salesAmount: r.sales_amount as Money,
        attendanceRate,
        lateCount: parseInt(r.late_count, 10),
      };
    });
  }
}
