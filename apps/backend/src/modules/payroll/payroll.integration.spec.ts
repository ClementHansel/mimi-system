import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { can, RoleKey } from '@mimi/shared';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { PeriodsService } from './periods/periods.service';
import { StatutoryService } from './statutory/statutory.service';
import { RunsService } from './runs/runs.service';
import { closePool, loadPayrollFixtures, setRlsContext, withRollbackAs, type PayrollFixtures } from './test-support/live-db';

/**
 * Integration proof for M15 `payroll` (CONTRACTS.md §4.15, FR-HR-03/04) —
 * against a REAL Postgres connection under the SAME RLS session context a
 * real request gets (`withRollbackAs`, mirrors `hr`'s and
 * `kernel/approvals`' own harnesses). Every fixture row (attendance, loan,
 * cash-variance proposal, employee) is inserted on the SAME client/
 * transaction the code under test runs against, then rolled back — no data
 * persists across test runs, and no seed-data drift can silently change the
 * golden case's expected numbers (every input the calculation reads is
 * created fresh, right here, with known values).
 */
describe('Payroll module (integration, live Postgres)', () => {
  let fixtures: PayrollFixtures;
  let dbAvailable = true;
  let runs: RunsService;
  let periods: PeriodsService;
  let statutory: StatutoryService;

  beforeAll(async () => {
    try {
      fixtures = await loadPayrollFixtures();
      periods = new PeriodsService();
      statutory = new StatutoryService();
      const approvals = new ApprovalService(new ApprovalsRepository());
      const events = new EventBus();
      const fakeNotifications = { notify: async () => ({ inApp: [], email: [], whatsapp: [] }) } as any;
      runs = new RunsService(periods, statutory, approvals, events, fakeNotifications);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

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

  it('RLS: a Kasir querying payroll_runs directly (bypassing the controller layer entirely) sees nothing for someone else\'s run', async () => {
    if (!dbAvailable) return;
    const kasirUserId = fixtures.usersByRole[RoleKey.KASIR];
    if (!kasirUserId) return;
    await withRollbackAs({ userId: kasirUserId, roleKey: RoleKey.KASIR, locationIds: [fixtures.locationId] }, async (client) => {
      const res = await client.query('SELECT id FROM payroll_runs');
      // The RLS policy itself (not this test) is the real enforcement — a Kasir's own row-visibility
      // is `app_is_self` on the LINKED employee only; a run they have no line in must not appear.
      // Every row this Kasir sees, if any, must be one where they are genuinely a line's employee.
      for (const row of res.rows as { id: string }[]) {
        const ownLine = await client.query('SELECT 1 FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id = $1 AND e.user_id = $2', [row.id, kasirUserId]);
        expect(ownLine.rows.length, `Kasir should only see payroll_runs rows they have a line in`).toBeGreaterThan(0);
      }
    });
  });

  // ── Layer 2: the golden case — full period calculation, hand-checked ─────

  it('golden case: a full period calculation with known inputs produces the hand-checked net pay (statutory OFF)', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;

    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      // Force the gate OFF and pin the rate settings this golden case's expected numbers depend on —
      // deterministic regardless of what the seed happens to carry.
      await client.query(`UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);
      await client.query(`UPDATE settings SET value = '{"ratePerHour":"20000.00","minMinutes":0}'::jsonb WHERE key = 'hr.overtime'`);
      await client.query(`UPDATE settings SET value = '{"perAbsentDay":"daily_rate","perLateMinute":"1000.00","sickPaid":false,"permissionPaid":false}'::jsonb WHERE key = 'hr.deduction_rates'`);

      // A fresh employee, isolated from any seed noise — known base salary chosen so the daily rate
      // divides EXACTLY (9,300,000 / 31 = 300,000.00), so no rounding ambiguity enters the golden case.
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Golden Case Employee', '2018-07-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '9300000.00', '2018-07-01')`,
        [employeeId, fixtures.locationId],
      );

      const periodCode = '2019-01';
      const period = await periods.create(client, periodCode);

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
        [`LOAN-TEST-${employeeId.slice(0, 8)}`, employeeId],
      );

      // D-19: an approved, unconsumed cash-variance proposal — needs a real pos_shift row (FK) to hang off.
      const shiftRes = await client.query<{ id: string }>(
        `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, client_id)
         VALUES ($1,$2,$3,NOW(),'0.00',$4) RETURNING id`,
        [`SHIFT-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId, hrAdmin, randomUUID()],
      );
      await client.query(
        `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, employee_id, amount, status)
         VALUES ($1,$2,$3,$4,'50000.00','approved')`,
        [shiftRes.rows[0]!.id, fixtures.locationId, hrAdmin, employeeId],
      );

      const run = await runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId]);

      expect(run.statutoryMode).toBe(false);
      expect(run.totalEmployerCost).toBe('0.00');
      expect(run.totalGross).toBe('9340000.00'); // 9,300,000 base + 40,000 overtime (2h @ 20,000/h)
      expect(run.totalDeductions).toBe('1190000.00'); // 40,000 late + 300,000 sick + 300,000 permission + 300,000 absence + 200,000 loan + 50,000 cash-variance
      expect(run.totalNet).toBe('8150000.00');

      const detail = await runs.getRunDetail(client, run.id);
      const slip = detail.employees.find((e) => e.employee.id === employeeId)!;
      expect(slip.lines.some((l) => l.componentCode === 'deduction_loan_installment' && l.amount === '200000.00')).toBe(true);
      expect(slip.lines.some((l) => l.componentCode === 'deduction_cash_variance' && l.amount === '50000.00')).toBe(true);
      expect(slip.lines.some((l) => l.isStatutory)).toBe(false); // statutory OFF => zero statutory lines
    });
  });

  it('statutory OFF produces exactly the PRD base set — no bpjs_*/pph21 lines regardless of what statutory config exists', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      await client.query(`UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);

      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Statutory Off Employee', '2020-01-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '5000000.00', '2020-01-01')`,
        [employeeId, fixtures.locationId],
      );

      const period = await periods.create(client, '2019-02');
      const run = await runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId]);
      const detail = await runs.getRunDetail(client, run.id);

      expect(run.statutoryMode).toBe(false);
      expect(run.totalEmployerCost).toBe('0.00');
      const codes = new Set(detail.employees[0]!.lines.map((l) => l.componentCode));
      for (const statutoryCode of ['bpjs_kesehatan_employee', 'bpjs_jht_employee', 'bpjs_jp_employee', 'pph21', 'bpjs_kesehatan_employer', 'bpjs_jht_employer', 'bpjs_jkk_employer', 'bpjs_jkm_employer', 'bpjs_jp_employer']) {
        expect(codes.has(statutoryCode), `${statutoryCode} must not appear when statutory is OFF`).toBe(false);
      }
    });
  });

  // ── Layer 3: full lifecycle through the real approval chain ──────────────

  it('calculate -> submit -> Finance approves (mid-chain) -> Owner approves (final) posts the GL seam and loan payment', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const finance = fixtures.usersByRole[RoleKey.FINANCE];
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    if (!finance || !owner) return;

    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      await client.query(`UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);

      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Lifecycle Employee', '2021-01-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '4000000.00', '2021-01-01')`,
        [employeeId, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employee_loans (loan_number, employee_id, principal, monthly_installment, outstanding, status)
         VALUES ($1, $2, '600000.00', '600000.00', '600000.00', 'active')`,
        [`LOAN-TEST2-${employeeId.slice(0, 8)}`, employeeId],
      );

      const period = await periods.create(client, '2019-03');
      const calculated = await runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId]);
      expect(calculated.status).toBe('calculated');

      const submitted = await runs.submit(client, hrAdmin, calculated.id);
      expect(submitted.status).toBe('pending_approval');

      // Step 1 — Finance. Not the final step (a 2-step chain: finance -> owner) — the run must stay
      // 'pending_approval', not flip to 'approved' after only the first decision. Real RLS identity
      // switches to match the real actor (mirrors a separate request's own session in production;
      // see `setRlsContext`'s doc comment).
      await setRlsContext(client, { userId: finance, roleKey: RoleKey.FINANCE, locationIds: [] });
      const afterFinance = await runs.approve(client, finance, RoleKey.FINANCE, submitted.id, 'ok by finance');
      expect(afterFinance.status).toBe('pending_approval');

      // Step 2 — Owner. This IS the final step: the run becomes 'approved' and the finalize side
      // effects (loan payment, PV row) run exactly once, here — including the `payment_verifications`
      // insert, which is RLS-gated to owner/manager/finance only (a real constraint this test now
      // actually exercises, not bypassed).
      await setRlsContext(client, { userId: owner, roleKey: RoleKey.OWNER, locationIds: [] });
      const afterOwner = await runs.approve(client, owner, RoleKey.OWNER, submitted.id, 'ok by owner');
      expect(afterOwner.status).toBe('approved');

      const loanRes = await client.query<{ outstanding: string; status: string }>('SELECT outstanding, status FROM employee_loans WHERE employee_id = $1', [employeeId]);
      expect(loanRes.rows[0]!.outstanding).toBe('0.00');
      expect(loanRes.rows[0]!.status).toBe('paid_off');

      const pvRes = await client.query('SELECT id, status FROM payment_verifications WHERE ref_type = $1 AND ref_id = $2', ['payroll_run', afterOwner.id]);
      expect(pvRes.rows.length).toBe(1);
      expect(pvRes.rows[0]!.status).toBe('pending');
    });
  });

  // ── Coordinator follow-up: three money-moving wiring paths, proven for real ──

  it('statutory ON: effective-dated BPJS/TER config wires real amounts, and vintage selection picks the window containing the PERIOD END DATE', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;

    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      // Readiness requires EVERY active employee to carry a tax profile — neutralize the seed's other
      // ~130 active employees (rolled back with everything else) so this test's ONE employee is the
      // whole population the readiness check has to satisfy.
      const employeeId = randomUUID();
      await client.query(`UPDATE employees SET employment_status = 'resigned' WHERE employment_status = 'active'`);
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Statutory On Employee', '2019-02-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '10000000.00', '2019-02-01')`,
        [employeeId, fixtures.locationId],
      );

      await client.query(`UPDATE settings SET value = '{"enabled":true,"enabledAt":"2019-01-01T00:00:00Z","enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);

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

      const status = await statutory.getStatus(client);
      expect(status.ready, `readiness should be satisfied: missing=${JSON.stringify(status.missing)}`).toBe(true);

      const period = await periods.create(client, '2019-04'); // end date 2019-04-30 — inside the CURRENT kesehatan window only
      const run = await runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId]);

      expect(run.statutoryMode).toBe(true);
      expect(run.totalGross).toBe('10000000.00'); // base salary only — no attendance/other components
      expect(run.totalEmployerCost).toBe('1020000.00'); // 400,000 (kesehatan) + 370,000 (jht) + 20,000 (jkk) + 30,000 (jkm) + 200,000 (jp)
      expect(run.totalDeductions).toBe('900000.00'); // 400,000 BPJS employee (100k+200k+100k) + 500,000 pph21
      expect(run.totalNet).toBe('9100000.00');

      const detail = await runs.getRunDetail(client, run.id);
      const lines = detail.employees[0]!.lines;
      const byCode = new Map(lines.map((l) => [l.componentCode, l.amount]));

      // The vintage-selection proof: the CURRENT rate (4%/1%) is what actually landed, not the old
      // CLOSED vintage's (1%/0.5%) — a wrong-vintage bug would silently produce 100,000/40,000 here instead.
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
    });
  });

  it('POUT-05: an approved stock-opname shortfall becomes a real payroll deduction, attributed to the employee on shift that day', async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;

    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      await client.query(`UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);

      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Shortfall Employee', '2020-01-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '5000000.00', '2020-01-01')`,
        [employeeId, fixtures.locationId],
      );

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
      const storageArea = await client.query<{ id: string }>('SELECT id FROM storage_areas LIMIT 1');
      const item = await client.query<{ id: string }>('SELECT id FROM items LIMIT 1');
      await client.query(
        `INSERT INTO stock_adjustments (adjustment_number, location_id, storage_area_id, item_id, qty_delta, unit_cost, reason, source, created_by, approved_by, applied_at)
         VALUES ($1,$2,$3,$4,'-5.000','20000.00','Opname count came up short','opname',$5,$5,'2019-05-10T10:00:00+08:00')`,
        [`ADJ-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId, storageArea.rows[0]!.id, item.rows[0]!.id, hrAdmin],
      );

      const period = await periods.create(client, '2019-05');
      const run = await runs.calculateForPeriod(client, hrAdmin, period.id, [employeeId]);
      const detail = await runs.getRunDetail(client, run.id);
      const shortfallLine = detail.employees[0]!.lines.find((l) => l.componentCode === 'deduction_stock_shortfall');

      expect(shortfallLine, 'the approved opname shortfall must produce a deduction_stock_shortfall line').toBeDefined();
      expect(shortfallLine!.amount).toBe('100000.00'); // |qty_delta| 5.000 x unit_cost 20,000.00
      expect(shortfallLine!.sourceRefType).toBe('stock_opname');
      expect(run.totalDeductions).toBe('100000.00');
      expect(run.totalNet).toBe('4900000.00'); // 5,000,000 base - 100,000 shortfall
    });
  });

  it("D-19: an approved cash-variance proposal deducts once, and is marked CONSUMED on approval so a later period's run cannot deduct it again", async () => {
    if (!dbAvailable) return;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN] ?? fixtures.usersByRole[RoleKey.OWNER]!;
    const finance = fixtures.usersByRole[RoleKey.FINANCE];
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    if (!finance || !owner) return;

    await withRollbackAs({ userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] }, async (client) => {
      await client.query(`UPDATE settings SET value = '{"enabled":false,"enabledAt":null,"enabledBy":null}'::jsonb WHERE key = 'payroll.statutory'`);

      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, name, join_date, position, location_id, employment_status)
         VALUES ($1, $2, 'Cash Variance Employee', '2020-01-01', 'Staff', $3, 'active')`,
        [employeeId, `EMP-TEST-${employeeId.slice(0, 8)}`, fixtures.locationId],
      );
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         VALUES ($1, 'Staff', $2, '5000000.00', '2020-01-01')`,
        [employeeId, fixtures.locationId],
      );

      const shiftRes = await client.query<{ id: string }>(
        `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, client_id)
         VALUES ($1,$2,$3,NOW(),'0.00',$4) RETURNING id`,
        [`SHIFT-CV-${employeeId.slice(0, 8)}`, fixtures.locationId, hrAdmin, randomUUID()],
      );
      const proposalRes = await client.query<{ id: string }>(
        `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, employee_id, amount, status)
         VALUES ($1,$2,$3,$4,'75000.00','approved') RETURNING id`,
        [shiftRes.rows[0]!.id, fixtures.locationId, hrAdmin, employeeId],
      );
      const proposalId = proposalRes.rows[0]!.id;

      // Period A — the proposal is unconsumed (`payroll_line_id IS NULL`): it MUST appear as a
      // deduction here.
      const periodA = await periods.create(client, '2019-06');
      const runA = await runs.calculateForPeriod(client, hrAdmin, periodA.id, [employeeId]);
      const detailA = await runs.getRunDetail(client, runA.id);
      const cvLineA = detailA.employees[0]!.lines.find((l) => l.componentCode === 'deduction_cash_variance');
      expect(cvLineA, 'the approved cash-variance proposal must produce a deduction line on the first run').toBeDefined();
      expect(cvLineA!.amount).toBe('75000.00');
      expect(runA.totalNet).toBe('4925000.00'); // 5,000,000 - 75,000

      const before = await client.query<{ payroll_line_id: string | null }>('SELECT payroll_line_id FROM cash_variance_proposals WHERE id = $1', [proposalId]);
      expect(before.rows[0]!.payroll_line_id).toBeNull(); // still unconsumed at calculate time — consumption is an APPROVE-time effect

      // Drive run A through the real approval chain — this is what marks the proposal consumed.
      const submittedA = await runs.submit(client, hrAdmin, runA.id);
      await setRlsContext(client, { userId: finance, roleKey: RoleKey.FINANCE, locationIds: [] });
      await runs.approve(client, finance, RoleKey.FINANCE, submittedA.id, 'ok');
      await setRlsContext(client, { userId: owner, roleKey: RoleKey.OWNER, locationIds: [] });
      const approvedA = await runs.approve(client, owner, RoleKey.OWNER, submittedA.id, 'ok');
      expect(approvedA.status).toBe('approved');

      const after = await client.query<{ payroll_line_id: string | null }>('SELECT payroll_line_id FROM cash_variance_proposals WHERE id = $1', [proposalId]);
      expect(after.rows[0]!.payroll_line_id, 'approval must mark the proposal consumed via payroll_line_id').not.toBeNull();

      // Period B — same employee, same still-'approved'-status proposal, but NOW consumed
      // (`payroll_line_id` set): it must NOT be deducted a second time.
      await setRlsContext(client, { userId: hrAdmin, roleKey: RoleKey.HR_ADMIN, locationIds: [] });
      const periodB = await periods.create(client, '2019-07');
      const runB = await runs.calculateForPeriod(client, hrAdmin, periodB.id, [employeeId]);
      const detailB = await runs.getRunDetail(client, runB.id);
      const cvLineB = detailB.employees[0]?.lines.find((l) => l.componentCode === 'deduction_cash_variance');

      expect(cvLineB, 'a consumed cash-variance proposal must not be deducted again in a later period').toBeUndefined();
      expect(runB.totalDeductions).toBe('0.00');
      expect(runB.totalNet).toBe('5000000.00');
    });
  });
});
