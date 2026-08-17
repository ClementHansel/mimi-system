import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, payrollPeriodBoundaries, subMoney, sumMoney, type ISODate, type Money, type UUID } from '@mimi/shared';
import { assertLocationInScope } from '../scope.util';
import type { ReportCallerContext } from '../report.types';

export interface AttendanceDayEntry {
  date: ISODate;
  status: string | null;
  lateMinutes: number;
  overtimeMinutes: number;
}

export interface AttendanceMatrixRow {
  employeeId: UUID;
  employeeName: string;
  locationId: UUID;
  locationName: string;
  days: AttendanceDayEntry[];
}

export interface PayrollRegisterComponent {
  code: string;
  name: string;
  type: string;
  amount: Money;
}

export interface PayrollRegisterEmployeeRow {
  employeeId: UUID;
  employeeName: string;
  components: PayrollRegisterComponent[];
  grossEarnings: Money;
  totalDeductions: Money;
  netPay: Money;
}

export interface PayrollRegisterReport {
  runId: UUID;
  runNumber: string;
  periodCode: string;
  status: string;
  statutoryMode: boolean;
  totalGross: Money;
  totalDeductions: Money;
  totalNet: Money;
  employees: PayrollRegisterEmployeeRow[];
}

/**
 * `/api/reports/attendance` (FR-HR-03) and `/api/reports/payroll/:runId`
 * (FR-HR-04) — direct reads over `attendance`/`payroll_runs`+`payroll_lines`,
 * the same tables `hr/employees`/`hr/payroll` already own; this module never
 * writes either.
 */
@Injectable()
export class HrReportService {
  // ── GET /attendance — matrix per employee per day ───────────────────────
  async getAttendanceMatrix(
    client: PoolClient,
    caller: ReportCallerContext,
    filters: { periodCode: string; locationId?: string },
  ): Promise<AttendanceMatrixRow[]> {
    assertLocationInScope(caller.locationScope, filters.locationId);
    const { startDate, endDate } = payrollPeriodBoundaries(filters.periodCode);

    const empParams: unknown[] = [];
    let empWhere = `e.employment_status IN ('active','probation')`;
    if (filters.locationId) {
      empParams.push(filters.locationId);
      empWhere += ` AND e.location_id = $${empParams.length}`;
    } else if (caller.locationScope !== null) {
      empParams.push([...caller.locationScope]);
      empWhere += ` AND e.location_id = ANY($${empParams.length}::uuid[])`;
    }

    const empRes = await client.query<{ id: string; name: string; location_id: string; location_name: string }>(
      `SELECT e.id, e.name, e.location_id, l.name AS location_name
         FROM employees e
         JOIN locations l ON l.id = e.location_id
        WHERE ${empWhere}
        ORDER BY e.name ASC`,
      empParams,
    );
    if (empRes.rows.length === 0) return [];

    const employeeIds = empRes.rows.map((r) => r.id);
    const attRes = await client.query<{
      employee_id: string;
      date: string;
      status: string;
      late_minutes: number;
      overtime_minutes: number;
    }>(
      `SELECT employee_id, to_char(date, 'YYYY-MM-DD') AS date, status, late_minutes, overtime_minutes
         FROM attendance
        WHERE employee_id = ANY($1::uuid[]) AND date BETWEEN $2::date AND $3::date`,
      [employeeIds, startDate, endDate],
    );

    const byEmployee = new Map<string, Map<string, { status: string; lateMinutes: number; overtimeMinutes: number }>>();
    for (const r of attRes.rows) {
      const m = byEmployee.get(r.employee_id) ?? new Map();
      m.set(r.date, { status: r.status, lateMinutes: Number(r.late_minutes), overtimeMinutes: Number(r.overtime_minutes) });
      byEmployee.set(r.employee_id, m);
    }

    const dates: ISODate[] = [];
    for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    return empRes.rows.map((e) => {
      const attByDate = byEmployee.get(e.id) ?? new Map();
      return {
        employeeId: e.id,
        employeeName: e.name,
        locationId: e.location_id,
        locationName: e.location_name,
        days: dates.map((date) => {
          const entry = attByDate.get(date);
          return { date, status: entry?.status ?? null, lateMinutes: entry?.lateMinutes ?? 0, overtimeMinutes: entry?.overtimeMinutes ?? 0 };
        }),
      };
    });
  }

  // ── GET /payroll/:runId — register (all employees x components) ─────────
  async getPayrollRegister(client: PoolClient, _caller: ReportCallerContext, runId: UUID): Promise<PayrollRegisterReport> {
    const runRes = await client.query<{
      id: string;
      run_number: string;
      period_code: string;
      status: string;
      statutory_mode: boolean;
      total_gross: Money;
      total_deductions: Money;
      total_net: Money;
    }>(
      `SELECT r.id, r.run_number, p.period_code, r.status, r.statutory_mode, r.total_gross, r.total_deductions, r.total_net
         FROM payroll_runs r
         JOIN payroll_periods p ON p.id = r.period_id
        WHERE r.id = $1`,
      [runId],
    );
    const run = runRes.rows[0];
    if (!run) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Payroll run ${runId} not found` });

    // `payroll_runs` carries no `location_id` (it is a company-wide period, not scoped to one outlet/
    // warehouse) — HR reporting roles that hold `report.hr.read` (Owner, Manager, HR Admin, per
    // `packages/shared/src/rbac.ts`) are exactly the CENTRAL roles (`locationScope === null`), so
    // there is no scoped-role case to reject here; this is a deliberate no-branch, not an omission.

    const lineRes = await client.query<{
      employee_id: string;
      employee_name: string;
      code: string;
      component_name: string;
      component_type: string;
      amount: Money;
    }>(
      `SELECT pl.employee_id, e.name AS employee_name, sc.code, sc.name AS component_name, sc.type AS component_type, pl.amount
         FROM payroll_lines pl
         JOIN employees e ON e.id = pl.employee_id
         JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.run_id = $1
        ORDER BY e.name ASC, sc.sort_order ASC`,
      [runId],
    );

    const byEmployee = new Map<string, { employeeName: string; components: PayrollRegisterComponent[] }>();
    for (const r of lineRes.rows) {
      const bucket = byEmployee.get(r.employee_id) ?? { employeeName: r.employee_name, components: [] };
      bucket.components.push({ code: r.code, name: r.component_name, type: r.component_type, amount: r.amount });
      byEmployee.set(r.employee_id, bucket);
    }

    const employees: PayrollRegisterEmployeeRow[] = [...byEmployee.entries()].map(([employeeId, bucket]) => {
      const gross = this.sumByType(bucket.components, 'earning');
      const deductions = this.sumByType(bucket.components, 'deduction');
      const net = subMoney(gross, deductions);
      return {
        employeeId,
        employeeName: bucket.employeeName,
        components: bucket.components,
        grossEarnings: gross,
        totalDeductions: deductions,
        netPay: net,
      };
    });

    return {
      runId: run.id,
      runNumber: run.run_number,
      periodCode: run.period_code,
      status: run.status,
      statutoryMode: run.statutory_mode,
      totalGross: run.total_gross,
      totalDeductions: run.total_deductions,
      totalNet: run.total_net,
      employees,
    };
  }

  private sumByType(components: PayrollRegisterComponent[], type: string): Money {
    return sumMoney(components.filter((c) => c.type === type).map((c) => c.amount));
  }
}
