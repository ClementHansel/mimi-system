/**
 * Raw `pg` access for the D-18 statutory payroll wizard tables
 * (`bpjs_configs`, `pph21_ter_rates`, `pph21_ptkp`, `pph21_article17_brackets`,
 * `employee_tax_profiles` — CONTRACTS.md §1.7 block 060-069, §4.15). None of
 * these tables carry RLS (migrations 067/068/200 — "NONE" group, API-gated
 * via `payroll.statutory.*`), so `request.dbClient` (already `SET LOCAL ROLE
 * app_user`-scoped by `RlsContextGuard`) reads/writes them with no further
 * session-context work needed.
 *
 * CONTRACT NOTE (flagged in the final report): CONTRACTS.md §4.15 places
 * this exact endpoint set under `/api/payroll/statutory/*` (M15 `payroll`,
 * BUILD-PLAN Wave 4, agent W4-01) — these tables are M15's domain, not M20
 * `settings`'s. Per an explicit coordinator directive this agent is shipping
 * them under `/api/settings/statutory/*` instead (still within this agent's
 * owned `modules/settings/**`; only DB tables are cross-domain, which this
 * codebase already does elsewhere — e.g. M01 reads `employees` for
 * `Me.employeeId`). Flagged for the architect/W4-01 to reconcile: either
 * amend CONTRACTS.md's path to match, or have W4-01 build a thin
 * `/api/payroll/statutory/*` alias onto this same logic rather than
 * duplicating it.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Money, UUID } from '@mimi/shared';

export interface BpjsRow {
  id: UUID;
  program: string;
  employer_pct: string;
  employee_pct: string;
  salary_floor: Money | null;
  salary_cap: Money | null;
  effective_from: string;
  effective_to: string | null;
}

export interface TerRow {
  id: UUID;
  category: string;
  bracket_min: Money;
  bracket_max: Money | null;
  rate_pct: string;
  effective_from: string;
  effective_to: string | null;
}

export interface PtkpRow {
  id: UUID;
  ptkp_code: string;
  annual_amount: Money;
  ter_category: string;
  effective_from: string;
  effective_to: string | null;
}

export interface Article17Row {
  id: UUID;
  bracket_min: Money;
  bracket_max: Money | null;
  rate_pct: string;
  effective_from: string;
  effective_to: string | null;
}

export interface TaxProfileRow {
  employee_id: UUID;
  npwp: string | null;
  ptkp_code: string;
  dependants_count: number;
  bpjs_enrollments: Record<string, { enrolledSince: string; endedAt: string | null }>;
  bpjs_salary_base: Money | null;
}

const BPJS_PROGRAMS = ['kesehatan', 'jht', 'jkk', 'jkm', 'jp'] as const;
const TER_CATEGORIES = ['A', 'B', 'C'] as const;

/**
 * `effective_from`/`effective_to` are `DATE` columns — `node-postgres`
 * parses `DATE` into a JS `Date` at LOCAL MIDNIGHT by default (no global
 * type parser is configured anywhere in this codebase), so a bare
 * `SELECT *` hands back e.g. `2026-01-01` as
 * `2025-12-31T16:00:00.000Z` (WITA is UTC+8) — silently wrong on the wire,
 * where CONTRACTS.md §0 requires plain `'YYYY-MM-DD'` strings, and WRONG for
 * in-process string comparison (`dto.effectiveFrom <= row.effective_from`
 * coerces a `Date` via `Date.prototype.toString()`, not ISO). Found live
 * while integration-testing the overlap/gap validators. Fixed HERE, per
 * query, via an explicit `::text` cast — the simplest correct fix that
 * doesn't touch shared `pg` configuration (no other file in this codebase
 * configures a type parser, so this is the existing convention, not a
 * deviation from one).
 */
const BPJS_COLUMNS = `id, program, employer_pct, employee_pct, salary_floor, salary_cap, effective_from::text, effective_to::text`;
const TER_COLUMNS = `id, category, bracket_min, bracket_max, rate_pct, effective_from::text, effective_to::text`;
const PTKP_COLUMNS = `id, ptkp_code, annual_amount, ter_category, effective_from::text, effective_to::text`;
const ARTICLE17_COLUMNS = `id, bracket_min, bracket_max, rate_pct, effective_from::text, effective_to::text`;

@Injectable()
export class StatutoryRepository {
  // ── BPJS ─────────────────────────────────────────────────────────────────

  async listBpjs(client: PoolClient, program?: string, asOf?: string): Promise<BpjsRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (program) {
      params.push(program);
      conditions.push(`program = $${params.length}`);
    }
    if (asOf) {
      params.push(asOf);
      conditions.push(`effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to > $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query<BpjsRow>(`SELECT ${BPJS_COLUMNS} FROM bpjs_configs ${where} ORDER BY program, effective_from`, params);
    return res.rows;
  }

  async findOpenBpjs(client: PoolClient, program: string): Promise<BpjsRow | undefined> {
    const res = await client.query<BpjsRow>(`SELECT ${BPJS_COLUMNS} FROM bpjs_configs WHERE program = $1 AND effective_to IS NULL`, [program]);
    return res.rows[0];
  }

  /** Any row (open or historical) for `program` whose window contains `effectiveFrom` — used for the ERR_EFFECTIVE_OVERLAP check. */
  async findOverlappingBpjs(client: PoolClient, program: string, effectiveFrom: string): Promise<BpjsRow | undefined> {
    const res = await client.query<BpjsRow>(
      `SELECT ${BPJS_COLUMNS} FROM bpjs_configs
        WHERE program = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)`,
      [program, effectiveFrom],
    );
    return res.rows[0];
  }

  async closeBpjs(client: PoolClient, id: UUID, effectiveTo: string): Promise<void> {
    await client.query(`UPDATE bpjs_configs SET effective_to = $2 WHERE id = $1`, [id, effectiveTo]);
  }

  async insertBpjs(
    client: PoolClient,
    row: { program: string; employerPct: string; employeePct: string; salaryFloor: Money | null; salaryCap: Money | null; effectiveFrom: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO bpjs_configs (program, employer_pct, employee_pct, salary_floor, salary_cap, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.program, row.employerPct, row.employeePct, row.salaryFloor, row.salaryCap, row.effectiveFrom],
    );
  }

  async bpjsOpenProgramCount(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(DISTINCT program)::text AS n FROM bpjs_configs WHERE effective_to IS NULL`,
    );
    return Number(res.rows[0]?.n ?? '0');
  }

  readonly bpjsProgramCount = BPJS_PROGRAMS.length;

  // ── PPh21 TER ────────────────────────────────────────────────────────────

  async listTer(client: PoolClient, category?: string, asOf?: string): Promise<TerRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (asOf) {
      params.push(asOf);
      conditions.push(`effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to > $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query<TerRow>(`SELECT ${TER_COLUMNS} FROM pph21_ter_rates ${where} ORDER BY category, bracket_min`, params);
    return res.rows;
  }

  /** Any TER row (any category) whose window contains `effectiveFrom` — overlap guard for the full-set replace. */
  async findOverlappingTer(client: PoolClient, effectiveFrom: string): Promise<TerRow | undefined> {
    const res = await client.query<TerRow>(
      `SELECT ${TER_COLUMNS} FROM pph21_ter_rates WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1) LIMIT 1`,
      [effectiveFrom],
    );
    return res.rows[0];
  }

  async closeOpenTer(client: PoolClient, effectiveTo: string): Promise<void> {
    await client.query(`UPDATE pph21_ter_rates SET effective_to = $1 WHERE effective_to IS NULL`, [effectiveTo]);
  }

  async insertTerRows(
    client: PoolClient,
    effectiveFrom: string,
    rows: { category: string; bracketMin: Money; bracketMax: Money | null; ratePct: string }[],
  ): Promise<void> {
    for (const row of rows) {
      await client.query(
        `INSERT INTO pph21_ter_rates (category, bracket_min, bracket_max, rate_pct, effective_from) VALUES ($1,$2,$3,$4,$5)`,
        [row.category, row.bracketMin, row.bracketMax, row.ratePct, effectiveFrom],
      );
    }
  }

  async terOpenCategoryCount(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: string }>(`SELECT COUNT(DISTINCT category)::text AS n FROM pph21_ter_rates WHERE effective_to IS NULL`);
    return Number(res.rows[0]?.n ?? '0');
  }

  readonly terCategoryCount = TER_CATEGORIES.length;

  // ── PPh21 PTKP ───────────────────────────────────────────────────────────

  async listPtkp(client: PoolClient, asOf?: string): Promise<PtkpRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (asOf) {
      params.push(asOf);
      conditions.push(`effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to > $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query<PtkpRow>(`SELECT ${PTKP_COLUMNS} FROM pph21_ptkp ${where} ORDER BY ptkp_code`, params);
    return res.rows;
  }

  async findOverlappingPtkp(client: PoolClient, effectiveFrom: string): Promise<PtkpRow | undefined> {
    const res = await client.query<PtkpRow>(
      `SELECT ${PTKP_COLUMNS} FROM pph21_ptkp WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1) LIMIT 1`,
      [effectiveFrom],
    );
    return res.rows[0];
  }

  async closeOpenPtkp(client: PoolClient, effectiveTo: string): Promise<void> {
    await client.query(`UPDATE pph21_ptkp SET effective_to = $1 WHERE effective_to IS NULL`, [effectiveTo]);
  }

  async insertPtkpRows(client: PoolClient, effectiveFrom: string, rows: { ptkpCode: string; annualAmount: Money; terCategory: string }[]): Promise<void> {
    for (const row of rows) {
      await client.query(`INSERT INTO pph21_ptkp (ptkp_code, annual_amount, ter_category, effective_from) VALUES ($1,$2,$3,$4)`, [
        row.ptkpCode,
        row.annualAmount,
        row.terCategory,
        effectiveFrom,
      ]);
    }
  }

  async ptkpOpenCount(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM pph21_ptkp WHERE effective_to IS NULL`);
    return Number(res.rows[0]?.n ?? '0');
  }

  async ptkpCodeIsValid(client: PoolClient, ptkpCode: string): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM pph21_ptkp WHERE ptkp_code = $1 AND effective_to IS NULL`, [ptkpCode]);
    return (res.rowCount ?? 0) > 0;
  }

  // ── PPh21 Article 17 (annual true-up) ───────────────────────────────────

  async listArticle17(client: PoolClient, asOf?: string): Promise<Article17Row[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (asOf) {
      params.push(asOf);
      conditions.push(`effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to > $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await client.query<Article17Row>(`SELECT ${ARTICLE17_COLUMNS} FROM pph21_article17_brackets ${where} ORDER BY bracket_min`, params);
    return res.rows;
  }

  async findOverlappingArticle17(client: PoolClient, effectiveFrom: string): Promise<Article17Row | undefined> {
    const res = await client.query<Article17Row>(
      `SELECT ${ARTICLE17_COLUMNS} FROM pph21_article17_brackets WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1) LIMIT 1`,
      [effectiveFrom],
    );
    return res.rows[0];
  }

  async closeOpenArticle17(client: PoolClient, effectiveTo: string): Promise<void> {
    await client.query(`UPDATE pph21_article17_brackets SET effective_to = $1 WHERE effective_to IS NULL`, [effectiveTo]);
  }

  async insertArticle17Rows(client: PoolClient, effectiveFrom: string, rows: { bracketMin: Money; bracketMax: Money | null; ratePct: string }[]): Promise<void> {
    for (const row of rows) {
      await client.query(`INSERT INTO pph21_article17_brackets (bracket_min, bracket_max, rate_pct, effective_from) VALUES ($1,$2,$3,$4)`, [
        row.bracketMin,
        row.bracketMax,
        row.ratePct,
        effectiveFrom,
      ]);
    }
  }

  async article17OpenCount(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM pph21_article17_brackets WHERE effective_to IS NULL`);
    return Number(res.rows[0]?.n ?? '0');
  }

  // ── Employee tax profiles (wizard step 3) ───────────────────────────────

  async findTaxProfile(client: PoolClient, employeeId: UUID): Promise<TaxProfileRow | undefined> {
    const res = await client.query<TaxProfileRow>(
      `SELECT employee_id, npwp, ptkp_code, dependants_count, bpjs_enrollments, bpjs_salary_base
         FROM employee_tax_profiles WHERE employee_id = $1`,
      [employeeId],
    );
    return res.rows[0];
  }

  async upsertTaxProfile(
    client: PoolClient,
    employeeId: UUID,
    row: {
      npwp: string | null;
      ptkpCode: string;
      dependantsCount: number;
      bpjsEnrollments: Record<string, { enrolledSince: string; endedAt: string | null }>;
      bpjsSalaryBase: Money | null;
      updatedBy: UUID;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO employee_tax_profiles (employee_id, npwp, ptkp_code, dependants_count, bpjs_enrollments, bpjs_salary_base, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (employee_id) DO UPDATE SET
         npwp = EXCLUDED.npwp, ptkp_code = EXCLUDED.ptkp_code, dependants_count = EXCLUDED.dependants_count,
         bpjs_enrollments = EXCLUDED.bpjs_enrollments, bpjs_salary_base = EXCLUDED.bpjs_salary_base,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [employeeId, row.npwp, row.ptkpCode, row.dependantsCount, JSON.stringify(row.bpjsEnrollments), row.bpjsSalaryBase, row.updatedBy],
    );
  }

  async employeeExists(client: PoolClient, employeeId: UUID): Promise<boolean> {
    const res = await client.query(`SELECT 1 FROM employees WHERE id = $1`, [employeeId]);
    return (res.rowCount ?? 0) > 0;
  }

  /** `employees` has no `is_active` boolean (found while testing) — active is `employment_status = 'active'` (CHECK constraint: active|probation|resigned|terminated). */
  async profileCoverage(client: PoolClient): Promise<{ withProfile: number; total: number }> {
    const totalRes = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM employees WHERE employment_status = 'active'`);
    const withRes = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM employee_tax_profiles etp JOIN employees e ON e.id = etp.employee_id WHERE e.employment_status = 'active'`,
    );
    return { withProfile: Number(withRes.rows[0]?.n ?? '0'), total: Number(totalRes.rows[0]?.n ?? '0') };
  }
}
