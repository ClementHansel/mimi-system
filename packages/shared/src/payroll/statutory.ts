/**
 * D-18 / Amendment 1 — the optional PPh21 + BPJS statutory layer.
 *
 * Every function here is effective-dated (rates change annually; maintaining
 * them is the client's operational responsibility per CONTRACTS.md's
 * calculation notes, §1.7) and behind the explicit `statutoryEnabled`
 * parameter threaded through `../index`'s `calculatePayroll` — when off, this
 * module contributes nothing and the base result is unchanged (the
 * `statutoryOff ≡ base result` property test in `payroll.property.test.ts`).
 *
 * Article-17 brackets (`Pph21Article17Bracket`) are effective-dated data in
 * exactly the same shape as the TER and PTKP inputs, backed by the
 * `pph21_article17_brackets` table (block 060-069, added per architect
 * follow-up to the W1-B report's finding #5). The production path
 * (`calculateStatutoryLines` → `calculatePph21DecemberTrueUp`) selects the
 * window effective at `asOf` the same way `resolveTerCategory` does for TER —
 * it never falls back to a hardcoded schedule. `DEFAULT_PPH21_ARTICLE17_BRACKETS`
 * exists ONLY as a fallback fixture for tests that don't want to construct a
 * full effective-dated row set; production callers must supply the real
 * table content (read via the client-maintained rate-config endpoints,
 * `/api/payroll/statutory/pph21/article17` — the sibling of the TER/PTKP
 * endpoints in §4.15) or the calculation throws.
 */
import { PayrollComponentCode, PayrollComponentType } from '../enums';
import {
  compareMoney,
  isNegativeMoney,
  minMoney,
  mulMoneyByRate,
  subMoney,
  sumMoney,
  ZERO_MONEY,
} from '../money';
import { formatFixed, parseFixed } from '../decimal/fixed-point';
import type { ISODate, Money } from '../types';

export type BpjsProgram = 'kesehatan' | 'jht' | 'jkk' | 'jkm' | 'jp';

export interface EffectiveDated {
  effectiveFrom: ISODate;
  effectiveTo: ISODate | null;
}

export interface BpjsProgrammeConfig extends EffectiveDated {
  program: BpjsProgram;
  /** NUMERIC(6,3) percentage, e.g. `"4.000"` for 4%. */
  employerPct: string;
  employeePct: string;
  salaryFloor: Money | null;
  salaryCap: Money | null;
}

export interface Pph21TerBracket extends EffectiveDated {
  category: 'A' | 'B' | 'C';
  bracketMin: Money;
  /** `null` = open-ended top bracket. */
  bracketMax: Money | null;
  ratePct: string;
}

export interface Pph21PtkpRow extends EffectiveDated {
  ptkpCode: string;
  annualAmount: Money;
  terCategory: 'A' | 'B' | 'C';
}

/** Backed by `pph21_article17_brackets` (§1.7 block 060-069). Seeded with the 2022 schedule (5/15/25/30/35%, top bracket open-ended). */
export interface Pph21Article17Bracket extends EffectiveDated {
  bracketMin: Money;
  bracketMax: Money | null;
  ratePct: string;
}

export interface EmployeeTaxProfile {
  npwp: string | null;
  ptkpCode: string;
  dependantsCount: number;
  bpjsEnrollments: Partial<
    Record<BpjsProgram, { enrolledSince: ISODate; endedAt: ISODate | null }>
  >;
  /** Override base when it differs from `employments.base_salary`; `null` = use base. */
  bpjsSalaryBase: Money | null;
}

export interface StatutoryLineResult {
  componentCode: PayrollComponentCode;
  type: PayrollComponentType.DEDUCTION | PayrollComponentType.EMPLOYER_COST;
  amount: Money;
  ratePct: string | null;
}

const RATE_PCT_SCALE = 3; // matches bpjs_configs/pph21_ter_rates NUMERIC(6,3)

/** Picks the row whose `[effectiveFrom, effectiveTo]` window contains `asOf` (CONTRACTS.md §1.7 calculation note 1). */
export function selectEffective<T extends EffectiveDated>(
  rows: readonly T[],
  asOf: ISODate,
): T | undefined {
  return rows.find(
    (r) => r.effectiveFrom <= asOf && (r.effectiveTo === null || asOf <= r.effectiveTo),
  );
}

function isEnrolledAt(
  enrollment: { enrolledSince: ISODate; endedAt: ISODate | null } | undefined,
  asOf: ISODate,
): boolean {
  if (!enrollment) return false;
  return (
    enrollment.enrolledSince <= asOf && (enrollment.endedAt === null || asOf <= enrollment.endedAt)
  );
}

function clampToFloorAndCap(base: Money, floor: Money | null, cap: Money | null): Money {
  let result = base;
  if (floor !== null && compareMoney(result, floor) < 0) result = floor;
  if (cap !== null && compareMoney(result, cap) > 0) result = cap;
  return result;
}

const BPJS_COMPONENT_CODE: Record<
  BpjsProgram,
  { employee: PayrollComponentCode | null; employer: PayrollComponentCode }
> = {
  kesehatan: {
    employee: PayrollComponentCode.BPJS_KESEHATAN_EMPLOYEE,
    employer: PayrollComponentCode.BPJS_KESEHATAN_EMPLOYER,
  },
  jht: {
    employee: PayrollComponentCode.BPJS_JHT_EMPLOYEE,
    employer: PayrollComponentCode.BPJS_JHT_EMPLOYER,
  },
  jp: {
    employee: PayrollComponentCode.BPJS_JP_EMPLOYEE,
    employer: PayrollComponentCode.BPJS_JP_EMPLOYER,
  },
  // JKK/JKM are employer-only by law — no employee share exists (CONTRACTS.md §2.6).
  jkk: { employee: null, employer: PayrollComponentCode.BPJS_JKK_EMPLOYER },
  jkm: { employee: null, employer: PayrollComponentCode.BPJS_JKM_EMPLOYER },
};

/** BPJS employee + employer lines for every program the employee is enrolled in at `asOf`. */
export function calculateBpjsLines(
  profile: EmployeeTaxProfile,
  bpjsConfigs: readonly BpjsProgrammeConfig[],
  monthlyBaseSalary: Money,
  asOf: ISODate,
): StatutoryLineResult[] {
  const lines: StatutoryLineResult[] = [];
  const base = profile.bpjsSalaryBase ?? monthlyBaseSalary;

  for (const program of Object.keys(BPJS_COMPONENT_CODE) as BpjsProgram[]) {
    if (!isEnrolledAt(profile.bpjsEnrollments[program], asOf)) continue;
    const configsForProgram = bpjsConfigs.filter((c) => c.program === program);
    const config = selectEffective(configsForProgram, asOf);
    if (!config) continue; // no rate configured for this window — nothing to compute, not an error (readiness is checked upstream)

    const calcBase = clampToFloorAndCap(base, config.salaryFloor, config.salaryCap);
    const codes = BPJS_COMPONENT_CODE[program];

    if (codes.employee && parseFixed(config.employeePct, RATE_PCT_SCALE) > 0n) {
      lines.push({
        componentCode: codes.employee,
        type: PayrollComponentType.DEDUCTION,
        amount: percentOf(calcBase, config.employeePct),
        ratePct: config.employeePct,
      });
    }
    if (parseFixed(config.employerPct, RATE_PCT_SCALE) > 0n) {
      lines.push({
        componentCode: codes.employer,
        type: PayrollComponentType.EMPLOYER_COST,
        amount: percentOf(calcBase, config.employerPct),
        ratePct: config.employerPct,
      });
    }
  }

  return lines;
}

/** `base × pct%` (pct as a NUMERIC(6,3) percentage string, e.g. `"4.000"` = 4%), rounded half-up to Money scale. */
function percentOf(base: Money, pct: string): Money {
  return mulMoneyByRateAsPercent(base, pct);
}

function mulMoneyByRateAsPercent(base: Money, pct: string): Money {
  const rateScale = RATE_PCT_SCALE + 2; // percentage -> fraction needs two extra digits (÷100)
  const pctScaled = parseFixed(pct, RATE_PCT_SCALE);
  const asFraction = formatFixed(pctScaled, rateScale); // e.g. "4.000" at scale 3 reinterpreted at scale 5 == 0.04000
  return mulMoneyByRate(base, asFraction, rateScale, 'half_up');
}

/** Selects the TER category for a PTKP code effective at `asOf` (calculation note 1/2). */
export function resolveTerCategory(
  ptkpCode: string,
  ptkpRows: readonly Pph21PtkpRow[],
  asOf: ISODate,
): 'A' | 'B' | 'C' | undefined {
  return selectEffective(
    ptkpRows.filter((r) => r.ptkpCode === ptkpCode),
    asOf,
  )?.terCategory;
}

/** Monthly PPh21 = TER rate (by category) × monthly gross (calculation note 2, verbatim). */
export function calculatePph21Monthly(
  monthlyGross: Money,
  category: 'A' | 'B' | 'C',
  terRates: readonly Pph21TerBracket[],
  asOf: ISODate,
): Money {
  const candidates = terRates.filter((r) => r.category === category);
  const bracket = selectEffective(
    candidates.filter(
      (r) =>
        compareMoney(monthlyGross, r.bracketMin) >= 0 &&
        (r.bracketMax === null || compareMoney(monthlyGross, r.bracketMax) < 0),
    ),
    asOf,
  );
  if (!bracket) return ZERO_MONEY;
  return mulMoneyByRateAsPercent(monthlyGross, bracket.ratePct);
}

/**
 * The 2022 Indonesian Article-17 individual progressive schedule
 * (5/15/25/30/35%, top bracket open-ended) — a FALLBACK FIXTURE FOR TESTS
 * ONLY. Production code must read the real `pph21_article17_brackets` table
 * (client-maintained, effective-dated) via `selectEffectiveArticle17Brackets`;
 * `calculatePph21DecemberTrueUp` never substitutes this constant on its own.
 */
export const DEFAULT_PPH21_ARTICLE17_BRACKETS: readonly Pph21Article17Bracket[] = [
  {
    bracketMin: '0.00',
    bracketMax: '60000000.00',
    ratePct: '5.000',
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
  {
    bracketMin: '60000000.00',
    bracketMax: '250000000.00',
    ratePct: '15.000',
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
  {
    bracketMin: '250000000.00',
    bracketMax: '500000000.00',
    ratePct: '25.000',
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
  {
    bracketMin: '500000000.00',
    bracketMax: '5000000000.00',
    ratePct: '30.000',
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
  {
    bracketMin: '5000000000.00',
    bracketMax: null,
    ratePct: '35.000',
    effectiveFrom: '2022-01-01',
    effectiveTo: null,
  },
];

/**
 * Selects the full bracket SCHEDULE active at `asOf` — the period end date,
 * the same effective-dating rule already used for TER/PTKP (calculation note
 * 1). Article-17 differs from TER/PTKP in shape only: progressive tax needs
 * every bracket of the active vintage, not a single matching row, so this
 * picks the most-recent `effectiveFrom` among rows whose window contains
 * `asOf` and returns every row sharing that vintage, sorted ascending by
 * `bracketMin`. Returns `[]` if no row is effective at `asOf` (the caller —
 * `calculatePph21DecemberTrueUp` — treats that as a hard error, matching the
 * `payroll.statutory` readiness check's spirit: an incomplete rate table
 * should never silently under/over-tax).
 */
export function selectEffectiveArticle17Brackets(
  rows: readonly Pph21Article17Bracket[],
  asOf: ISODate,
): Pph21Article17Bracket[] {
  const active = rows.filter(
    (r) => r.effectiveFrom <= asOf && (r.effectiveTo === null || asOf <= r.effectiveTo),
  );
  if (active.length === 0) return [];
  const currentVintageFrom = active.reduce(
    (latest, r) => (r.effectiveFrom > latest ? r.effectiveFrom : latest),
    active[0]!.effectiveFrom,
  );
  return active
    .filter((r) => r.effectiveFrom === currentVintageFrom)
    .sort((a, b) => compareMoney(a.bracketMin, b.bracketMin));
}

/** Marginal progressive tax over `taxableIncome`, walking each bracket in order (never applies a bracket's rate to income below it). Expects an already-selected schedule (see `selectEffectiveArticle17Brackets`) — it does not itself filter by effective date. */
export function progressiveTax(
  taxableIncome: Money,
  brackets: readonly Pph21Article17Bracket[],
): Money {
  if (isNegativeMoney(taxableIncome) || compareMoney(taxableIncome, '0.00') === 0)
    return ZERO_MONEY;
  const amounts: Money[] = [];
  for (const bracket of brackets) {
    if (compareMoney(taxableIncome, bracket.bracketMin) <= 0) continue;
    const upper =
      bracket.bracketMax === null ? taxableIncome : minMoney(taxableIncome, bracket.bracketMax);
    const portion = subMoney(upper, bracket.bracketMin);
    if (isNegativeMoney(portion) || compareMoney(portion, '0.00') === 0) continue;
    amounts.push(mulMoneyByRateAsPercent(portion, bracket.ratePct));
  }
  return sumMoney(amounts);
}

/**
 * December Article-17 true-up (calculation note 3): progressive tax on
 * annualized income minus PTKP, minus what was already withheld Jan-Nov via
 * TER. Floored at zero — a true-up never produces a refund line here (an
 * overwithholding refund is a finance decision, not this calculator's job).
 *
 * `article17Brackets` is the FULL historical `pph21_article17_brackets`
 * table; this function selects the vintage effective at `asOf` (the period
 * end date) itself — callers must not pre-filter it and must not pass
 * `DEFAULT_PPH21_ARTICLE17_BRACKETS` in production (see that constant's doc).
 */
export function calculatePph21DecemberTrueUp(
  annualGrossIncome: Money,
  ptkpAnnualAmount: Money,
  priorWithheldTotal: Money,
  article17Brackets: readonly Pph21Article17Bracket[],
  asOf: ISODate,
): Money {
  const effectiveBrackets = selectEffectiveArticle17Brackets(article17Brackets, asOf);
  if (effectiveBrackets.length === 0) {
    throw new RangeError(
      `No effective PPh21 Article-17 bracket schedule for ${asOf} — payroll.statutory readiness check should have caught this before this run was allowed`,
    );
  }
  const taxableAnnualIncome = subMoney(annualGrossIncome, ptkpAnnualAmount);
  const annualTax = progressiveTax(taxableAnnualIncome, effectiveBrackets);
  const remaining = subMoney(annualTax, priorWithheldTotal);
  return isNegativeMoney(remaining) ? ZERO_MONEY : remaining;
}

export interface StatutoryCalculationInputs {
  asOfDate: ISODate;
  monthlyGross: Money;
  monthlyBaseSalary: Money;
  employeeTaxProfile: EmployeeTaxProfile;
  bpjsConfigs: readonly BpjsProgrammeConfig[];
  pph21TerRates: readonly Pph21TerBracket[];
  pph21Ptkp: readonly Pph21PtkpRow[];
  isDecemberRun?: boolean;
  decemberTrueUp?: {
    annualGrossIncome: Money;
    priorWithheldTotal: Money;
    /** The FULL historical `pph21_article17_brackets` table — the effective vintage is selected internally, at `asOfDate`. Required in production; there is no default. */
    article17Brackets: readonly Pph21Article17Bracket[];
  };
}

/** The full statutory line set for one employee for one period — BPJS (both legs) + PPh21 (TER, or December true-up). */
export function calculateStatutoryLines(inputs: StatutoryCalculationInputs): StatutoryLineResult[] {
  const lines = calculateBpjsLines(
    inputs.employeeTaxProfile,
    inputs.bpjsConfigs,
    inputs.monthlyBaseSalary,
    inputs.asOfDate,
  );

  const category = resolveTerCategory(
    inputs.employeeTaxProfile.ptkpCode,
    inputs.pph21Ptkp,
    inputs.asOfDate,
  );
  let pph21Amount: Money = ZERO_MONEY;
  if (category) {
    pph21Amount =
      inputs.isDecemberRun && inputs.decemberTrueUp
        ? calculatePph21DecemberTrueUp(
            inputs.decemberTrueUp.annualGrossIncome,
            selectEffective(
              inputs.pph21Ptkp.filter((r) => r.ptkpCode === inputs.employeeTaxProfile.ptkpCode),
              inputs.asOfDate,
            )?.annualAmount ?? ZERO_MONEY,
            inputs.decemberTrueUp.priorWithheldTotal,
            inputs.decemberTrueUp.article17Brackets,
            inputs.asOfDate,
          )
        : calculatePph21Monthly(
            inputs.monthlyGross,
            category,
            inputs.pph21TerRates,
            inputs.asOfDate,
          );
  }
  if (!isZero(pph21Amount)) {
    lines.push({
      componentCode: PayrollComponentCode.PPH21,
      type: PayrollComponentType.DEDUCTION,
      amount: pph21Amount,
      ratePct: null,
    });
  }

  return lines;
}

function isZero(amount: Money): boolean {
  return compareMoney(amount, '0.00') === 0;
}
