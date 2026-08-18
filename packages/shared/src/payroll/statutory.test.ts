import { describe, it, expect } from 'vitest';
import { PayrollComponentCode, PayrollComponentType } from '../enums';
import {
  DEFAULT_PPH21_ARTICLE17_BRACKETS,
  calculateBpjsLines,
  calculatePph21DecemberTrueUp,
  calculatePph21Monthly,
  calculateStatutoryLines,
  progressiveTax,
  resolveTerCategory,
  selectEffective,
  selectEffectiveArticle17Brackets,
  type BpjsProgrammeConfig,
  type EmployeeTaxProfile,
  type Pph21Article17Bracket,
  type Pph21PtkpRow,
  type Pph21TerBracket,
} from './statutory';

const BPJS_CONFIGS: BpjsProgrammeConfig[] = [
  {
    program: 'kesehatan',
    employerPct: '4.000',
    employeePct: '1.000',
    salaryFloor: null,
    salaryCap: '12000000.00',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    program: 'jht',
    employerPct: '3.700',
    employeePct: '2.000',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    program: 'jp',
    employerPct: '2.000',
    employeePct: '1.000',
    salaryFloor: null,
    salaryCap: '10000000.00',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    program: 'jkk',
    employerPct: '0.540',
    employeePct: '0.000',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    program: 'jkm',
    employerPct: '0.300',
    employeePct: '0.000',
    salaryFloor: null,
    salaryCap: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
];

const PTKP_ROWS: Pph21PtkpRow[] = [
  {
    ptkpCode: 'TK/0',
    annualAmount: '54000000.00',
    terCategory: 'A',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    ptkpCode: 'K/0',
    annualAmount: '58500000.00',
    terCategory: 'B',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
];

const TER_RATES: Pph21TerBracket[] = [
  {
    category: 'A',
    bracketMin: '0.00',
    bracketMax: '5400000.00',
    ratePct: '0.000',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    category: 'A',
    bracketMin: '5400000.00',
    bracketMax: '5650000.00',
    ratePct: '0.250',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
  {
    category: 'A',
    bracketMin: '5650000.00',
    bracketMax: null,
    ratePct: '0.500',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
];

function profile(overrides: Partial<EmployeeTaxProfile> = {}): EmployeeTaxProfile {
  return {
    npwp: '09.999.999.9-999.000',
    ptkpCode: 'TK/0',
    dependantsCount: 0,
    bpjsEnrollments: {
      kesehatan: { enrolledSince: '2026-01-01', endedAt: null },
      jht: { enrolledSince: '2026-01-01', endedAt: null },
      jp: { enrolledSince: '2026-01-01', endedAt: null },
      jkk: { enrolledSince: '2026-01-01', endedAt: null },
      jkm: { enrolledSince: '2026-01-01', endedAt: null },
    },
    bpjsSalaryBase: null,
    ...overrides,
  };
}

describe('selectEffective', () => {
  it('picks the row whose window contains the date', () => {
    const rows = [
      { effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', v: 1 },
      { effectiveFrom: '2026-01-01', effectiveTo: null, v: 2 },
    ];
    expect(selectEffective(rows, '2025-06-01')?.v).toBe(1);
    expect(selectEffective(rows, '2026-06-01')?.v).toBe(2);
    expect(selectEffective(rows, '2024-06-01')).toBeUndefined();
  });
});

describe('calculateBpjsLines', () => {
  it('computes employee + employer legs for every enrolled program, with JKK/JKM employer-only', () => {
    const lines = calculateBpjsLines(profile(), BPJS_CONFIGS, '5000000.00', '2026-08-31');
    const byCode = Object.fromEntries(lines.map((l) => [l.componentCode, l]));

    expect(byCode[PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE].amount).toBe('50000.00'); // 1% of 5,000,000
    expect(byCode[PayrollComponentCode.BPJS_KESEHATAN_EMPLOYER].amount).toBe('200000.00'); // 4% of 5,000,000
    expect(byCode[PayrollComponentCode.BPJS_JHT_EMPLOYEE].amount).toBe('100000.00'); // 2%
    expect(byCode[PayrollComponentCode.BPJS_JHT_EMPLOYER].amount).toBe('185000.00'); // 3.7%
    expect(byCode[PayrollComponentCode.BPJS_JKK_EMPLOYER].amount).toBe('27000.00'); // 0.54%
    expect(byCode[PayrollComponentCode.BPJS_JKK_EMPLOYEE]).toBeUndefined(); // employer-only, no employee key exists
    expect(byCode[PayrollComponentCode.BPJS_JKM_EMPLOYER].amount).toBe('15000.00'); // 0.3%
  });

  it('caps the calculation base at the programme salary cap', () => {
    const lines = calculateBpjsLines(profile(), BPJS_CONFIGS, '20000000.00', '2026-08-31');
    const kesehatan = lines.find(
      (l) => l.componentCode === PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE,
    )!;
    expect(kesehatan.amount).toBe('120000.00'); // 1% of the 12,000,000 cap, not the full 20,000,000
  });

  it('produces no lines for a program the employee is not enrolled in', () => {
    const lines = calculateBpjsLines(
      profile({ bpjsEnrollments: {} }),
      BPJS_CONFIGS,
      '5000000.00',
      '2026-08-31',
    );
    expect(lines).toHaveLength(0);
  });

  it('respects an enrollment end date', () => {
    const lines = calculateBpjsLines(
      profile({
        bpjsEnrollments: { kesehatan: { enrolledSince: '2026-01-01', endedAt: '2026-06-30' } },
      }),
      BPJS_CONFIGS,
      '5000000.00',
      '2026-08-31',
    );
    expect(lines).toHaveLength(0);
  });
});

describe('PPh21 TER (monthly)', () => {
  it('resolves the TER category from the PTKP code', () => {
    expect(resolveTerCategory('TK/0', PTKP_ROWS, '2026-08-31')).toBe('A');
    expect(resolveTerCategory('K/0', PTKP_ROWS, '2026-08-31')).toBe('B');
  });

  it('applies zero rate under the first bracket', () => {
    expect(calculatePph21Monthly('5000000.00', 'A', TER_RATES, '2026-08-31')).toBe('0.00');
  });

  it('applies the matching bracket rate', () => {
    expect(calculatePph21Monthly('5500000.00', 'A', TER_RATES, '2026-08-31')).toBe('13750.00'); // 0.25% of 5,500,000
    expect(calculatePph21Monthly('6000000.00', 'A', TER_RATES, '2026-08-31')).toBe('30000.00'); // 0.5% of 6,000,000
  });
});

describe('Article-17 December true-up', () => {
  const ASOF = '2026-12-31';

  it('progressiveTax walks brackets marginally', () => {
    // 100,000,000 taxable: 5% of 60M (3,000,000) + 15% of remaining 40M (6,000,000) = 9,000,000
    expect(progressiveTax('100000000.00', DEFAULT_PPH21_ARTICLE17_BRACKETS)).toBe('9000000.00');
  });

  it('is zero for non-positive taxable income', () => {
    expect(progressiveTax('0.00', DEFAULT_PPH21_ARTICLE17_BRACKETS)).toBe('0.00');
    expect(progressiveTax('-500.00', DEFAULT_PPH21_ARTICLE17_BRACKETS)).toBe('0.00');
  });

  describe('selectEffectiveArticle17Brackets — effective-dated, same rule as TER/PTKP', () => {
    it('selects the vintage whose window contains the period end date', () => {
      const rows: Pph21Article17Bracket[] = [
        {
          bracketMin: '0.00',
          bracketMax: null,
          ratePct: '10.000',
          effectiveFrom: '2020-01-01',
          effectiveTo: '2021-12-31',
        },
        ...DEFAULT_PPH21_ARTICLE17_BRACKETS,
      ];
      expect(selectEffectiveArticle17Brackets(rows, ASOF)).toEqual(
        DEFAULT_PPH21_ARTICLE17_BRACKETS,
      );
      expect(selectEffectiveArticle17Brackets(rows, '2021-06-01')).toHaveLength(1);
    });

    it('picks the most recent vintage when multiple rows are effective (a newer schedule superseding an older open-ended one)', () => {
      const older = DEFAULT_PPH21_ARTICLE17_BRACKETS; // effectiveFrom 2022-01-01, effectiveTo null
      const newer: Pph21Article17Bracket[] = [
        {
          bracketMin: '0.00',
          bracketMax: '70000000.00',
          ratePct: '5.000',
          effectiveFrom: '2027-01-01',
          effectiveTo: null,
        },
        {
          bracketMin: '70000000.00',
          bracketMax: null,
          ratePct: '20.000',
          effectiveFrom: '2027-01-01',
          effectiveTo: null,
        },
      ];
      const combined = [...older, ...newer];
      const selected = selectEffectiveArticle17Brackets(combined, '2027-12-31');
      expect(selected).toEqual(
        newer.slice().sort((a, b) => Number(a.bracketMin) - Number(b.bracketMin)),
      );
    });

    it('returns an empty array when nothing is effective at the date', () => {
      expect(selectEffectiveArticle17Brackets([], ASOF)).toEqual([]);
    });
  });

  it('subtracts prior TER withholding and never goes negative', () => {
    const trueUp = calculatePph21DecemberTrueUp(
      '114000000.00',
      '54000000.00',
      '5000000.00',
      DEFAULT_PPH21_ARTICLE17_BRACKETS,
      ASOF,
    );
    // taxable = 60,000,000 -> tax = 5% of 60,000,000 = 3,000,000; minus prior 5,000,000 -> floored at 0
    expect(trueUp).toBe('0.00');
  });

  it('produces a positive top-up when annual tax exceeds prior withholding', () => {
    const trueUp = calculatePph21DecemberTrueUp(
      '300000000.00',
      '54000000.00',
      '10000000.00',
      DEFAULT_PPH21_ARTICLE17_BRACKETS,
      ASOF,
    );
    // taxable = 246,000,000 -> 5%*60M=3,000,000 + 15%*186,000,000=27,900,000 = 30,900,000; minus 10,000,000 = 20,900,000
    expect(trueUp).toBe('20900000.00');
  });

  it('throws rather than silently defaulting when no bracket schedule is effective at the date — production must read the real table', () => {
    expect(() =>
      calculatePph21DecemberTrueUp('300000000.00', '54000000.00', '10000000.00', [], ASOF),
    ).toThrow(RangeError);
  });
});

describe('calculateStatutoryLines', () => {
  it('combines BPJS and monthly PPh21 into one line set', () => {
    const lines = calculateStatutoryLines({
      asOfDate: '2026-08-31',
      monthlyGross: '6000000.00',
      monthlyBaseSalary: '6000000.00',
      employeeTaxProfile: profile(),
      bpjsConfigs: BPJS_CONFIGS,
      pph21TerRates: TER_RATES,
      pph21Ptkp: PTKP_ROWS,
    });
    const codes = lines.map((l) => l.componentCode);
    expect(codes).toContain(PayrollComponentCode.PPH21);
    expect(codes).toContain(PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE);
    expect(
      lines.every(
        (l) =>
          l.type === PayrollComponentType.DEDUCTION ||
          l.type === PayrollComponentType.EMPLOYER_COST,
      ),
    ).toBe(true);
  });

  it('produces zero lines when the employee has no enrolments and no TER category resolves', () => {
    const lines = calculateStatutoryLines({
      asOfDate: '2026-08-31',
      monthlyGross: '6000000.00',
      monthlyBaseSalary: '6000000.00',
      employeeTaxProfile: profile({ bpjsEnrollments: {}, ptkpCode: 'UNKNOWN/CODE' }),
      bpjsConfigs: BPJS_CONFIGS,
      pph21TerRates: TER_RATES,
      pph21Ptkp: PTKP_ROWS,
    });
    expect(lines).toHaveLength(0);
  });
});
