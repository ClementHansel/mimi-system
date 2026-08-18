import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  clampMoneyToZero,
  DocumentPrefix,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  formatCloudDocNumber,
  JournalSystemEventType,
  PayrollComponentCode,
  splitMoneyEvenly,
  subMoney,
  sumMoney,
  ZERO_MONEY,
  calculateBasePayslip,
  calculatePayroll,
  loanInstallment,
  type ApprovalDetail,
  type BasePayrollInputs,
  type Money,
  type StatutoryCalculationInputs,
  type TenureTier,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../../kernel/approvals';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { NotificationService } from '../../../kernel/notification/notification.service';
import { PeriodsService } from '../periods/periods.service';
import { StatutoryService } from '../statutory/statutory.service';
import { pgDateToIso } from '../pg-date.util';
import {
  getDeductionRates,
  getLeaveQuotas,
  getOvertimeSettings,
  getSoShortfallSettings,
  getStatutoryGate,
} from '../payroll-settings.util';
import type { OverrideLineDto } from '../dto/payroll.dto';
import { withWrite } from '../db-tx';

/**
 * PIN-05 tenure tiers: CONTRACTS.md §1.7/§2.6 describe the FORMULA
 * (`tenureAllowance()`, `@mimi/shared`) but no schema column carries tier
 * boundaries/amounts — `salary_components.default_amount` is a single flat
 * value, not a tier table. This is a genuine contract gap (flagged in this
 * agent's final report for settings/senior-db to formalize, e.g. a
 * `hr.tenure_tiers` settings key), NOT a schema change made unilaterally
 * here. These defaults are an application-level placeholder so the PIN-05
 * component computes something principled rather than silently zero.
 */
const DEFAULT_TENURE_TIERS: readonly TenureTier[] = [
  { minYears: 5, amount: '500000.00' },
  { minYears: 3, amount: '300000.00' },
  { minYears: 1, amount: '100000.00' },
];

export interface PayslipLineApi {
  componentCode: string;
  componentName: string;
  type: 'earning' | 'deduction' | 'employer_cost';
  isStatutory: boolean;
  qty: string | null;
  rate: Money | null;
  amount: Money;
  sourceRefType: string | null;
  manualOverride: boolean;
}

export interface PayslipApi {
  runId: UUID;
  periodCode: string;
  employee: { id: UUID; name: string; position: string; locationName: string };
  lines: PayslipLineApi[];
  gross: Money;
  deductions: Money;
  net: Money;
  employerCost: Money;
  slipPdfUrl: string | null;
}

export interface PayrollRunApi {
  id: UUID;
  runNumber: string;
  periodCode: string;
  status: string;
  statutoryMode: boolean;
  employeeCount: number;
  totalGross: Money;
  totalDeductions: Money;
  totalNet: Money;
  totalEmployerCost: Money;
  calculatedAt: string | null;
  approval: ApprovalDetail | null;
  paidAt: string | null;
}

interface EmployeeRow {
  id: UUID;
  userId: UUID | null;
  name: string;
  position: string;
  locationId: UUID;
  locationName: string;
  joinDate: string;
  baseSalary: Money;
}

/**
 * M15 `payroll` — the payroll RUN lifecycle: calculate → review/override →
 * submit → approve → pay → send slips (CONTRACTS.md §4.15, FR-HR-03/04).
 * Composes the pure calculators W1-B shipped (`@mimi/shared`'s
 * `calculatePayroll`) with real rows this agent reads directly (attendance,
 * loans, approved stock-opname shortfalls, approved cash-variance
 * proposals) — never reimplementing the maths itself.
 *
 * `payroll_runs`/`payroll_lines`/`employee_loans`/`salary_components` are
 * ALL class X in the sync authority matrix (`packages/sync-protocol/src/
 * authority-matrix.ts`) — never on the wire in either direction, same as
 * `employments` in `modules/hr/employees/employees.service.ts`. Calling
 * `SyncEmitService.emit()` for any of them would throw (`canOriginate`
 * rejects every op for a class-X entity by design). This module therefore
 * emits NO sync events — CONTRACTS §0's "every mutation emits a sync event"
 * rule does not apply to a domain the sync protocol has deliberately
 * excluded from the wire; audit logging (`@Audited()`) is the record of
 * these mutations instead.
 *
 * GL POSTING SEAM: `EventBus.publish('journal.action', ...)` on run approval
 * (`PAYROLL_ACCRUAL`) and on mark-paid (`PAYROLL_PAYMENT`) — M17 `accounting`
 * is still a stub (`modules/accounting/accounting.module.ts`), so nothing
 * subscribes yet; this is the documented seam `kernel/events/event-bus.
 * service.ts`'s header names ("W4-03 subscribes once via
 * `subscribe('journal.action', ...)`"). No journal rows are written here.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly periods: PeriodsService,
    private readonly statutory: StatutoryService,
    private readonly approvals: ApprovalService,
    private readonly events: EventBus,
    private readonly notifications: NotificationService,
  ) {}

  // ── calculate ──────────────────────────────────────────────────────────

  async calculateForPeriod(
    client: PoolClient,
    actorUserId: UUID,
    periodId: UUID,
    employeeIds?: UUID[],
  ): Promise<PayrollRunApi> {
    const period = await this.periods.requirePeriod(client, periodId);

    const activeRun = await client.query<{ id: UUID }>(
      `SELECT id FROM payroll_runs WHERE period_id = $1 AND status <> 'cancelled'`,
      [periodId],
    );
    if (activeRun.rows.length > 0) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Period ${period.periodCode} already has an active run — use recalculate instead of calculating a new one`,
      });
    }

    const gate = await getStatutoryGate(client);
    if (gate.enabled) {
      const status = await this.statutory.getStatus(client);
      if (!status.ready) {
        throw new BadRequestException({
          code: 'ERR_STATUTORY_NOT_READY',
          message: 'Statutory payroll is enabled but the rate/profile tables are not ready',
          details: { missing: status.missing },
        });
      }
    }

    return withWrite(client, async () => {
      const runSeq = await this.nextRunSeq(client, period.periodCode);
      const runNumber = formatCloudDocNumber(
        DocumentPrefix.PAYROLL_RUN,
        period.periodCode.replace('-', ''),
        runSeq,
      );

      const runRes = await client.query<{ id: UUID }>(
        `INSERT INTO payroll_runs (period_id, run_seq, run_number, status, statutory_mode, calculated_by, calculated_at)
         VALUES ($1,$2,$3,'calculated',$4,$5,NOW()) RETURNING id`,
        [periodId, runSeq, runNumber, gate.enabled, actorUserId],
      );
      const runId = runRes.rows[0]!.id;

      const employees = await this.loadEmployees(client, employeeIds);
      await this.computeAndPersistLines(client, runId, period, employees, gate.enabled, new Set());

      await this.periods.markStatus(client, periodId, 'processing');
      return this.getRunDetail(client, runId);
    });
  }

  async recalculate(client: PoolClient, actorUserId: UUID, runId: UUID): Promise<PayrollRunApi> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'calculated') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Run ${run.runNumber} must be in 'calculated' status to recalculate (currently '${run.status}')`,
      });
    }
    const period = await this.periods.requirePeriod(client, run.periodId);

    return withWrite(client, async () => {
      const employeeIdsRes = await client.query<{ employee_id: UUID }>(
        'SELECT DISTINCT employee_id FROM payroll_lines WHERE run_id = $1',
        [runId],
      );
      const overriddenRes = await client.query<{ employee_id: UUID }>(
        'SELECT DISTINCT employee_id FROM payroll_lines WHERE run_id = $1 AND manual_override = true',
        [runId],
      );
      const overriddenEmployeeIds = new Set(overriddenRes.rows.map((r) => r.employee_id));

      // Drop every non-overridden line — manual overrides survive a recalculate (CONTRACTS §4.15).
      await client.query(
        'DELETE FROM payroll_lines WHERE run_id = $1 AND manual_override = false',
        [runId],
      );

      const employees = await this.loadEmployees(
        client,
        employeeIdsRes.rows.map((r) => r.employee_id),
      );
      await this.computeAndPersistLines(
        client,
        runId,
        period,
        employees,
        run.statutoryMode,
        overriddenEmployeeIds,
      );

      await client.query(
        `UPDATE payroll_runs SET calculated_by = $2, calculated_at = NOW() WHERE id = $1`,
        [runId, actorUserId],
      );
      return this.getRunDetail(client, runId);
    });
  }

  async overrideLine(
    client: PoolClient,
    runId: UUID,
    lineId: UUID,
    dto: OverrideLineDto,
  ): Promise<PayslipLineApi> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'calculated') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Lines can only be edited while the run is 'calculated' (currently '${run.status}')`,
      });
    }
    if (!dto.overrideReason?.trim())
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'overrideReason is required',
      });

    return withWrite(client, async () => {
      const res = await client.query<Record<string, any>>(
        `UPDATE payroll_lines SET amount = $3, manual_override = true, override_reason = $4
           WHERE id = $1 AND run_id = $2
         RETURNING *`,
        [lineId, runId, dto.amount, dto.overrideReason],
      );
      if (res.rows.length === 0)
        throw new NotFoundException({
          code: ERR_NOT_FOUND,
          message: 'Payroll line not found on this run',
        });

      await this.recomputeRunTotals(client, runId);
      return this.toLineApi(client, res.rows[0]!);
    });
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async submit(client: PoolClient, actorUserId: UUID, runId: UUID): Promise<PayrollRunApi> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'calculated') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Run must be 'calculated' to submit (currently '${run.status}')`,
      });
    }

    return withWrite(client, async () => {
      const submitResult = await this.approvals.submit(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId: runId,
        requestedBy: actorUserId,
        amount: run.totalNet,
        locationId: null,
      });

      await client.query(
        `UPDATE payroll_runs SET status = 'pending_approval', approval_id = $2 WHERE id = $1`,
        [runId, submitResult.approvalId],
      );
      return this.getRunDetail(client, runId);
    });
  }

  async approve(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: string,
    runId: UUID,
    note: string | undefined,
  ): Promise<PayrollRunApi> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'pending_approval') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Run must be 'pending_approval' to approve (currently '${run.status}')`,
      });
    }

    return withWrite(client, async () => {
      const result = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId: runId,
        currentState: run.status,
        actorUserId,
        actorRole: actorRole as any,
        reason: note ?? null,
      });

      // Only the FINAL step (currentStep === null) actually finalizes the document — an intermediate
      // step (Finance, before Owner) must leave `payroll_runs.status` at 'pending_approval'; the kernel's
      // own `approval_steps` bookkeeping already recorded this actor's decision.
      if (result.currentStep === null && result.approvalState === 'approved') {
        await client.query(
          `UPDATE payroll_runs SET status = $2, approved_by = $3, approved_at = NOW() WHERE id = $1`,
          [runId, result.nextState, actorUserId],
        );
        await this.finalizeApprovedRun(client, runId, actorUserId);
      }

      return this.getRunDetail(client, runId);
    });
  }

  async reject(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: string,
    runId: UUID,
    reason: string,
  ): Promise<PayrollRunApi> {
    if (!reason?.trim())
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'reason is required' });
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'pending_approval') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Run must be 'pending_approval' to reject (currently '${run.status}')`,
      });
    }

    return withWrite(client, async () => {
      const result = await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.PAYROLL_RUN,
        documentId: runId,
        currentState: run.status,
        actorUserId,
        actorRole: actorRole as any,
        reason,
      });

      await client.query(`UPDATE payroll_runs SET status = $2 WHERE id = $1`, [
        runId,
        result.nextState,
      ]);
      return this.getRunDetail(client, runId);
    });
  }

  async markPaid(
    client: PoolClient,
    _actorUserId: UUID,
    runId: UUID,
    paymentVerificationId: UUID,
  ): Promise<PayrollRunApi> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'approved') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Run must be 'approved' to mark paid (currently '${run.status}')`,
      });
    }

    const pvRes = await client.query<{ status: string }>(
      'SELECT status FROM payment_verifications WHERE id = $1 AND ref_id = $2',
      [paymentVerificationId, runId],
    );
    if (pvRes.rows.length === 0)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: 'Payment verification not found for this run',
      });
    if (pvRes.rows[0]!.status !== 'paid') {
      // M17 `accounting` (the payment-verification queue's verify/pay endpoints) is still a stub at
      // the time this module was built — there is currently no way to legitimately drive a PV to
      // 'paid' through the real flow. Documented as a seam in this agent's report, not papered over.
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'The referenced payment verification is not yet paid',
      });
    }

    return withWrite(client, async () => {
      await client.query(`UPDATE payroll_runs SET status = 'paid', paid_at = NOW() WHERE id = $1`, [
        runId,
      ]);

      await this.events.publish('journal.action', {
        eventType: JournalSystemEventType.PAYROLL_PAYMENT,
        documentType: 'payroll_run',
        documentId: runId,
        locationId: null,
        amount: run.totalNet,
        context: { runNumber: run.runNumber, paymentVerificationId },
        occurredAt: new Date().toISOString(),
      });

      return this.getRunDetail(client, runId);
    });
  }

  async sendSlips(
    client: PoolClient,
    runId: UUID,
    channels: ('email' | 'whatsapp')[],
  ): Promise<{ queued: number; skippedNoContact: number }> {
    const run = await this.requireRunRow(client, runId);
    if (run.status !== 'approved' && run.status !== 'paid') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Slips can only be sent for an approved/paid run (currently '${run.status}')`,
      });
    }

    const res = await client.query<{
      employee_id: UUID;
      user_id: UUID | null;
      name: string;
      net: string;
    }>(
      `SELECT e.id AS employee_id, e.user_id, e.name,
              COALESCE((SELECT SUM(pl.amount) FROM payroll_lines pl
                         JOIN salary_components sc ON sc.id = pl.component_id
                        WHERE pl.employee_id = e.id AND pl.run_id = $1 AND sc.type = 'earning'), 0)
              - COALESCE((SELECT SUM(pl.amount) FROM payroll_lines pl
                           JOIN salary_components sc ON sc.id = pl.component_id
                          WHERE pl.employee_id = e.id AND pl.run_id = $1 AND sc.type = 'deduction'), 0) AS net
         FROM employees e
        WHERE e.id IN (SELECT DISTINCT employee_id FROM payroll_lines WHERE run_id = $1)`,
      [runId],
    );

    let queued = 0;
    let skippedNoContact = 0;
    for (const row of res.rows) {
      if (!row.user_id) {
        skippedNoContact++;
        continue;
      }
      // Slip PDF rendering (W5-05, CONTRACTS §4.15 note) is not built yet — the notification still
      // fires (so the employee is told their slip is ready) but carries no attachment URL. See this
      // agent's final report for the seam.
      await this.notifications.notify({
        templateKey: 'payroll_slip',
        userIds: [row.user_id],
        params: { employeeName: row.name, periodCode: run.periodCode, net: row.net },
        channels,
      });
      queued++;
    }

    return { queued, skippedNoContact };
  }

  async mySlips(client: PoolClient, userId: UUID, year?: string): Promise<PayslipApi[]> {
    const empRes = await client.query<{ id: UUID }>('SELECT id FROM employees WHERE user_id = $1', [
      userId,
    ]);
    if (empRes.rows.length === 0) return [];
    const employeeId = empRes.rows[0]!.id;

    const params: unknown[] = [employeeId];
    let where = "pl.employee_id = $1 AND r.status IN ('approved','paid')";
    if (year) {
      params.push(`${year}-01`, `${year}-12`);
      where += ` AND p.period_code BETWEEN $2 AND $3`;
    }

    const runsRes = await client.query<{ id: UUID }>(
      `SELECT DISTINCT r.id FROM payroll_lines pl
         JOIN payroll_runs r ON r.id = pl.run_id
         JOIN payroll_periods p ON p.id = r.period_id
        WHERE ${where}
        ORDER BY r.id`,
      params,
    );

    const slips: PayslipApi[] = [];
    for (const row of runsRes.rows) {
      slips.push(await this.buildPayslip(client, row.id, employeeId));
    }
    return slips;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async getRunDetail(
    client: PoolClient,
    runId: UUID,
  ): Promise<PayrollRunApi & { employees: PayslipApi[] }> {
    const run = await this.toRunApi(client, await this.requireRunRow(client, runId));
    const employeeIds = await client.query<{ employee_id: UUID }>(
      'SELECT DISTINCT employee_id FROM payroll_lines WHERE run_id = $1',
      [runId],
    );
    const employees: PayslipApi[] = [];
    for (const row of employeeIds.rows) {
      employees.push(await this.buildPayslip(client, runId, row.employee_id));
    }
    return { ...run, employees };
  }

  // ── internal: computation ─────────────────────────────────────────────────

  private async computeAndPersistLines(
    client: PoolClient,
    runId: UUID,
    period: { periodCode: string; startDate: string; endDate: string },
    employees: EmployeeRow[],
    statutoryEnabled: boolean,
    skipEmployeeIds: Set<UUID>,
  ): Promise<void> {
    const componentIds = await this.loadComponentIds(client);
    const daysInMonth = Number(period.endDate.slice(8, 10));
    const shortfallShares = await this.computeStockShortfallShares(client, employees, period);

    for (const employee of employees) {
      if (skipEmployeeIds.has(employee.id)) continue;

      const base = await this.buildBaseInputs(
        client,
        employee,
        period,
        daysInMonth,
        shortfallShares.get(employee.id) ?? [],
      );
      let statutoryInputs: StatutoryCalculationInputs | undefined;
      if (statutoryEnabled) {
        // Statutory PPh21/BPJS bases itself on the period's GROSS earnings, not just the flat base
        // salary — derive it from the same pure base calculation `calculatePayroll` below runs anyway.
        const monthlyGross = calculateBasePayslip(base).gross;
        statutoryInputs = await this.statutory.buildCalculationInputs(
          client,
          employee.id,
          employee.baseSalary,
          monthlyGross,
          period.endDate,
        );
      }

      const result = calculatePayroll(base, statutoryEnabled, statutoryInputs);

      for (const line of result.lines) {
        const componentId = componentIds.get(line.componentCode);
        if (!componentId) continue; // component not seeded — nothing to attach the line to (data-integrity gap, not a calc error)
        await client.query(
          `INSERT INTO payroll_lines (run_id, employee_id, component_id, qty, rate, amount, source_ref_type, manual_override)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)
           ON CONFLICT (run_id, employee_id, component_id) DO UPDATE SET qty = EXCLUDED.qty, rate = EXCLUDED.rate, amount = EXCLUDED.amount, source_ref_type = EXCLUDED.source_ref_type`,
          [runId, employee.id, componentId, line.qty, line.rate, line.amount, line.sourceRefType],
        );
      }
    }

    await this.recomputeRunTotals(client, runId);
  }

  private async buildBaseInputs(
    client: PoolClient,
    employee: EmployeeRow,
    period: { periodCode: string; startDate: string; endDate: string },
    daysInMonth: number,
    stockShortfallShares: Money[],
  ): Promise<BasePayrollInputs> {
    const summaryRes = await client.query<Record<string, any>>(
      `SELECT
         COUNT(*) FILTER (WHERE a.status = 'late') AS late_count,
         COALESCE(SUM(a.late_minutes), 0) AS late_minutes,
         COALESCE(SUM(a.overtime_minutes), 0) AS overtime_minutes,
         COUNT(*) FILTER (WHERE a.status = 'sick') AS sick_days,
         COUNT(*) FILTER (WHERE a.status = 'permission') AS permission_days,
         COUNT(*) FILTER (WHERE a.status = 'absent') AS absent_days
       FROM attendance a
      WHERE a.employee_id = $1 AND a.date >= $2::date AND a.date <= $3::date`,
      [employee.id, period.startDate, period.endDate],
    );
    const s = summaryRes.rows[0] ?? {};
    const lateCount = parseInt(s.late_count ?? '0', 10);
    const absentDays = parseInt(s.absent_days ?? '0', 10);

    const overtime = await getOvertimeSettings(client);
    const deductionRates = await getDeductionRates(client);
    const quotas = await getLeaveQuotas(client);

    const year = period.startDate.slice(0, 4);
    const leaveRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(days), 0) AS total FROM leave_requests
        WHERE employee_id = $1 AND status = 'approved' AND type IN ('annual','marriage') AND EXTRACT(YEAR FROM start_date) = $2`,
      [employee.id, year],
    );

    const componentAmounts = await this.loadEmployeeComponentAmounts(
      client,
      employee.id,
      period.endDate,
    );

    const loansRes = await client.query<{
      id: UUID;
      outstanding: Money;
      monthly_installment: Money;
    }>(
      `SELECT id, outstanding, monthly_installment FROM employee_loans WHERE employee_id = $1 AND status = 'active' AND outstanding::numeric > 0`,
      [employee.id],
    );

    const cvRes = await client.query<{ amount: Money }>(
      `SELECT amount FROM cash_variance_proposals WHERE employee_id = $1 AND status = 'approved' AND payroll_line_id IS NULL`,
      [employee.id],
    );

    return {
      employee: { joinDate: employee.joinDate },
      periodEndDate: period.endDate,
      daysInMonth,
      baseSalary: employee.baseSalary,
      overtimeMinutesTotal: parseInt(s.overtime_minutes ?? '0', 10),
      overtimeRatePerHour: overtime.ratePerHour,
      attendance: {
        sickDays: parseInt(s.sick_days ?? '0', 10),
        permissionDays: parseInt(s.permission_days ?? '0', 10),
        absentDays,
        lateMinutesTotal: parseInt(s.late_minutes ?? '0', 10),
        hasPerfectAttendance: lateCount === 0 && absentDays === 0,
      },
      sickPaid: deductionRates.sickPaid,
      permissionPaid: deductionRates.permissionPaid,
      perLateMinuteRate: deductionRates.perLateMinute as Money,
      attendanceAllowanceAmount:
        componentAmounts.get(PayrollComponentCode.ATTENDANCE_ALLOWANCE) ?? ZERO_MONEY,
      leave: {
        daysTakenThisYear: Number(leaveRes.rows[0]?.total ?? 0),
        quotaDays: quotas.annual + quotas.marriage,
      },
      tenureTiers: DEFAULT_TENURE_TIERS,
      performanceIncentiveAmount:
        componentAmounts.get(PayrollComponentCode.PERFORMANCE_INCENTIVE) ?? null,
      positionAllowanceAmount:
        componentAmounts.get(PayrollComponentCode.POSITION_ALLOWANCE) ?? null,
      otherEarningAmounts: (() => {
        const v = componentAmounts.get(PayrollComponentCode.OTHER_EARNING);
        return v ? [v] : [];
      })(),
      stockShortfallShares,
      loans: loansRes.rows.map((r) => ({
        loanId: r.id,
        outstanding: r.outstanding,
        monthlyInstallment: r.monthly_installment,
      })),
      cashVarianceAmounts: cvRes.rows.map((r) => r.amount),
      otherDeductionAmounts: (() => {
        const v = componentAmounts.get(PayrollComponentCode.OTHER_DEDUCTION);
        return v ? [v] : [];
      })(),
    };
  }

  /**
   * POUT-05 — approved stock-opname shortfalls within the period window,
   * split evenly among employees on shift at the adjustment's location/date
   * (`settings['payroll.so_shortfall'].splitRule`, default
   * `'equal_among_on_shift'`). Unattributable shortfalls (no one on shift
   * that day) are dropped, per `mode: 'attributable_only'` — never charged
   * to nobody.
   */
  private async computeStockShortfallShares(
    client: PoolClient,
    employees: EmployeeRow[],
    period: { startDate: string; endDate: string },
  ): Promise<Map<UUID, Money[]>> {
    const settings = await getSoShortfallSettings(client);
    const shares = new Map<UUID, Money[]>();
    if (settings.mode !== 'attributable_only') return shares;

    const employeeIds = new Set(employees.map((e) => e.id));

    const adjRes = await client.query<{
      location_id: UUID;
      adj_date: string;
      qty_delta: string;
      unit_cost: string;
    }>(
      `SELECT location_id, COALESCE(applied_at, created_at)::date AS adj_date, qty_delta, unit_cost
         FROM stock_adjustments
        WHERE source = 'opname' AND approved_by IS NOT NULL AND qty_delta < 0
          AND COALESCE(applied_at, created_at) >= $1::date AND COALESCE(applied_at, created_at) < ($2::date + INTERVAL '1 day')`,
      [period.startDate, period.endDate],
    );

    for (const adj of adjRes.rows) {
      const cost = (Math.abs(Number(adj.qty_delta)) * Number(adj.unit_cost)).toFixed(2) as Money;
      const onShiftRes = await client.query<{ employee_id: UUID }>(
        `SELECT sa.employee_id FROM shift_assignments sa
          WHERE sa.location_id = $1 AND sa.date = $2 AND sa.work_shift_id IS NOT NULL`,
        [adj.location_id, adj.adj_date],
      );
      const onShift = onShiftRes.rows.map((r) => r.employee_id).filter((id) => employeeIds.has(id));
      if (onShift.length === 0) continue; // unattributable — dropped, not charged to nobody

      const splits = splitMoneyEvenly(cost, onShift.length);
      onShift.forEach((employeeId, i) => {
        const list = shares.get(employeeId) ?? [];
        list.push(splits[i]!);
        shares.set(employeeId, list);
      });
    }

    return shares;
  }

  private async loadEmployeeComponentAmounts(
    client: PoolClient,
    employeeId: UUID,
    asOfDate: string,
  ): Promise<Map<PayrollComponentCode, Money>> {
    const res = await client.query<{
      code: PayrollComponentCode;
      amount: Money | null;
      default_amount: Money | null;
    }>(
      `SELECT sc.code, esc.amount, sc.default_amount
         FROM employee_salary_components esc
         JOIN salary_components sc ON sc.id = esc.component_id
        WHERE esc.employee_id = $1 AND esc.effective_from <= $2 AND (esc.effective_to IS NULL OR esc.effective_to >= $2)`,
      [employeeId, asOfDate],
    );
    const map = new Map<PayrollComponentCode, Money>();
    for (const r of res.rows) {
      map.set(r.code, (r.amount ?? r.default_amount ?? ZERO_MONEY) as Money);
    }
    // Components with no per-employee row at all still fall back to their own default_amount.
    const defaultsRes = await client.query<{
      code: PayrollComponentCode;
      default_amount: Money | null;
    }>(
      `SELECT code, default_amount FROM salary_components
        WHERE code IN ($1,$2,$3,$4) AND is_active = true`,
      [
        PayrollComponentCode.ATTENDANCE_ALLOWANCE,
        PayrollComponentCode.PERFORMANCE_INCENTIVE,
        PayrollComponentCode.POSITION_ALLOWANCE,
        PayrollComponentCode.OTHER_EARNING,
      ],
    );
    for (const r of defaultsRes.rows) {
      if (!map.has(r.code) && r.default_amount) map.set(r.code, r.default_amount);
    }
    return map;
  }

  private async loadComponentIds(client: PoolClient): Promise<Map<string, UUID>> {
    const res = await client.query<{ id: UUID; code: string }>(
      'SELECT id, code FROM salary_components WHERE is_active = true',
    );
    return new Map(res.rows.map((r) => [r.code, r.id]));
  }

  private async loadEmployees(client: PoolClient, employeeIds?: UUID[]): Promise<EmployeeRow[]> {
    const params: unknown[] = [];
    let where = "e.employment_status = 'active'";
    if (employeeIds && employeeIds.length > 0) {
      params.push(employeeIds);
      where += ` AND e.id = ANY($${params.length}::uuid[])`;
    }
    const res = await client.query<Record<string, any>>(
      `SELECT e.id, e.user_id, e.name, e.join_date, l.name AS location_name, e.location_id,
              em.position, em.base_salary
         FROM employees e
         JOIN locations l ON l.id = e.location_id
         LEFT JOIN employments em ON em.employee_id = e.id AND em.end_date IS NULL
        WHERE ${where}`,
      params,
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id ?? null,
      name: r.name,
      position: r.position ?? '',
      locationId: r.location_id,
      locationName: r.location_name,
      joinDate: pgDateToIso(r.join_date),
      baseSalary: (r.base_salary ?? ZERO_MONEY) as Money,
    }));
  }

  private async nextRunSeq(client: PoolClient, periodCode: string): Promise<number> {
    const period6 = periodCode.replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.PAYROLL_RUN, period6],
    );
    return res.rows[0]!.last_number;
  }

  private async recomputeRunTotals(client: PoolClient, runId: UUID): Promise<void> {
    const res = await client.query<{ gross: string; deductions: string; employer_cost: string }>(
      `SELECT
         COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'earning'), 0) AS gross,
         COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'deduction'), 0) AS deductions,
         COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'employer_cost'), 0) AS employer_cost
       FROM payroll_lines pl JOIN salary_components sc ON sc.id = pl.component_id
      WHERE pl.run_id = $1`,
      [runId],
    );
    const r = res.rows[0]!;
    const gross = Number(r.gross).toFixed(2) as Money;
    const deductions = Number(r.deductions).toFixed(2) as Money;
    const net = Math.max(0, Number(gross) - Number(deductions)).toFixed(2) as Money;
    await client.query(
      'UPDATE payroll_runs SET total_gross = $2, total_deductions = $3, total_net = $4 WHERE id = $1',
      [runId, gross, deductions, net],
    );
  }

  // ── finalization side-effects (approve) ───────────────────────────────────

  private async finalizeApprovedRun(
    client: PoolClient,
    runId: UUID,
    actorUserId: UUID,
  ): Promise<void> {
    const run = await this.requireRunRow(client, runId);

    // POUT-06: apply this run's loan installment lines as real `employee_loan_payments`, decrementing
    // `employee_loans.outstanding`. Recomputed from each employee's CURRENT active loans rather than
    // stored per-loan on the single aggregate `deduction_loan_installment` line (schema has no
    // per-loan breakdown column on `payroll_lines`) — deterministic here because only one active run
    // exists per period and nothing else mutates `outstanding` between calculate and approve.
    const loanLinesRes = await client.query<{ employee_id: UUID; line_id: UUID }>(
      `SELECT pl.employee_id, pl.id AS line_id FROM payroll_lines pl
         JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.run_id = $1 AND sc.code = $2`,
      [runId, PayrollComponentCode.DEDUCTION_LOAN_INSTALLMENT],
    );
    for (const row of loanLinesRes.rows) {
      const loansRes = await client.query<{
        id: UUID;
        outstanding: Money;
        monthly_installment: Money;
      }>(
        `SELECT id, outstanding, monthly_installment FROM employee_loans WHERE employee_id = $1 AND status = 'active' AND outstanding::numeric > 0`,
        [row.employee_id],
      );
      for (const loan of loansRes.rows) {
        const amount = loanInstallment(loan.outstanding, loan.monthly_installment);
        if (Number(amount) <= 0) continue;
        await client.query(
          `INSERT INTO employee_loan_payments (loan_id, payroll_line_id, amount, method) VALUES ($1,$2,$3,'payroll_deduction')`,
          [loan.id, row.line_id, amount],
        );
        const remaining = (Number(loan.outstanding) - Number(amount)).toFixed(2);
        await client.query(
          `UPDATE employee_loans SET outstanding = $2, status = CASE WHEN $2::numeric <= 0 THEN 'paid_off' ELSE status END WHERE id = $1`,
          [loan.id, remaining],
        );
      }
    }

    // D-19: mark every approved cash-variance proposal this run actually consumed.
    const cvEmployeesRes = await client.query<{ employee_id: UUID; line_id: UUID }>(
      `SELECT pl.employee_id, pl.id AS line_id FROM payroll_lines pl
         JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.run_id = $1 AND sc.code = $2`,
      [runId, PayrollComponentCode.DEDUCTION_CASH_VARIANCE],
    );
    for (const row of cvEmployeesRes.rows) {
      await client.query(
        `UPDATE cash_variance_proposals SET payroll_line_id = $2
          WHERE employee_id = $1 AND status = 'approved' AND payroll_line_id IS NULL`,
        [row.employee_id, row.line_id],
      );
    }

    // Payment verification for the net payroll (FR-ACCT-04) — accounting module (M17) not yet built to
    // drive its own verify/pay flow, but the row itself is real, queued `pending`.
    const pvNumber = await this.nextPvNumber(client);
    const pvRes = await client.query<{ id: UUID }>(
      `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, amount, submitted_by, notes)
       VALUES ($1,'payroll_run',$2,'other',$3,$4,$5) RETURNING id`,
      [pvNumber, runId, run.totalNet, actorUserId, `Payroll run ${run.runNumber}`],
    );
    await client.query('UPDATE payroll_runs SET payment_verification_id = $2 WHERE id = $1', [
      runId,
      pvRes.rows[0]!.id,
    ]);

    // GL seam — see class header. Only publishes; nothing subscribes until M17 lands.
    await this.events.publish('journal.action', {
      eventType: JournalSystemEventType.PAYROLL_ACCRUAL,
      documentType: 'payroll_run',
      documentId: runId,
      locationId: null,
      amount: run.totalGross,
      context: {
        runNumber: run.runNumber,
        statutoryMode: run.statutoryMode,
        totalDeductions: run.totalDeductions,
        totalNet: run.totalNet,
      },
      occurredAt: new Date().toISOString(),
    });

    await this.periods.markStatus(client, run.periodId, 'closed');
  }

  private async nextPvNumber(client: PoolClient): Promise<string> {
    const now = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.PAYMENT_VERIFICATION, now],
    );
    return formatCloudDocNumber(DocumentPrefix.PAYMENT_VERIFICATION, now, res.rows[0]!.last_number);
  }

  // ── mapping helpers ────────────────────────────────────────────────────────

  private async requireRunRow(
    client: PoolClient,
    runId: UUID,
  ): Promise<{
    id: UUID;
    runNumber: string;
    periodId: UUID;
    periodCode: string;
    status: string;
    statutoryMode: boolean;
    totalGross: Money;
    totalDeductions: Money;
    totalNet: Money;
    calculatedAt: string | null;
    approvalId: UUID | null;
    paidAt: string | null;
  }> {
    const res = await client.query<Record<string, any>>(
      `SELECT r.*, p.period_code
         FROM payroll_runs r JOIN payroll_periods p ON p.id = r.period_id
        WHERE r.id = $1`,
      [runId],
    );
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Payroll run not found' });
    const r = res.rows[0]!;
    return {
      id: r.id,
      runNumber: r.run_number,
      periodId: r.period_id,
      periodCode: r.period_code,
      status: r.status,
      statutoryMode: r.statutory_mode,
      totalGross: r.total_gross,
      totalDeductions: r.total_deductions,
      totalNet: r.total_net,
      calculatedAt: r.calculated_at ? new Date(r.calculated_at).toISOString() : null,
      approvalId: r.approval_id ?? null,
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    } as any;
  }

  private async toRunApi(
    client: PoolClient,
    run: Awaited<ReturnType<RunsService['requireRunRow']>>,
  ): Promise<PayrollRunApi> {
    const countRes = await client.query<{ count: string }>(
      'SELECT COUNT(DISTINCT employee_id) AS count FROM payroll_lines WHERE run_id = $1',
      [run.id],
    );
    const employerCostRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(pl.amount), 0)::numeric(18,2) AS total FROM payroll_lines pl JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.run_id = $1 AND sc.type = 'employer_cost'`,
      [run.id],
    );

    let approval: ApprovalDetail | null = null;
    if (run.approvalId) {
      try {
        const detail = await this.approvals.getDetail(
          client,
          ApprovalDocumentType.PAYROLL_RUN,
          run.id,
        );
        approval = {
          approvalId: detail.approvalId,
          state: detail.state,
          amount: detail.amount,
          steps: detail.steps.map((s) => ({
            stepNo: s.stepNo,
            approverRole: s.approverRole,
            state: s.state,
            actedBy: s.actedBy,
            actedAt: s.actedAt,
            reason: s.reason,
            offlineAuthorized: s.offlineAuthorized,
            reverificationStatus: s.reverificationStatus,
          })),
        } as ApprovalDetail;
      } catch {
        approval = null;
      }
    }

    return {
      id: run.id,
      runNumber: run.runNumber,
      periodCode: run.periodCode,
      status: run.status,
      statutoryMode: run.statutoryMode,
      employeeCount: parseInt(countRes.rows[0]?.count ?? '0', 10),
      totalGross: run.totalGross,
      totalDeductions: run.totalDeductions,
      totalNet: run.totalNet,
      totalEmployerCost: employerCostRes.rows[0]?.total ?? ZERO_MONEY,
      calculatedAt: run.calculatedAt,
      approval,
      paidAt: run.paidAt,
    };
  }

  private async buildPayslip(
    client: PoolClient,
    runId: UUID,
    employeeId: UUID,
  ): Promise<PayslipApi> {
    const run = await this.requireRunRow(client, runId);
    const empRes = await client.query<{ name: string; position: string; location_name: string }>(
      `SELECT e.name, COALESCE(em.position, e.position) AS position, l.name AS location_name
         FROM employees e JOIN locations l ON l.id = e.location_id
         LEFT JOIN employments em ON em.employee_id = e.id AND em.end_date IS NULL
        WHERE e.id = $1`,
      [employeeId],
    );
    const emp = empRes.rows[0] ?? { name: '', position: '', location_name: '' };

    const linesRes = await client.query<Record<string, any>>(
      `SELECT pl.*, sc.code, sc.name AS component_name, sc.type, sc.is_statutory
         FROM payroll_lines pl JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.run_id = $1 AND pl.employee_id = $2
        ORDER BY sc.sort_order ASC`,
      [runId, employeeId],
    );

    const lines = linesRes.rows.map((r) => this.mapLineRow(r));
    const gross = sumMoney(lines.filter((l) => l.type === 'earning').map((l) => l.amount));
    const deductions = sumMoney(lines.filter((l) => l.type === 'deduction').map((l) => l.amount));
    const employerCost = sumMoney(
      lines.filter((l) => l.type === 'employer_cost').map((l) => l.amount),
    );
    const net = clampMoneyToZero(subMoney(gross, deductions));

    return {
      runId,
      periodCode: run.periodCode,
      employee: {
        id: employeeId,
        name: emp.name,
        position: emp.position,
        locationName: emp.location_name,
      },
      lines,
      gross,
      deductions,
      net,
      employerCost,
      // Slip PDF rendering (W5-05) is not built yet — see class header seam note.
      slipPdfUrl: null,
    };
  }

  private mapLineRow(r: Record<string, any>): PayslipLineApi {
    return {
      componentCode: r.code,
      componentName: r.component_name,
      type: r.type,
      isStatutory: r.is_statutory,
      qty: r.qty !== null ? String(r.qty) : null,
      rate: r.rate ?? null,
      amount: r.amount,
      sourceRefType: r.source_ref_type ?? null,
      manualOverride: r.manual_override,
    };
  }

  private async toLineApi(client: PoolClient, r: Record<string, any>): Promise<PayslipLineApi> {
    const scRes = await client.query<{
      code: string;
      name: string;
      type: string;
      is_statutory: boolean;
    }>('SELECT code, name, type, is_statutory FROM salary_components WHERE id = $1', [
      r.component_id,
    ]);
    const sc = scRes.rows[0]!;
    return this.mapLineRow({
      ...r,
      code: sc.code,
      component_name: sc.name,
      type: sc.type,
      is_statutory: sc.is_statutory,
    });
  }
}
