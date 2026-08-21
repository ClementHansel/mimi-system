import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { can, RoleKey } from '@mimi/shared';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { PeriodsService } from './periods/periods.service';
import { StatutoryService } from './statutory/statutory.service';
import { RunsService } from './runs/runs.service';
import { ComponentsService } from './components/components.service';
import { LoansService } from './loans/loans.service';
import {
  asCommittedRequest,
  asRequest,
  cleanupCommittedRows,
  closePool,
  loadPayrollFixtures,
  readSettingValue,
  setSettingValueCommitted,
  withRollbackAs,
  type PayrollFixtures,
} from './test-support/live-db';

vi.setConfig({ testTimeout: 20_000 });

/**
 * Integration proof for M15 `payroll` (CONTRACTS.md §4.15, FR-HR-03/04) —
 * against a REAL Postgres connection under the SAME RLS session context a
 * real request gets.
 *
 * BE-TXN-ROLLBACK: every mutating method across `components`/`loans`/
 * `periods`/`runs`/`statutory` now self-commits (`db-tx.ts`'s `withWrite()`),
 * matching `stock-opname`/`waste-return`'s fix. That means a
 * `withRollbackAs`/`asRequest` connection can no longer chain more than ONE
 * call into a `withWrite`-wrapped method — the first call's `COMMIT` is
 * REAL, ends the transaction, and reverts `SET LOCAL ROLE`/session GUCs with
 * it (see `test-support/live-db.ts`'s `asRequest` doc comment). Every test
 * below that drives more than one mutating step therefore opens a SEPARATE
 * `asRequest` connection per step — one call = one simulated HTTP request —
 * exactly `stock-opname.integration.spec.ts`'s rewritten shape. Fixture rows
 * that must be visible to a LATER, separate connection are committed via
 * `asCommittedRequest` and always cleaned up in a `finally` block
 * (`cleanupCommittedRows` / settings restore) so nothing this suite commits
 * durably outlives the test run.
 */
describe('Payroll module (integration, live Postgres)', () => {
  let fixtures: PayrollFixtures;
  let dbAvailable = true;
  let runs: RunsService;
  let periods: PeriodsService;
  let statutory: StatutoryService;
  let components: ComponentsService;
  let loans: LoansService;

  function buildRuns(): RunsService {
    const approvals = new ApprovalService(new ApprovalsRepository());
    const events = new EventBus();
    const fakeNotifications = {
      notify: async () => ({ inApp: [], email: [], whatsapp: [] }),
    } as any;
    return new RunsService(periods, statutory, approvals, events, fakeNotifications);
  }

  function buildLoans(): LoansService {
    return new LoansService(new ApprovalService(new ApprovalsRepository()));
  }

  beforeAll(async () => {
    try {
      fixtures = await loadPayrollFixtures();
      periods = new PeriodsService();
      statutory = new StatutoryService();
      components = new ComponentsService();
      runs = buildRuns();
      loans = buildLoans();
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function insertEmployeeFixture(
    actor: { userId: string; roleKey: RoleKey },
    label: string,
    opts: { joinDate: string; baseSalary: string },
  ): Promise<string> {
    const employeeId = randomUUID();
    await asCommittedRequest(
      { userId: actor.userId, roleKey: actor.roleKey, locationIds: [] },
      async (client) => {
        await client.query(
          `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, $3, $4, 'Staff', $5, 'active')`,
          [
            employeeId,
            `EMP-TEST-${employeeId.slice(0, 8)}`,
            label,
            opts.joinDate,
            fixtures.locationId,
          ],
        );
        await client.query(
          `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, $3, $4)`,
          [employeeId, fixtures.locationId, opts.baseSalary, opts.joinDate],
        );
      },
    );
    return employeeId;
  }

  // ── Layer 1: permission matrix, both directions (the "permission denied" pin) ──

  it('a Kasir is denied every payroll mutation/read permission key', () => {
    const denied: [string, RoleKey][] = [
      ['payroll.read', RoleKey.KASIR],
      ['payroll.run.calculate', RoleKey.KASIR],
      ['payroll.run.submit', RoleKey.KASIR],
      ['payroll.run.approve', RoleKey.KASIR],
      ['payroll.run.pay', RoleKey.KASIR],
      ['payroll.loan.manage', RoleKey.KASIR],
      ['payroll.loan.approve', RoleKey.KASIR],
      ['payroll.statutory.config', RoleKey.KASIR],
      ['payroll.statutory.enable', RoleKey.KASIR],
    ];
    for (const [key, role] of denied) {
      expect(can(role, key as never), `${role} should NOT hold ${key}`).toBe(false);
    }
  });

  it('a Supervisor (outlet staff) is also denied the finance-grade payroll keys', () => {
    expect(can(RoleKey.SUPERVISOR, 'payroll.run.calculate' as never)).toBe(false);
    expect(can(RoleKey.SUPERVISOR, 'payroll.run.approve' as never)).toBe(false);
    // ...but every role (including a Supervisor) may read their OWN payslips.
    expect(can(RoleKey.SUPERVISOR, 'payroll.slip.read.own' as never)).toBe(true);
  });

  it('the central/HR roles CONTRACTS §3 grants these keys to are actually allowed', () => {
    expect(can(RoleKey.HR_ADMIN, 'payroll.run.calculate' as never)).toBe(true);
    expect(can(RoleKey.FINANCE, 'payroll.run.approve' as never)).toBe(true);
    expect(can(RoleKey.OWNER, 'payroll.run.approve' as never)).toBe(true);
    expect(can(RoleKey.OWNER, 'payroll.statutory.enable' as never)).toBe(true);
  });

  it("RLS: a Kasir querying payroll_runs directly (bypassing the controller layer entirely) sees nothing for someone else's run", async () => {
    if (!dbAvailable) return;
    const kasirUserId = fixtures.usersByRole[RoleKey.KASIR];
    if (!kasirUserId) return;
    await withRollbackAs(
      { userId: kasirUserId, roleKey: RoleKey.KASIR, locationIds: [fixtures.locationId] },
      async (client) => {
        const res = await client.query('SELECT id FROM payroll_runs');
        for (const row of res.rows as { id: string }[]) {
          const ownLine = await client.query(
            'SELECT 1 FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = $1 AND e.user_id = $2',
            [row.id, kasirUserId],
          );
          expect(
            ownLine.rows.length,
            `Kasir should only see payroll_runs rows they have a line in`,
          ).toBeGreaterThan(0);
        }
      },
    );
  });

  // ── Layer 2: the golden case — full period calculation, hand-checked ─────

  it('golden case: a full period calculation with known inputs produces the hand-checked net pay (statutory OFF)', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };

    const savedStatutory = await readSettingValue('payroll.statutory');
    const savedOvertime = await readSettingValue('hr.overtime');
    const savedDeductions = await readSettingValue('hr.deduction_rates');
    let employeeId: string | undefined;
    let periodId: string | undefined;
    try {
      // Force the gate OFF and pin the rate settings this golden case's expected numbers depend on —
      // deterministic regardless of what the seed happens to carry. Committed for real (own
      // connection) so the LATER, separate `runs.calculateForPeriod` connection actually sees them.
      await setSettingValueCommitted('payroll.statutory', {
        enabled: false,
        enabledAt: null,
        enabledBy: null,
      });
      await setSettingValueCommitted('hr.overtime', { ratePerHour: '20000.00', minMinutes: 0 });
      await setSettingValueCommitted('hr.deduction_rates', {
        perAbsentDay: 'daily_rate',
        perLateMinute: '1000.00',
        sickPaid: false,
        permissionPaid: false,
      });

      // A fresh employee, isolated from any seed noise — known base salary chosen so the daily rate
      // divides EXACTLY (9,300,000 / 31 = 300,000.00), so no rounding ambiguity enters the golden case.
      employeeId = await insertEmployeeFixture(actor, 'Golden Case Employee', {
        joinDate: '2018-07-01',
        baseSalary: '9300000.00',
      });

      await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
        // Attendance: 2 late days (20 + 20 = 40 late minutes), 1 day with 120 min overtime, 1 sick,
        // 1 permission, 1 absent — everything else in the month is simply absent of a row (no auto-mark).
        const attendanceRows: [string, string, number, number][] = [
          ['2019-01-02', 'late', 20, 0],
          ['2019-01-03', 'late', 20, 0],
          ['2019-01-04', 'present', 0, 120],
          ['2019-01-05', 'sick', 0, 0],
          ['2019-01-06', 'permission', 0, 0],
          ['2019-01-07', 'absent', 0, 0],
        ];
        for (const [date, status, lateMinutes, overtimeMinutes] of attendanceRows) {
          await client.query(
            `INSERT INTO attendance (employee_id, location_id, date, status, late_minutes, overtime_minutes)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [employeeId, fixtures.locationId, date, status, lateMinutes, overtimeMinutes],
          );
        }

        // POUT-06: an active loan with a known installment.
        await client.query(
          `INSERT INTO employee_loans (loan_number, employee_id, principal, monthly_installment, outstanding, status)
           VALUES ($1, $2, '1000000.00', '200000.00', '1000000.00', 'active')`,
          [`LOAN-TEST-${employeeId!.slice(0, 8)}`, employeeId],
        );

        // D-19: an approved, unconsumed cash-variance proposal — needs a real pos_shift row (FK) to hang off.
        const shiftRes = await client.query<{ id: string }>(
          `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, client_id)
           VALUES ($1,$2,$3,NOW(),'0.00',$4) RETURNING id`,
          [`SHIFT-TEST-${employeeId!.slice(0, 8)}`, fixtures.locationId, hrAdmin, randomUUID()],
        );
        await client.query(
          `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, employee_id, amount, status)
           VALUES ($1,$2,$3,$4,'50000.00','approved')`,
          [shiftRes.rows[0]!.id, fixtures.locationId, hrAdmin, employeeId],
        );
      });

      // Each mutating step is its own connection now that `periods.create`/`runs.calculateForPeriod`
      // self-commit.
      const period = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => periods.create(client, '2019-01'),
      );
      periodId = period.id;

      const run = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
      );

      expect(run.statutoryMode).toBe(false);
      expect(run.totalEmployerCost).toBe('0.00');
      expect(run.totalGross).toBe('9340000.00'); // 9,300,000 base + 40,000 overtime (2h @ 20,000/h)
      expect(run.totalDeductions).toBe('1190000.00'); // 40,000 late + 300,000 sick + 300,000 permission + 300,000 absence + 200,000 loan + 50,000 cash-variance
      expect(run.totalNet).toBe('8150000.00');

      const slip = (run as any).employees.find((e: any) => e.employee.id === employeeId)!;
      expect(
        slip.lines.some(
          (l: any) => l.componentCode === 'deduction_loan_installment' && l.amount === '200000.00',
        ),
      ).toBe(true);
      expect(
        slip.lines.some(
          (l: any) => l.componentCode === 'deduction_cash_variance' && l.amount === '50000.00',
        ),
      ).toBe(true);
      expect(slip.lines.some((l: any) => l.isStatutory)).toBe(false); // statutory OFF => zero statutory lines
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
      await setSettingValueCommitted('hr.overtime', savedOvertime);
      await setSettingValueCommitted('hr.deduction_rates', savedDeductions);
    }
  });

  it('statutory OFF produces exactly the PRD base set — no bpjs_*/pph21 lines regardless of what statutory config exists', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
    const savedStatutory = await readSettingValue('payroll.statutory');
    let employeeId: string | undefined;
    let periodId: string | undefined;
    try {
      await setSettingValueCommitted('payroll.statutory', {
        enabled: false,
        enabledAt: null,
        enabledBy: null,
      });
      employeeId = await insertEmployeeFixture(actor, 'Statutory Off Employee', {
        joinDate: '2020-01-01',
        baseSalary: '5000000.00',
      });

      const period = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => periods.create(client, '2019-02'),
      );
      periodId = period.id;
      const run = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
      );

      expect(run.statutoryMode).toBe(false);
      expect(run.totalEmployerCost).toBe('0.00');
      const codes = new Set((run as any).employees[0]!.lines.map((l: any) => l.componentCode));
      for (const statutoryCode of [
        'bpjs_kesehatan_employee',
        'bpjs_jht_employee',
        'bpjs_jp_employee',
        'pph21',
        'bpjs_kesehatan_employer',
        'bpjs_jht_employer',
        'bpjs_jkk_employer',
        'bpjs_jkm_employer',
        'bpjs_jp_employer',
      ]) {
        expect(
          codes.has(statutoryCode),
          `${statutoryCode} must not appear when statutory is OFF`,
        ).toBe(false);
      }
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
    }
  });

  // ── Layer 3: full lifecycle through the real approval chain ──────────────

  it('calculate -> submit -> Finance approves (mid-chain) -> Owner approves (final) posts the GL seam and loan payment', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const finance = fixtures.usersByRole[RoleKey.FINANCE];
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    if (!finance || !owner) return;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
    const savedStatutory = await readSettingValue('payroll.statutory');
    let employeeId: string | undefined;
    let periodId: string | undefined;
    try {
      await setSettingValueCommitted('payroll.statutory', {
        enabled: false,
        enabledAt: null,
        enabledBy: null,
      });
      employeeId = await insertEmployeeFixture(actor, 'Lifecycle Employee', {
        joinDate: '2021-01-01',
        baseSalary: '4000000.00',
      });
      await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
        client.query(
          `INSERT INTO employee_loans (loan_number, employee_id, principal, monthly_installment, outstanding, status)
           VALUES ($1, $2, '600000.00', '600000.00', '600000.00', 'active')`,
          [`LOAN-TEST2-${employeeId!.slice(0, 8)}`, employeeId],
        ),
      );

      const period = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => periods.create(client, '2019-03'),
      );
      periodId = period.id;

      const calculated = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
      );
      expect(calculated.status).toBe('calculated');

      const submitted = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) => runs.submit(client, hrAdmin, calculated.id),
      );
      expect(submitted.status).toBe('pending_approval');

      // Step 1 — Finance. Not the final step (a 2-step chain: finance -> owner) — the run must stay
      // 'pending_approval', not flip to 'approved' after only the first decision. Real, SEPARATE RLS
      // session matching a genuinely different actor's own real request.
      const afterFinance = await asRequest(
        { userId: finance, roleKey: RoleKey.FINANCE, locationIds: [] },
        (client) => runs.approve(client, finance, RoleKey.FINANCE, submitted.id, 'ok by finance'),
      );
      expect(afterFinance.status).toBe('pending_approval');

      // Step 2 — Owner. This IS the final step: the run becomes 'approved' and the finalize side
      // effects (loan payment, PV row) run exactly once, here.
      const afterOwner = await asRequest(
        { userId: owner, roleKey: RoleKey.OWNER, locationIds: [] },
        (client) => runs.approve(client, owner, RoleKey.OWNER, submitted.id, 'ok by owner'),
      );
      expect(afterOwner.status).toBe('approved');

      // Independent read-back connection — proves the finalize side effects genuinely committed.
      await asRequest(
        { userId: owner, roleKey: RoleKey.OWNER, locationIds: [] },
        async (client) => {
          const loanRes = await client.query<{ outstanding: string; status: string }>(
            'SELECT outstanding, status FROM employee_loans WHERE employee_id = $1',
            [employeeId],
          );
          expect(loanRes.rows[0]!.outstanding).toBe('0.00');
          expect(loanRes.rows[0]!.status).toBe('paid_off');

          const pvRes = await client.query(
            'SELECT id, status FROM payment_verifications WHERE ref_type = $1 AND ref_id = $2',
            ['payroll_run', afterOwner.id],
          );
          expect(pvRes.rows.length).toBe(1);
          expect(pvRes.rows[0]!.status).toBe('pending');
        },
      );
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
    }
  });

  // ── Coordinator follow-up: three money-moving wiring paths, proven for real ──

  it('statutory ON: effective-dated BPJS/TER config wires real amounts, and vintage selection picks the window containing the PERIOD END DATE', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };

    const savedStatutory = await readSettingValue('payroll.statutory');
    // Readiness requires EVERY active employee to carry a tax profile — neutralize the seed's other
    // ~130 active employees so this test's ONE employee is the whole population the readiness check
    // has to satisfy. This is a REAL, committed mutation of shared seed state (not a rollback), so it
    // MUST be restored in `finally` — captured by id up front, exactly like the settings-leak the
    // ticket warns about, just on `employees.employment_status` instead of `settings`.
    const resignedIds = await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
      const before = await client.query<{ id: string }>(
        `SELECT id FROM employees WHERE employment_status = 'active'`,
      );
      await client.query(
        `UPDATE employees SET employment_status = 'resigned' WHERE employment_status = 'active'`,
      );
      return before.rows.map((r) => r.id);
    });

    let employeeId: string | undefined;
    let periodId: string | undefined;
    try {
      employeeId = await insertEmployeeFixture(actor, 'Statutory On Employee', {
        joinDate: '2019-02-01',
        baseSalary: '10000000.00',
      });
      await setSettingValueCommitted('payroll.statutory', {
        enabled: true,
        enabledAt: '2019-01-01T00:00:00Z',
        enabledBy: null,
      });

      await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
        // BPJS kesehatan: TWO vintages with DIFFERENT rates — an old, CLOSED window that must be
        // rejected, and the current, open one that must win because it's the one whose
        // [effective_from, effective_to] window actually contains the period END DATE (2019-04-30).
        await client.query(
          `INSERT INTO bpjs_configs (program, employer_pct, employee_pct, effective_from, effective_to) VALUES
             ('kesehatan', '1.000', '0.500', '2018-01-01', '2018-12-31'),
             ('kesehatan', '4.000', '1.000', '2019-01-01', NULL),
             ('jht',       '3.700', '2.000', '2019-01-01', NULL),
             ('jkk',       '0.200', '0.000', '2019-01-01', NULL),
             ('jkm',       '0.300', '0.000', '2019-01-01', NULL),
             ('jp',        '2.000', '1.000', '2019-01-01', NULL)`,
        );
        await client.query(
          `INSERT INTO pph21_ter_rates (category, bracket_min, bracket_max, rate_pct, effective_from) VALUES ('A', '0.00', NULL, '5.000', '2019-01-01')`,
        );
        await client.query(
          `INSERT INTO pph21_ptkp (ptkp_code, annual_amount, ter_category, effective_from) VALUES ('TK/0', '54000000.00', 'A', '2019-01-01')`,
        );
        await client.query(
          `INSERT INTO pph21_article17_brackets (bracket_min, bracket_max, rate_pct, effective_from) VALUES ('0.00', NULL, '5.000', '2019-01-01')`,
        );
        await client.query(
          `INSERT INTO employee_tax_profiles (employee_id, ptkp_code, dependants_count, bpjs_enrollments) VALUES ($1, 'TK/0', 0, $2::jsonb)`,
          [
            employeeId,
            JSON.stringify({
              kesehatan: { enrolledSince: '2019-01-01', endedAt: null },
              jht: { enrolledSince: '2019-01-01', endedAt: null },
              jkk: { enrolledSince: '2019-01-01', endedAt: null },
              jkm: { enrolledSince: '2019-01-01', endedAt: null },
              jp: { enrolledSince: '2019-01-01', endedAt: null },
            }),
          ],
        );
      });

      const status = await asRequest({ ...actor, locationIds: [] }, (client) =>
        statutory.getStatus(client),
      );
      expect(
        status.ready,
        `readiness should be satisfied: missing=${JSON.stringify(status.missing)}`,
      ).toBe(true);

      const period = await asRequest({ ...actor, locationIds: [] }, (client) =>
        periods.create(client, '2019-04'),
      ); // end date 2019-04-30 — inside the CURRENT kesehatan window only
      periodId = period.id;
      const run = await asRequest({ ...actor, locationIds: [] }, (client) =>
        runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
      );

      expect(run.statutoryMode).toBe(true);
      expect(run.totalGross).toBe('10000000.00'); // base salary only — no attendance/other components
      expect(run.totalEmployerCost).toBe('1020000.00'); // 400,000 (kesehatan) + 370,000 (jht) + 20,000 (jkk) + 30,000 (jkm) + 200,000 (jp)
      expect(run.totalDeductions).toBe('900000.00'); // 400,000 BPJS employee (100k+200k+100k) + 500,000 pph21
      expect(run.totalNet).toBe('9100000.00');

      const lines = (run as any).employees[0]!.lines;
      const byCode = new Map(lines.map((l: any) => [l.componentCode, l.amount]));

      expect(byCode.get('bpjs_kesehatan_employee')).toBe('100000.00');
      expect(byCode.get('bpjs_kesehatan_employer')).toBe('400000.00');
      expect(byCode.get('bpjs_jht_employee')).toBe('200000.00');
      expect(byCode.get('bpjs_jht_employer')).toBe('370000.00');
      expect(byCode.get('bpjs_jkk_employer')).toBe('20000.00');
      expect(byCode.has('bpjs_jkk_employee')).toBe(false); // JKK is employer-only by law
      expect(byCode.get('bpjs_jkm_employer')).toBe('30000.00');
      expect(byCode.get('bpjs_jp_employee')).toBe('100000.00');
      expect(byCode.get('bpjs_jp_employer')).toBe('200000.00');
      expect(byCode.get('pph21')).toBe('500000.00');
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
        await client.query(`DELETE FROM bpjs_configs`);
        await client.query(`DELETE FROM pph21_ter_rates`);
        await client.query(`DELETE FROM pph21_ptkp`);
        await client.query(`DELETE FROM pph21_article17_brackets`);
      });
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
      if (resignedIds.length > 0) {
        await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
          client.query(
            `UPDATE employees SET employment_status = 'active' WHERE id = ANY($1::uuid[])`,
            [resignedIds],
          ),
        );
      }
    }
  });

  it('POUT-05: an approved stock-opname shortfall becomes a real payroll deduction, attributed to the employee on shift that day', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
    const savedStatutory = await readSettingValue('payroll.statutory');
    let employeeId: string | undefined;
    let periodId: string | undefined;
    let workShiftId: string | undefined;
    let adjustmentNumber: string | undefined;
    try {
      await setSettingValueCommitted('payroll.statutory', {
        enabled: false,
        enabledAt: null,
        enabledBy: null,
      });
      employeeId = await insertEmployeeFixture(actor, 'Shortfall Employee', {
        joinDate: '2020-01-01',
        baseSalary: '5000000.00',
      });
      adjustmentNumber = `ADJ-TEST-${employeeId!.slice(0, 8)}`;

      workShiftId = await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
        // On-shift roster for the exact day the opname adjustment happened — this employee is the ONLY
        // one on shift, so the whole shortfall is attributable to them (no split ambiguity).
        const shiftDefRes = await client.query<{ id: string }>(
          `INSERT INTO work_shifts (location_id, name, start_time, end_time, break_minutes) VALUES ($1,'Test Shift','08:00','16:00',60) RETURNING id`,
          [fixtures.locationId],
        );
        await client.query(
          `INSERT INTO shift_assignments (employee_id, work_shift_id, location_id, date, assigned_by) VALUES ($1,$2,$3,'2019-05-10',$4)`,
          [employeeId, shiftDefRes.rows[0]!.id, fixtures.locationId, hrAdmin],
        );

        // The real `stock_adjustments` row W3-05 ships — `created_by`/`approved_by`/`reason` carried
        // specifically so the resulting deduction traces to a real person's approved count, not thin air.
        // NOTE: `computeStockShortfallShares` matches on (location_id, date) only, not on which test
        // created the adjustment — a stray, un-cleaned-up row from a previous run would double-count
        // the shortfall against THIS run's employee. Both `stock_adjustments` and `work_shifts` MUST
        // be cleaned up in `finally` (they are outside `cleanupCommittedRows`'s employee/period scope).
        const storageArea = await client.query<{ id: string }>(
          'SELECT id FROM storage_areas LIMIT 1',
        );
        const item = await client.query<{ id: string }>('SELECT id FROM items LIMIT 1');
        await client.query(
          `INSERT INTO stock_adjustments (adjustment_number, location_id, storage_area_id, item_id, qty_delta, unit_cost, reason, source, created_by, approved_by, applied_at)
           VALUES ($1,$2,$3,$4,'-5.000','20000.00','Opname count came up short','opname',$5,$5,'2019-05-10T10:00:00+08:00')`,
          [
            adjustmentNumber,
            fixtures.locationId,
            storageArea.rows[0]!.id,
            item.rows[0]!.id,
            hrAdmin,
          ],
        );
        return shiftDefRes.rows[0]!.id;
      });

      const period = await asRequest({ ...actor, locationIds: [] }, (client) =>
        periods.create(client, '2019-05'),
      );
      periodId = period.id;
      const run = await asRequest({ ...actor, locationIds: [] }, (client) =>
        runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
      );
      const shortfallLine = (run as any).employees[0]!.lines.find(
        (l: any) => l.componentCode === 'deduction_stock_shortfall',
      );

      expect(
        shortfallLine,
        'the approved opname shortfall must produce a deduction_stock_shortfall line',
      ).toBeDefined();
      expect(shortfallLine!.amount).toBe('100000.00'); // |qty_delta| 5.000 x unit_cost 20,000.00
      expect(shortfallLine!.sourceRefType).toBe('stock_opname');
      expect(run.totalDeductions).toBe('100000.00');
      expect(run.totalNet).toBe('4900000.00'); // 5,000,000 base - 100,000 shortfall
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      if (adjustmentNumber) {
        await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
          client.query('DELETE FROM stock_adjustments WHERE adjustment_number = $1', [
            adjustmentNumber,
          ]),
        );
      }
      if (workShiftId) {
        await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
          client.query('DELETE FROM work_shifts WHERE id = $1', [workShiftId]),
        );
      }
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
    }
  });

  it("D-19: an approved cash-variance proposal deducts once, and is marked CONSUMED on approval so a later period's run cannot deduct it again", async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const finance = fixtures.usersByRole[RoleKey.FINANCE];
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    if (!finance || !owner) return;
    const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
    const savedStatutory = await readSettingValue('payroll.statutory');
    let employeeId: string | undefined;
    let periodAId: string | undefined;
    let periodBId: string | undefined;
    try {
      await setSettingValueCommitted('payroll.statutory', {
        enabled: false,
        enabledAt: null,
        enabledBy: null,
      });
      employeeId = await insertEmployeeFixture(actor, 'Cash Variance Employee', {
        joinDate: '2020-01-01',
        baseSalary: '5000000.00',
      });

      const proposalId = await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
        const shiftRes = await client.query<{ id: string }>(
          `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, client_id)
           VALUES ($1,$2,$3,NOW(),'0.00',$4) RETURNING id`,
          [`SHIFT-CV-${employeeId!.slice(0, 8)}`, fixtures.locationId, hrAdmin, randomUUID()],
        );
        const proposalRes = await client.query<{ id: string }>(
          `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, employee_id, amount, status)
           VALUES ($1,$2,$3,$4,'75000.00','approved') RETURNING id`,
          [shiftRes.rows[0]!.id, fixtures.locationId, hrAdmin, employeeId],
        );
        return proposalRes.rows[0]!.id;
      });

      // Period A — the proposal is unconsumed (`payroll_line_id IS NULL`): it MUST appear as a
      // deduction here.
      const periodA = await asRequest({ ...actor, locationIds: [] }, (client) =>
        periods.create(client, '2019-06'),
      );
      periodAId = periodA.id;
      const runA = await asRequest({ ...actor, locationIds: [] }, (client) =>
        runs.calculateForPeriod(client, hrAdmin, periodA.id, [employeeId!]),
      );
      const cvLineA = (runA as any).employees[0]!.lines.find(
        (l: any) => l.componentCode === 'deduction_cash_variance',
      );
      expect(
        cvLineA,
        'the approved cash-variance proposal must produce a deduction line on the first run',
      ).toBeDefined();
      expect(cvLineA!.amount).toBe('75000.00');
      expect(runA.totalNet).toBe('4925000.00'); // 5,000,000 - 75,000

      await asRequest({ ...actor, locationIds: [] }, async (client) => {
        const before = await client.query<{ payroll_line_id: string | null }>(
          'SELECT payroll_line_id FROM cash_variance_proposals WHERE id = $1',
          [proposalId],
        );
        expect(before.rows[0]!.payroll_line_id).toBeNull(); // still unconsumed at calculate time — consumption is an APPROVE-time effect
      });

      // Drive run A through the real approval chain — this is what marks the proposal consumed.
      const submittedA = await asRequest({ ...actor, locationIds: [] }, (client) =>
        runs.submit(client, hrAdmin, runA.id),
      );
      await asRequest({ userId: finance, roleKey: RoleKey.FINANCE, locationIds: [] }, (client) =>
        runs.approve(client, finance, RoleKey.FINANCE, submittedA.id, 'ok'),
      );
      const approvedA = await asRequest(
        { userId: owner, roleKey: RoleKey.OWNER, locationIds: [] },
        (client) => runs.approve(client, owner, RoleKey.OWNER, submittedA.id, 'ok'),
      );
      expect(approvedA.status).toBe('approved');

      await asRequest({ ...actor, locationIds: [] }, async (client) => {
        const after = await client.query<{ payroll_line_id: string | null }>(
          'SELECT payroll_line_id FROM cash_variance_proposals WHERE id = $1',
          [proposalId],
        );
        expect(
          after.rows[0]!.payroll_line_id,
          'approval must mark the proposal consumed via payroll_line_id',
        ).not.toBeNull();
      });

      // Period B — same employee, same still-'approved'-status proposal, but NOW consumed
      // (`payroll_line_id` set): it must NOT be deducted a second time.
      const periodB = await asRequest({ ...actor, locationIds: [] }, (client) =>
        periods.create(client, '2019-07'),
      );
      periodBId = periodB.id;
      const runB = await asRequest({ ...actor, locationIds: [] }, (client) =>
        runs.calculateForPeriod(client, hrAdmin, periodB.id, [employeeId!]),
      );
      const cvLineB = (runB as any).employees[0]?.lines.find(
        (l: any) => l.componentCode === 'deduction_cash_variance',
      );

      expect(
        cvLineB,
        'a consumed cash-variance proposal must not be deducted again in a later period',
      ).toBeUndefined();
      expect(runB.totalDeductions).toBe('0.00');
      expect(runB.totalNet).toBe('5000000.00');
    } finally {
      if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      if (periodAId) await cleanupCommittedRows({ periodIds: [periodAId] });
      if (periodBId) await cleanupCommittedRows({ periodIds: [periodBId] });
      await setSettingValueCommitted(
        'payroll.statutory',
        savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
      );
    }
  });

  // ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
  //
  // Every mutating method above was reachable only through `req.dbClient` with zero real `COMMIT`
  // — `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` silently discarded every write.
  // These tests reproduce the REAL two-request shape: the mutation runs on its own connection, and a
  // GENUINELY SEPARATE connection reads it back — a service that only writes inside the guard's
  // transaction (no `withWrite`) fails these, a service that commits passes.
  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('components: create persists past its own request — a later GET (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      const code = `WTR-COMP-${randomUUID().slice(0, 8)}`;
      try {
        const created = await asRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) =>
            components.create(client, {
              code,
              name: 'WTR Test Component',
              type: 'earning',
              calcMethod: 'fixed',
              defaultAmount: '1000.00',
            }),
        );
        expect(created.code).toBe(code);

        const reread = await asRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) => components.list(client),
        );
        expect(reread.some((c) => c.code === code)).toBe(true);
      } finally {
        await asCommittedRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) => client.query('DELETE FROM salary_components WHERE code = $1', [code]),
        );
      }
    });

    it('periods: create persists past its own request — a later list (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      const periodCode = '2030-11';
      let periodId: string | undefined;
      try {
        const created = await asRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) => periods.create(client, periodCode),
        );
        periodId = created.id;
        expect(created.status).toBe('open');

        const reread = await asRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) => periods.list(client),
        );
        expect(reread.rows.some((p) => p.id === created.id)).toBe(true);
      } finally {
        if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
      }
    });

    it('statutory: putTaxProfile persists past its own request — a later getTaxProfile (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
      let employeeId: string | undefined;
      let insertedPtkp = false;
      try {
        employeeId = await insertEmployeeFixture(actor, 'Tax Profile WTR Employee', {
          joinDate: '2020-01-01',
          baseSalary: '5000000.00',
        });
        // `pph21_ptkp` carries no RLS and is shared, global config (see `statutory.service.ts`'s class
        // header) — only delete it in `finally` if THIS test is the one that created it, never a row
        // another test/run may already depend on.
        insertedPtkp = await asCommittedRequest({ ...actor, locationIds: [] }, async (client) => {
          const res = await client.query(
            `INSERT INTO pph21_ptkp (ptkp_code, annual_amount, ter_category, effective_from) VALUES ('TK/0', '54000000.00', 'A', '2019-01-01') ON CONFLICT DO NOTHING RETURNING ptkp_code`,
          );
          return res.rows.length > 0;
        });

        const written = await asRequest({ ...actor, locationIds: [] }, (client) =>
          statutory.putTaxProfile(client, hrAdmin, employeeId!, {
            ptkpCode: 'TK/0',
            dependantsCount: 1,
            bpjsEnrollments: {},
          } as any),
        );
        expect(written.ptkpCode).toBe('TK/0');

        const reread = await asRequest({ ...actor, locationIds: [] }, (client) =>
          statutory.getTaxProfile(client, employeeId!),
        );
        expect(reread.ptkpCode).toBe('TK/0');
        expect(reread.dependantsCount).toBe(1);
      } finally {
        if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
        if (insertedPtkp) {
          await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
            client.query(
              `DELETE FROM pph21_ptkp WHERE ptkp_code = 'TK/0' AND effective_from = '2019-01-01'`,
            ),
          );
        }
      }
    });

    it('loans: create + approve persist past their own requests — a later read-back (new connection) sees the disbursed loan and its payment_verification', async () => {
      if (!dbAvailable) return;
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      const finance = fixtures.usersByRole[RoleKey.FINANCE];
      const owner = fixtures.usersByRole[RoleKey.OWNER];
      const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
      if (!finance && !owner) return;

      let employeeId: string | undefined;
      let loanId: string | undefined;
      try {
        employeeId = await insertEmployeeFixture(actor, 'Loan WTR Employee', {
          joinDate: '2020-01-01',
          baseSalary: '5000000.00',
        });

        // The seed inserts one `employee_loans` row (`LOAN/202608/0001`) directly, without ever going
        // through `document_counters` — this environment's very FIRST real `loans.create()` call would
        // otherwise regenerate that exact same number (`nextLoanNumber` starts a fresh counter at 1)
        // and collide on `employee_loans_loan_number_key`. Pre-seeding the counter past the seed's
        // already-used number is test-environment setup, not a service/schema change.
        const loanPeriod = new Date().toISOString().slice(0, 7).replace('-', '');
        await asCommittedRequest({ ...actor, locationIds: [] }, (client) =>
          client.query(
            `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('LOAN', $1, 1)
             ON CONFLICT (doc_type, period) DO NOTHING`,
            [loanPeriod],
          ),
        );

        const created = await asRequest({ ...actor, locationIds: [] }, (client) =>
          loans.create(client, hrAdmin, {
            employeeId: employeeId!,
            principal: '500000.00',
            monthlyInstallment: '100000.00',
            reason: 'WTR regression',
          }),
        );
        loanId = created.id;
        expect(created.status).toBe('pending');

        // A genuinely separate connection sees the pending loan before any approval — proving
        // `create` itself committed, not merely a later step in the same chain.
        await asRequest({ ...actor, locationIds: [] }, async (client) => {
          const reread = await client.query<{ status: string }>(
            'SELECT status FROM employee_loans WHERE id = $1',
            [loanId],
          );
          expect(reread.rows[0]!.status).toBe('pending');
        });

        // Drive it through however many approval steps this chain actually has (single or two-step
        // finance->owner), each its OWN connection — the loop stops once the loan's own real status
        // (read back from a separate connection each time) says it's no longer pending.
        let current = created;
        const approverCandidates: { userId: string; roleKey: RoleKey }[] = [];
        if (finance) approverCandidates.push({ userId: finance, roleKey: RoleKey.FINANCE });
        if (owner) approverCandidates.push({ userId: owner, roleKey: RoleKey.OWNER });
        for (const approver of approverCandidates) {
          const stillPending = await asRequest(
            { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
            async (client) => {
              const r = await client.query<{ status: string }>(
                'SELECT status FROM employee_loans WHERE id = $1',
                [loanId],
              );
              return r.rows[0]!.status === 'pending';
            },
          );
          if (!stillPending) break;
          current = await asRequest(
            { userId: approver.userId, roleKey: approver.roleKey, locationIds: [] },
            (client) => loans.approve(client, approver.userId, approver.roleKey, current.id, 'ok'),
          );
        }

        // Final, genuinely separate read-back connection — proves the disbursement's
        // `payment_verifications` row genuinely committed. Read as the final approver
        // (owner/finance), not HR Admin — `payment_verifications` RLS is owner/manager/finance-only
        // (see `loans.service.ts`'s class header), so an HR Admin session would silently see zero
        // rows here regardless of whether the row committed.
        const finalApprover = approverCandidates[approverCandidates.length - 1]!;
        await asRequest(
          { userId: finalApprover.userId, roleKey: finalApprover.roleKey, locationIds: [] },
          async (client) => {
            const loanRow = await client.query<{ status: string; outstanding: string }>(
              'SELECT status, outstanding FROM employee_loans WHERE id = $1',
              [loanId],
            );
            expect(loanRow.rows[0]!.status).toBe('active');
            expect(loanRow.rows[0]!.outstanding).toBe('500000.00');

            const pvRow = await client.query(
              'SELECT id FROM payment_verifications WHERE ref_type = $1 AND ref_id = $2',
              ['other', loanId],
            );
            expect(pvRow.rows.length).toBe(1);
          },
        );
      } finally {
        if (loanId) await cleanupCommittedRows({ loanIds: [loanId] });
        if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
      }
    });

    it("a Kasir can raise and read their OWN kasbon — and sees nobody else's (W7 employee interface)", async () => {
      // The `employee` interface's Pinjaman tab (owner, 2026-08-21). This is the
      // test that matters for migration 228: `employee_loans`' WITH CHECK was
      // office-only, so the INSERT — and the `approval_id` UPDATE the service
      // makes immediately after it — both had to be allowed for the BORROWER
      // without opening the door to rewriting an active loan. Running it under a
      // real Kasir session is the only way to prove the carve-out works, since
      // an owner session passes every policy trivially.
      if (!dbAvailable) return;
      const kasirUserId = fixtures.usersByRole[RoleKey.KASIR];
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      if (!kasirUserId) return;

      // The seeded Kasir must be linked to an employee row for a self-service
      // request to mean anything; if that ever stops being true the test says so.
      const ownEmployee = await asRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        async (client) => {
          const r = await client.query<{ id: string }>(
            'SELECT id FROM employees WHERE user_id = $1',
            [kasirUserId],
          );
          return r.rows[0]?.id;
        },
      );
      expect(ownEmployee, 'seeded kasir must have an employees row').toBeTruthy();

      // Same document_counters pre-seed the loans WTR test documents above.
      const loanPeriod = new Date().toISOString().slice(0, 7).replace('-', '');
      await asCommittedRequest(
        { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
        (client) =>
          client.query(
            `INSERT INTO document_counters (doc_type, period, last_number) VALUES ('LOAN', $1, 1)
             ON CONFLICT (doc_type, period) DO NOTHING`,
            [loanPeriod],
          ),
      );

      let loanId: string | undefined;
      try {
        const kasirSession = {
          userId: kasirUserId,
          roleKey: RoleKey.KASIR,
          locationIds: [fixtures.locationId],
        };

        const requested = await asRequest(kasirSession, (client) =>
          loans.requestOwn(client, kasirUserId, {
            principal: '300000.00',
            monthlyInstallment: '100000.00',
            reason: 'biaya sekolah anak',
          }),
        );
        loanId = requested.id;

        // Lands pending — the borrower cannot advance their own request.
        expect(requested.status).toBe('pending');
        expect(requested.principal).toBe('300000.00');
        expect(requested.outstanding).toBe('300000.00');

        const own = await asRequest(kasirSession, (client) => loans.listOwn(client, kasirUserId));
        expect(own.rows.some((l) => l.id === loanId)).toBe(true);
        // RLS, not a WHERE clause the caller could drop: everything visible to
        // this session belongs to this employee.
        await asRequest(kasirSession, async (client) => {
          const visible = await client.query<{ employee_id: string }>(
            'SELECT employee_id FROM employee_loans',
          );
          for (const row of visible.rows) expect(row.employee_id).toBe(ownEmployee);
        });

        // And the borrower still cannot rewrite a loan that is no longer a
        // pending request — the `employee_loans_self_amend` policy's USING
        // clause is what stops "reset my own debt".
        await asCommittedRequest(
          { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] },
          (client) =>
            client.query(
              `UPDATE employee_loans SET status = 'active', outstanding = '250000.00' WHERE id = $1`,
              [loanId],
            ),
        );
        await expect(
          asRequest(kasirSession, (client) =>
            client.query(
              `UPDATE employee_loans SET outstanding = principal, status = 'pending' WHERE id = $1`,
              [loanId],
            ),
          ),
          // Postgres refuses the write outright: the row is VISIBLE to this
          // session (`employee_loans_scope`'s USING carries a self clause), but
          // no policy's WITH CHECK admits the new version of it, since the
          // borrower has INSERT only. A bare "permission denied"-class error is
          // the right answer here — nothing silently updates zero rows.
        ).rejects.toThrow(/row-level security/i);
      } finally {
        if (loanId) await cleanupCommittedRows({ loanIds: [loanId] });
      }
    });

    it('runs: calculateForPeriod persists past its own request — a later getRunDetail (new connection) sees the calculated lines', async () => {
      if (!dbAvailable) return;
      const hrAdmin =
        fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
      const actor = { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN };
      const savedStatutory = await readSettingValue('payroll.statutory');
      let employeeId: string | undefined;
      let periodId: string | undefined;
      try {
        await setSettingValueCommitted('payroll.statutory', {
          enabled: false,
          enabledAt: null,
          enabledBy: null,
        });
        // Join date close to the period itself (< 1 year tenure) — PIN-05's tenure allowance only
        // kicks in at 1+ year tiers (`DEFAULT_TENURE_TIERS`); a join date far in the past relative to
        // a future period like '2030-12' would otherwise silently add a tenure-allowance line on top
        // of the flat base salary, throwing off the exact-gross assertion below.
        employeeId = await insertEmployeeFixture(actor, 'Run WTR Employee', {
          joinDate: '2030-11-01',
          baseSalary: '5000000.00',
        });

        const period = await asRequest({ ...actor, locationIds: [] }, (client) =>
          periods.create(client, '2030-12'),
        );
        periodId = period.id;

        const calculated = await asRequest({ ...actor, locationIds: [] }, (client) =>
          runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId!]),
        );
        expect(calculated.status).toBe('calculated');

        // A GENUINELY separate connection/transaction — never sees `calculateForPeriod`'s own
        // connection's uncommitted state, only what it actually COMMITted. This is the exact shape
        // the original bug (zero `COMMIT`s in `runs.service.ts`) could not have passed: the run/lines
        // would have vanished with `RlsCleanupInterceptor`'s post-request `ROLLBACK`.
        const reread = await asRequest({ ...actor, locationIds: [] }, (client) =>
          runs.getRunDetail(client, calculated.id),
        );
        expect(reread.id).toBe(calculated.id);
        expect(reread.status).toBe('calculated');
        expect(reread.totalGross).toBe('5000000.00');
        expect(reread.employees[0]!.employee.id).toBe(employeeId);

        const periodReread = await asRequest({ ...actor, locationIds: [] }, (client) =>
          periods.list(client),
        );
        const periodRow = periodReread.rows.find((p) => p.id === period.id);
        expect(periodRow?.status).toBe('processing');
      } finally {
        if (employeeId) await cleanupCommittedRows({ employeeIds: [employeeId] });
        if (periodId) await cleanupCommittedRows({ periodIds: [periodId] });
        await setSettingValueCommitted(
          'payroll.statutory',
          savedStatutory ?? { enabled: false, enabledAt: null, enabledBy: null },
        );
      }
    });
  });
});
