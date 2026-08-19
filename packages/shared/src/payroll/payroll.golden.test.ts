/**
 * W6-04 (financial correctness) — payroll GOLDEN CASES.
 *
 * ACCEPTANCE.md §5 E6 flags this as the standing gap: "Payroll golden cases —
 * a known input produces a known payslip. NONE." `payroll.property.test.ts`
 * proves algebraic properties (statutory-off ≡ base, monotonicity, never
 * negative) over RANDOM inputs, but nothing pins one concrete, hand-verified
 * scenario end to end — the thing a payroll clerk actually needs ("if I type
 * these attendance numbers in, do I get THIS payslip"). This file is that.
 *
 * PROVENANCE WARNING (repo instruction, `database/seed-extended.ts` /
 * `TER_RATES`): the seeded PPh21 TER / BPJS / Article-17 rates are DEMO
 * values, not verified against the current PMK. Every number below is
 * either (a) picked by this test and then verified by re-deriving it from
 * the SAME configured rows the engine consumes (so the assertion is "the
 * engine computed what its own config says", never "this is the correct
 * Indonesian tax"), or (b) a pure arithmetic identity (gross = sum of
 * earnings, etc.) that holds regardless of what any rate table says. No
 * rupiah figure here is asserted as "correct PPh21" — see the module doc
 * comment in `./statutory.ts` for why that would be inventing a number this
 * agent has no authority to assert.
 */
import { describe, it, expect } from 'vitest';
import { PayrollComponentCode, PayrollComponentType } from '../enums';
import { addMoney, compareMoney, subMoney, sumMoney } from '../money';
import { calculateBasePayslip, calculatePayroll, type BasePayrollInputs } from './index';
import {
  DEFAULT_PPH21_ARTICLE17_BRACKETS,
  type BpjsProgrammeConfig,
  type EmployeeTaxProfile,
  type Pph21PtkpRow,
  type Pph21TerBracket,
  type StatutoryCalculationInputs,
} from './statutory';

// ── Golden case #1: BASE payslip only (statutory off) ──────────────────────
//
// Every number below was independently computed by hand in integer CENTS
// (never floating point) — see the ticket handoff notes for the full
// derivation. `daysInMonth: 30` is chosen so `dailyRateFromMonthlySalary`
// (ceil-rounds) produces a NON-terminating division (5,000,000 / 30 =
// 166,666.666...) — deliberately, so this golden case also pins the ceil
// rounding rule ("a daily rate must never understate what a day of pay is
// worth") rather than only exercising inputs where the division is exact.

function goldenBaseInputs(): BasePayrollInputs {
  return {
    employee: { joinDate: '2020-01-01' },
    periodEndDate: '2026-08-31',
    daysInMonth: 30,
    baseSalary: '5000000.00',
    overtimeMinutesTotal: 120, // 2h
    overtimeRatePerHour: '25000.00',
    attendance: {
      sickDays: 2,
      permissionDays: 1,
      absentDays: 1,
      lateMinutesTotal: 15,
      hasPerfectAttendance: false, // consistent with the above — not a free variable
    },
    sickPaid: false,
    permissionPaid: false,
    perLateMinuteRate: '2000.00',
    attendanceAllowanceAmount: '200000.00', // irrelevant here (hasPerfectAttendance: false), kept nonzero to prove it's correctly gated to 0
    leave: { daysTakenThisYear: 15, quotaDays: 12 }, // 3 days excess
    tenureTiers: [
      { minYears: 3, amount: '100000.00' },
      { minYears: 5, amount: '150000.00' },
    ],
    performanceIncentiveAmount: '200000.00',
    positionAllowanceAmount: '300000.00',
    otherEarningAmounts: ['50000.00'],
    stockShortfallShares: ['25000.00'],
    loans: [{ loanId: 'loan-1', outstanding: '2000000.00', monthlyInstallment: '500000.00' }],
    cashVarianceAmounts: ['20000.00'],
    otherDeductionAmounts: ['10000.00'],
  };
}

describe('golden case #1 — base payslip (statutory OFF), hand-verified in cents', () => {
  const result = calculateBasePayslip(goldenBaseInputs());

  it('gross = 5,750,000.00 (base 5,000,000 + OT 50,000 + incentive 200,000 + tenure 150,000 + position 300,000 + other-earning 50,000; attendance allowance correctly gated to 0)', () => {
    expect(result.gross).toBe('5750000.00');
  });

  it('deductions = 1,751,666.69 (dailyRate ceil(5,000,000/30)=166,666.67 driving sick×2/permission×1/absence×1/leave-excess×3, plus stock-shortfall 25,000 + loan 500,000 + late 30,000 + other-deduction 10,000 + cash-variance 20,000)', () => {
    expect(result.deductions).toBe('1751666.69');
  });

  it('net = gross − deductions = 3,998,333.31 exactly (not merely close — Money is NUMERIC(18,2), never float)', () => {
    expect(result.net).toBe('3998333.31');
    expect(result.net).toBe(subMoney(result.gross, result.deductions));
  });

  it('tenure allowance picks the 5-year tier (150,000), not the 3-year tier — years-of-service is computed off periodEndDate, not defaulted to the lowest match', () => {
    const line = result.lines.find(
      (l) => l.componentCode === PayrollComponentCode.TENURE_ALLOWANCE,
    );
    expect(line?.amount).toBe('150000.00');
  });

  it('the daily-rate-derived lines all used the SAME ceil-rounded 166,666.67 daily rate (sick=333,333.34, permission=absence=166,666.67, leave-excess=500,000.01)', () => {
    const byCode = (code: PayrollComponentCode) =>
      result.lines.find((l) => l.componentCode === code)?.amount;
    expect(byCode(PayrollComponentCode.DEDUCTION_SICK)).toBe('333333.34');
    expect(byCode(PayrollComponentCode.DEDUCTION_PERMISSION)).toBe('166666.67');
    expect(byCode(PayrollComponentCode.DEDUCTION_ABSENCE)).toBe('166666.67');
    // 3 excess days × 166,666.67 = 500,000.01 (NOT 500,000.00 — a naive "daily rate × days,
    // computed once at full precision" implementation would round differently; this pins that
    // each day-line is built from the SAME already-rounded per-day figure, catching that class
    // of regression).
    expect(byCode(PayrollComponentCode.DEDUCTION_LEAVE_EXCESS)).toBe('500000.01');
  });

  it('the loan installment line is capped at the fixed installment (500,000), not the full 2,000,000 outstanding', () => {
    expect(result.loanInstallmentsTaken).toEqual([{ loanId: 'loan-1', amount: '500000.00' }]);
  });

  it('every earning line sums to gross and every deduction line sums to deductions (the payslip reconciles to its own totals)', () => {
    const earnings = sumMoney(
      result.lines.filter((l) => l.type === PayrollComponentType.EARNING).map((l) => l.amount),
    );
    const deductions = sumMoney(
      result.lines.filter((l) => l.type === PayrollComponentType.DEDUCTION).map((l) => l.amount),
    );
    expect(earnings).toBe(result.gross);
    expect(deductions).toBe(result.deductions);
  });

  it('is deterministic and idempotent: recomputing from the same inputs is byte-identical, and calculatePayroll(inputs, false) matches calculateBasePayslip exactly', () => {
    const again = calculateBasePayslip(goldenBaseInputs());
    expect(again).toEqual(result);

    const viaFullEngine = calculatePayroll(goldenBaseInputs(), false);
    expect(viaFullEngine.gross).toBe(result.gross);
    expect(viaFullEngine.deductions).toBe(result.deductions);
    expect(viaFullEngine.net).toBe(result.net);
    expect(viaFullEngine.employerCost).toBe('0.00');
  });
});

// ── Golden case #2: statutory ON — BPJS + monthly TER, self-consistent rates ─
//
// Every BPJS %/TER bracket below is TEST-FIXTURE DATA (round numbers chosen
// so the arithmetic has no rounding ambiguity of its own — the point of this
// case is pinning the ENGINE's combination logic, not re-deriving a rate
// table). None of these percentages are asserted to be the real, current
// Indonesian BPJS/TER schedule.

const GOLDEN_BPJS_CONFIGS: BpjsProgrammeConfig[] = [
  {
    program: 'kesehatan',
    employeePct: '1.000',
    employerPct: '4.000',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
  {
    program: 'jht',
    employeePct: '2.000',
    employerPct: '3.700',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
  {
    program: 'jp',
    employeePct: '1.000',
    employerPct: '2.000',
    salaryFloor: null,
    salaryCap: '10000000.00',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
  {
    program: 'jkk',
    employeePct: '0.000',
    employerPct: '0.240',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
  {
    program: 'jkm',
    employeePct: '0.000',
    employerPct: '0.300',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

const GOLDEN_TER_RATES: Pph21TerBracket[] = [
  {
    category: 'A',
    bracketMin: '0.00',
    bracketMax: '10000000.00',
    ratePct: '5.000',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

const GOLDEN_PTKP: Pph21PtkpRow[] = [
  {
    ptkpCode: 'TK/0',
    annualAmount: '54000000.00',
    terCategory: 'A',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

function goldenTaxProfile(overrides: Partial<EmployeeTaxProfile> = {}): EmployeeTaxProfile {
  return {
    npwp: '99.999.999.9-999.000',
    ptkpCode: 'TK/0',
    dependantsCount: 0,
    bpjsEnrollments: {
      kesehatan: { enrolledSince: '2020-01-01', endedAt: null },
      jht: { enrolledSince: '2020-01-01', endedAt: null },
      jp: { enrolledSince: '2020-01-01', endedAt: null },
      jkk: { enrolledSince: '2020-01-01', endedAt: null },
      jkm: { enrolledSince: '2020-01-01', endedAt: null },
    },
    bpjsSalaryBase: null,
    ...overrides,
  };
}

describe('golden case #2 — full payslip with statutory ON, hand-verified in cents', () => {
  const base = goldenBaseInputs();
  const baseResult = calculateBasePayslip(base);
  const statutoryInputs: StatutoryCalculationInputs = {
    asOfDate: '2026-08-31',
    monthlyGross: baseResult.gross, // 5,750,000.00
    monthlyBaseSalary: base.baseSalary, // 5,000,000.00 — BPJS bases off base salary, not gross
    employeeTaxProfile: goldenTaxProfile(),
    bpjsConfigs: GOLDEN_BPJS_CONFIGS,
    pph21TerRates: GOLDEN_TER_RATES,
    pph21Ptkp: GOLDEN_PTKP,
  };
  const result = calculatePayroll(base, true, statutoryInputs);

  it('BPJS legs are exactly base-salary × configured %, both employee and employer sides (kesehatan 1%/4%, jht 2%/3.7%, jp 1%/2%, jkk/jkm employer-only 0.24%/0.30%)', () => {
    const line = (code: PayrollComponentCode) =>
      result.lines.find((l) => l.componentCode === code)?.amount;
    expect(line(PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE)).toBe('50000.00'); // 1% of 5,000,000
    expect(line(PayrollComponentCode.BPJS_KESEHATAN_EMPLOYER)).toBe('200000.00'); // 4%
    expect(line(PayrollComponentCode.BPJS_JHT_EMPLOYEE)).toBe('100000.00'); // 2%
    expect(line(PayrollComponentCode.BPJS_JHT_EMPLOYER)).toBe('185000.00'); // 3.7%
    expect(line(PayrollComponentCode.BPJS_JP_EMPLOYEE)).toBe('50000.00'); // 1%, base under the 10M cap
    expect(line(PayrollComponentCode.BPJS_JP_EMPLOYER)).toBe('100000.00'); // 2%
    expect(line(PayrollComponentCode.BPJS_JKK_EMPLOYER)).toBe('12000.00'); // 0.24%
    expect(line(PayrollComponentCode.BPJS_JKM_EMPLOYER)).toBe('15000.00'); // 0.30%
    // JKK/JKM have no employee leg at all (employer-only by law, per components.ts's comment) —
    // asserting absence, not just a zero amount.
    expect(result.lines.some((l) => l.componentCode === ('bpjs_jkk_employee' as never))).toBe(
      false,
    );
  });

  it('PPh21 (monthly TER) = 5% of monthlyGross (5,750,000 × 5% = 287,500.00) — the configured single-bracket TER category A rate applied verbatim', () => {
    const line = result.lines.find((l) => l.componentCode === PayrollComponentCode.PPH21);
    expect(line?.amount).toBe('287500.00');
  });

  it('total deductions = base deductions (1,751,666.69) + statutory deductions (kesehatan 50,000 + jht 100,000 + jp 50,000 + PPh21 287,500 = 487,500.00) = 2,239,166.69', () => {
    expect(result.deductions).toBe('2239166.69');
  });

  it('employerCost = 200,000 + 185,000 + 100,000 + 12,000 + 15,000 = 512,000.00 (employer-cost legs never touch employee net)', () => {
    expect(result.employerCost).toBe('512000.00');
  });

  it('net = gross (5,750,000.00, UNCHANGED by statutory — gross is PIN-family only) − total deductions (2,239,166.69) = 3,510,833.31', () => {
    expect(result.gross).toBe('5750000.00');
    expect(result.net).toBe('3510833.31');
    expect(result.net).toBe(subMoney(result.gross, result.deductions));
  });

  it('every EARNING line sums to gross, every DEDUCTION line (base + statutory) sums to deductions, every EMPLOYER_COST line sums to employerCost — the full payslip, statutory included, reconciles to its own totals', () => {
    const byType = (t: PayrollComponentType) =>
      sumMoney(result.lines.filter((l) => l.type === t).map((l) => l.amount));
    expect(byType(PayrollComponentType.EARNING)).toBe(result.gross);
    expect(byType(PayrollComponentType.DEDUCTION)).toBe(result.deductions);
    expect(byType(PayrollComponentType.EMPLOYER_COST)).toBe(result.employerCost);
  });

  it('recomputation is idempotent: the SAME statutory inputs produce a byte-identical result', () => {
    const again = calculatePayroll(goldenBaseInputs(), true, statutoryInputs);
    expect(again).toEqual(result);
  });
});

describe('golden case #3 — BPJS salary cap and floor are actually applied, not just accepted as config', () => {
  it('JP calculation base clamps DOWN to the configured cap: a 15,000,000 salary against a 10,000,000 cap computes 1%/2% of 10,000,000, not of 15,000,000', () => {
    const base = goldenBaseInputs();
    const highSalaryBase: BasePayrollInputs = { ...base, baseSalary: '15000000.00' };
    const baseResult = calculateBasePayslip(highSalaryBase);
    const result = calculatePayroll(highSalaryBase, true, {
      asOfDate: '2026-08-31',
      monthlyGross: baseResult.gross,
      monthlyBaseSalary: '15000000.00',
      employeeTaxProfile: goldenTaxProfile(),
      bpjsConfigs: GOLDEN_BPJS_CONFIGS,
      pph21TerRates: GOLDEN_TER_RATES,
      pph21Ptkp: GOLDEN_PTKP,
    });
    const line = (code: PayrollComponentCode) =>
      result.lines.find((l) => l.componentCode === code)?.amount;
    expect(line(PayrollComponentCode.BPJS_JP_EMPLOYEE)).toBe('100000.00'); // 1% of 10,000,000 cap, NOT 150,000 (1% of 15M)
    expect(line(PayrollComponentCode.BPJS_JP_EMPLOYER)).toBe('200000.00'); // 2% of 10,000,000 cap, NOT 300,000
  });

  it('a salary floor clamps UP: a below-floor calc base computes the % off the floor, never off the raw (lower) salary', () => {
    const floored: BpjsProgrammeConfig[] = [
      {
        program: 'kesehatan',
        employeePct: '1.000',
        employerPct: '4.000',
        salaryFloor: '2000000.00',
        salaryCap: null,
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
      },
    ];
    const base = goldenBaseInputs();
    const lowSalaryBase: BasePayrollInputs = { ...base, baseSalary: '1000000.00' };
    const baseResult = calculateBasePayslip(lowSalaryBase);
    const result = calculatePayroll(lowSalaryBase, true, {
      asOfDate: '2026-08-31',
      monthlyGross: baseResult.gross,
      monthlyBaseSalary: '1000000.00',
      employeeTaxProfile: goldenTaxProfile({
        bpjsEnrollments: { kesehatan: { enrolledSince: '2020-01-01', endedAt: null } },
      }),
      bpjsConfigs: floored,
      pph21TerRates: [],
      pph21Ptkp: [],
    });
    const line = result.lines.find(
      (l) => l.componentCode === PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE,
    );
    // 1% of the 2,000,000 FLOOR, not 1% of the actual 1,000,000 base salary (which would be 10,000.00).
    expect(line?.amount).toBe('20000.00');
  });
});

describe('golden case #4 — December Article-17 true-up, derived explicitly from the TEST-ONLY DEFAULT_PPH21_ARTICLE17_BRACKETS fixture', () => {
  // `DEFAULT_PPH21_ARTICLE17_BRACKETS`'s own doc comment: "a FALLBACK FIXTURE FOR TESTS ONLY" —
  // production must read the real `pph21_article17_brackets` table. Used here deliberately, and
  // the expected figure is derived from ITS rates (bracket 1: 5% up to 60,000,000), not from any
  // outside claim about what PPh21 should be.
  it('annualTax = 5% of taxable income (100,000,000 gross − 54,000,000 PTKP = 46,000,000, entirely inside the first 5% bracket) = 2,300,000.00; true-up = that minus prior withheld', () => {
    const result = calculatePayroll(goldenBaseInputs(), true, {
      asOfDate: '2026-12-31',
      monthlyGross: '10000000.00',
      monthlyBaseSalary: '5000000.00',
      employeeTaxProfile: goldenTaxProfile({
        bpjsEnrollments: {},
      }),
      bpjsConfigs: [],
      pph21TerRates: GOLDEN_TER_RATES,
      pph21Ptkp: GOLDEN_PTKP,
      isDecemberRun: true,
      decemberTrueUp: {
        annualGrossIncome: '100000000.00',
        priorWithheldTotal: '1500000.00',
        article17Brackets: DEFAULT_PPH21_ARTICLE17_BRACKETS,
      },
    });
    const line = result.lines.find((l) => l.componentCode === PayrollComponentCode.PPH21);
    // 2,300,000.00 (annual tax) − 1,500,000.00 (already withheld Jan–Nov via TER) = 800,000.00
    expect(line?.amount).toBe('800000.00');
  });

  it('a true-up never produces a negative/refund line: when prior withholding already exceeds the recomputed annual tax, PPh21 floors at 0.00 rather than crediting the employee', () => {
    const result = calculatePayroll(goldenBaseInputs(), true, {
      asOfDate: '2026-12-31',
      monthlyGross: '10000000.00',
      monthlyBaseSalary: '5000000.00',
      employeeTaxProfile: goldenTaxProfile({ bpjsEnrollments: {} }),
      bpjsConfigs: [],
      pph21TerRates: GOLDEN_TER_RATES,
      pph21Ptkp: GOLDEN_PTKP,
      isDecemberRun: true,
      decemberTrueUp: {
        annualGrossIncome: '100000000.00',
        priorWithheldTotal: '9000000.00', // deliberately over-withheld relative to the 2,300,000 annual tax
        article17Brackets: DEFAULT_PPH21_ARTICLE17_BRACKETS,
      },
    });
    // No PPh21 line at all when the computed amount is zero (isZero-gated in calculateStatutoryLines).
    expect(result.lines.some((l) => l.componentCode === PayrollComponentCode.PPH21)).toBe(false);
  });
});

describe('sanity: gross is never affected by whether statutory is on — PIN components alone determine it', () => {
  it('statutory ON and OFF produce the identical gross for the same base inputs', () => {
    const base = goldenBaseInputs();
    const off = calculatePayroll(base, false);
    const on = calculatePayroll(base, true, {
      asOfDate: '2026-08-31',
      monthlyGross: off.gross,
      monthlyBaseSalary: base.baseSalary,
      employeeTaxProfile: goldenTaxProfile({ bpjsEnrollments: {} }),
      bpjsConfigs: [],
      pph21TerRates: [],
      pph21Ptkp: [],
    });
    expect(compareMoney(off.gross, on.gross)).toBe(0);
    // and with zero statutory config, deductions/net are identical too (no phantom statutory lines).
    expect(on.deductions).toBe(off.deductions);
    expect(on.net).toBe(off.net);
    expect(on.employerCost).toBe('0.00');
  });
});

// Re-exercise the identity every case above relies on, once, generically — guards against a
// future edit to `calculatePayroll` accidentally decoupling `net` from `gross - deductions`.
describe('cross-cutting: net is always gross minus deductions (clamped at zero) for every golden case above', () => {
  it.each([
    ['case #1 (statutory off)', calculateBasePayslip(goldenBaseInputs())],
    [
      'case #2 (statutory on)',
      calculatePayroll(goldenBaseInputs(), true, {
        asOfDate: '2026-08-31',
        monthlyGross: calculateBasePayslip(goldenBaseInputs()).gross,
        monthlyBaseSalary: goldenBaseInputs().baseSalary,
        employeeTaxProfile: goldenTaxProfile(),
        bpjsConfigs: GOLDEN_BPJS_CONFIGS,
        pph21TerRates: GOLDEN_TER_RATES,
        pph21Ptkp: GOLDEN_PTKP,
      }),
    ],
  ])('%s', (_label, result) => {
    const expectedNet = subMoney(result.gross, result.deductions);
    const flooredExpected = compareMoney(expectedNet, '0.00') < 0 ? '0.00' : expectedNet;
    expect(result.net).toBe(flooredExpected);
    // and, when not floored, net + deductions folds exactly back to gross (no drift between the
    // aggregate fields and what the printed payslip lines actually add up to).
    if (compareMoney(expectedNet, '0.00') >= 0) {
      expect(addMoney(result.net, result.deductions)).toBe(result.gross);
    }
  });
});
