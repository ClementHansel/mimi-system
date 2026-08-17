import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_BRACKET_GAP,
  ERR_EFFECTIVE_OVERLAP,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  type Money,
  type StatutoryCalculationInputs,
  type UUID,
} from '@mimi/shared';
import { getStatutoryGate } from '../payroll-settings.util';
import type {
  PutArticle17Dto,
  PutBpjsDto,
  PutPtkpDto,
  PutTaxProfileDto,
  PutTerDto,
  TerRowDto,
} from '../dto/payroll.dto';

export interface StatutoryStatus {
  enabled: boolean;
  ready: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
  missing: ('bpjs_configs' | 'pph21_ter_rates' | 'pph21_ptkp' | 'pph21_article17_brackets' | 'employee_tax_profiles')[];
  profileCoverage: { withProfile: number; total: number };
}

/**
 * M15 `payroll` — D-18/Amendment 1 statutory config wizard (CONTRACTS §4.15).
 * `bpjs_configs`/`pph21_ter_rates`/`pph21_ptkp`/`pph21_article17_brackets`/
 * `employee_tax_profiles` carry NO RLS (§1.14 "NONE" — migration 069's
 * closing note); the `payroll.statutory.*` permission keys are this data's
 * entire access control, enforced by `@RequirePermission` at the controller.
 */
@Injectable()
export class StatutoryService {
  async getStatus(client: PoolClient): Promise<StatutoryStatus> {
    const gate = await getStatutoryGate(client);
    const missing: StatutoryStatus['missing'] = [];

    const counts = await client.query<{ bpjs: string; ter: string; ptkp: string; art17: string }>(
      `SELECT
         (SELECT COUNT(*) FROM bpjs_configs) AS bpjs,
         (SELECT COUNT(*) FROM pph21_ter_rates) AS ter,
         (SELECT COUNT(*) FROM pph21_ptkp) AS ptkp,
         (SELECT COUNT(*) FROM pph21_article17_brackets) AS art17`,
    );
    const c = counts.rows[0]!;
    if (Number(c.bpjs) === 0) missing.push('bpjs_configs');
    if (Number(c.ter) === 0) missing.push('pph21_ter_rates');
    if (Number(c.ptkp) === 0) missing.push('pph21_ptkp');
    if (Number(c.art17) === 0) missing.push('pph21_article17_brackets');

    const coverageRes = await client.query<{ total: string; with_profile: string }>(
      `SELECT
         (SELECT COUNT(*) FROM employees WHERE employment_status = 'active') AS total,
         (SELECT COUNT(*) FROM employees e JOIN employee_tax_profiles p ON p.employee_id = e.id WHERE e.employment_status = 'active') AS with_profile`,
    );
    const total = parseInt(coverageRes.rows[0]?.total ?? '0', 10);
    const withProfile = parseInt(coverageRes.rows[0]?.with_profile ?? '0', 10);
    if (withProfile < total) missing.push('employee_tax_profiles');

    return { enabled: gate.enabled, ready: missing.length === 0, enabledAt: gate.enabledAt, enabledBy: gate.enabledBy, missing, profileCoverage: { withProfile, total } };
  }

  async enable(client: PoolClient, actorUserId: UUID): Promise<StatutoryStatus> {
    const status = await this.getStatus(client);
    if (!status.ready) {
      throw new BadRequestException({ code: 'ERR_STATUTORY_NOT_READY', message: 'Statutory payroll is not ready to enable', details: { missing: status.missing } });
    }
    const enabledAt = new Date().toISOString();
    await client.query(`UPDATE settings SET value = $1::jsonb, updated_by = $2 WHERE key = 'payroll.statutory'`, [
      JSON.stringify({ enabled: true, enabledAt, enabledBy: actorUserId }),
      actorUserId,
    ]);
    return this.getStatus(client);
  }

  async disable(client: PoolClient, actorUserId: UUID, _reason: string): Promise<StatutoryStatus> {
    await client.query(`UPDATE settings SET value = $1::jsonb, updated_by = $2 WHERE key = 'payroll.statutory'`, [
      JSON.stringify({ enabled: false, enabledAt: null, enabledBy: null }),
      actorUserId,
    ]);
    return this.getStatus(client);
  }

  // ── BPJS ─────────────────────────────────────────────────────────────────

  async getBpjs(client: PoolClient, program?: string, asOf?: string) {
    const params: unknown[] = [];
    let where = '1=1';
    if (program) { params.push(program); where += ` AND program = $${params.length}`; }
    if (asOf) { params.push(asOf); where += ` AND effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to >= $${params.length})`; }
    const res = await client.query<Record<string, any>>(`SELECT * FROM bpjs_configs WHERE ${where} ORDER BY program, effective_from DESC`, params);
    return res.rows.map((r) => this.mapEffectiveDated(r, { program: r.program, employerPct: r.employer_pct, employeePct: r.employee_pct, salaryFloor: r.salary_floor, salaryCap: r.salary_cap }));
  }

  async putBpjs(client: PoolClient, dto: PutBpjsDto) {
    for (const row of dto.rows) {
      await this.closeOpenWindow(client, 'bpjs_configs', { program: row.program }, row.effectiveFrom);
      await client.query(
        `INSERT INTO bpjs_configs (program, employer_pct, employee_pct, salary_floor, salary_cap, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (program, effective_from) DO UPDATE SET employer_pct = EXCLUDED.employer_pct, employee_pct = EXCLUDED.employee_pct, salary_floor = EXCLUDED.salary_floor, salary_cap = EXCLUDED.salary_cap`,
        [row.program, row.employerPct, row.employeePct, row.salaryFloor ?? null, row.salaryCap ?? null, row.effectiveFrom],
      );
    }
    return this.getBpjs(client);
  }

  // ── PPh21 TER ────────────────────────────────────────────────────────────

  async getTer(client: PoolClient, category?: string, asOf?: string) {
    const params: unknown[] = [];
    let where = '1=1';
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    if (asOf) { params.push(asOf); where += ` AND effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to >= $${params.length})`; }
    const res = await client.query<Record<string, any>>(`SELECT * FROM pph21_ter_rates WHERE ${where} ORDER BY category, bracket_min ASC`, params);
    return res.rows.map((r) => this.mapEffectiveDated(r, { category: r.category, bracketMin: r.bracket_min, bracketMax: r.bracket_max, ratePct: r.rate_pct }));
  }

  async putTer(client: PoolClient, dto: PutTerDto) {
    this.assertContiguousBrackets(dto.rows.filter((r) => r.category === 'A'));
    this.assertContiguousBrackets(dto.rows.filter((r) => r.category === 'B'));
    this.assertContiguousBrackets(dto.rows.filter((r) => r.category === 'C'));

    for (const category of ['A', 'B', 'C'] as const) {
      await this.closeOpenWindow(client, 'pph21_ter_rates', { category }, dto.effectiveFrom);
    }
    for (const row of dto.rows) {
      await client.query(
        `INSERT INTO pph21_ter_rates (category, bracket_min, bracket_max, rate_pct, effective_from)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (category, bracket_min, effective_from) DO UPDATE SET bracket_max = EXCLUDED.bracket_max, rate_pct = EXCLUDED.rate_pct`,
        [row.category, row.bracketMin, row.bracketMax ?? null, row.ratePct, dto.effectiveFrom],
      );
    }
    return this.getTer(client);
  }

  // ── PPh21 PTKP ───────────────────────────────────────────────────────────

  async getPtkp(client: PoolClient, asOf?: string) {
    const params: unknown[] = [];
    let where = '1=1';
    if (asOf) { params.push(asOf); where += ` AND effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to >= $${params.length})`; }
    const res = await client.query<Record<string, any>>(`SELECT * FROM pph21_ptkp WHERE ${where} ORDER BY ptkp_code, effective_from DESC`, params);
    return res.rows.map((r) => this.mapEffectiveDated(r, { ptkpCode: r.ptkp_code, annualAmount: r.annual_amount, terCategory: r.ter_category }));
  }

  async putPtkp(client: PoolClient, dto: PutPtkpDto) {
    for (const row of dto.rows) {
      await this.closeOpenWindow(client, 'pph21_ptkp', { ptkp_code: row.ptkpCode }, dto.effectiveFrom);
      await client.query(
        `INSERT INTO pph21_ptkp (ptkp_code, annual_amount, ter_category, effective_from)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (ptkp_code, effective_from) DO UPDATE SET annual_amount = EXCLUDED.annual_amount, ter_category = EXCLUDED.ter_category`,
        [row.ptkpCode, row.annualAmount, row.terCategory, dto.effectiveFrom],
      );
    }
    return this.getPtkp(client);
  }

  // ── PPh21 Article 17 ─────────────────────────────────────────────────────

  async getArticle17(client: PoolClient, asOf?: string) {
    const params: unknown[] = [];
    let where = '1=1';
    if (asOf) { params.push(asOf); where += ` AND effective_from <= $${params.length} AND (effective_to IS NULL OR effective_to >= $${params.length})`; }
    const res = await client.query<Record<string, any>>(`SELECT * FROM pph21_article17_brackets WHERE ${where} ORDER BY bracket_min ASC`, params);
    return res.rows.map((r) => this.mapEffectiveDated(r, { bracketMin: r.bracket_min, bracketMax: r.bracket_max, ratePct: r.rate_pct }));
  }

  async putArticle17(client: PoolClient, dto: PutArticle17Dto) {
    this.assertContiguousBrackets(dto.rows);
    await this.closeOpenWindow(client, 'pph21_article17_brackets', {}, dto.effectiveFrom);
    for (const row of dto.rows) {
      await client.query(
        `INSERT INTO pph21_article17_brackets (bracket_min, bracket_max, rate_pct, effective_from)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (bracket_min, effective_from) DO UPDATE SET bracket_max = EXCLUDED.bracket_max, rate_pct = EXCLUDED.rate_pct`,
        [row.bracketMin, row.bracketMax ?? null, row.ratePct, dto.effectiveFrom],
      );
    }
    return this.getArticle17(client);
  }

  // ── employee tax profile ────────────────────────────────────────────────

  async getTaxProfile(client: PoolClient, employeeId: UUID) {
    const res = await client.query<Record<string, any>>('SELECT * FROM employee_tax_profiles WHERE employee_id = $1', [employeeId]);
    if (res.rows.length === 0) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'No tax profile on file for this employee' });
    return this.mapTaxProfile(res.rows[0]!);
  }

  async putTaxProfile(client: PoolClient, actorUserId: UUID, employeeId: UUID, dto: PutTaxProfileDto) {
    const ptkpRes = await client.query('SELECT 1 FROM pph21_ptkp WHERE ptkp_code = $1', [dto.ptkpCode]);
    if (ptkpRes.rows.length === 0) throw new BadRequestException({ code: ERR_VALIDATION, message: `Unknown ptkpCode '${dto.ptkpCode}'` });

    await client.query(
      `INSERT INTO employee_tax_profiles (employee_id, npwp, ptkp_code, dependants_count, bpjs_enrollments, bpjs_salary_base, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (employee_id) DO UPDATE SET npwp = EXCLUDED.npwp, ptkp_code = EXCLUDED.ptkp_code,
         dependants_count = EXCLUDED.dependants_count, bpjs_enrollments = EXCLUDED.bpjs_enrollments,
         bpjs_salary_base = EXCLUDED.bpjs_salary_base, updated_by = EXCLUDED.updated_by`,
      [employeeId, dto.npwp ?? null, dto.ptkpCode, dto.dependantsCount, JSON.stringify(dto.bpjsEnrollments ?? {}), dto.bpjsSalaryBase ?? null, actorUserId],
    );
    return this.getTaxProfile(client, employeeId);
  }

  // ── calculation input assembly (consumed by RunsService) ─────────────────

  /** Builds the full effective-dated input set `calculateStatutoryLines` needs for one employee/period. */
  async buildCalculationInputs(
    client: PoolClient,
    employeeId: UUID,
    monthlyBaseSalary: Money,
    monthlyGross: Money,
    periodEndDate: string,
  ): Promise<StatutoryCalculationInputs> {
    const profileRes = await client.query<Record<string, any>>('SELECT * FROM employee_tax_profiles WHERE employee_id = $1', [employeeId]);
    if (profileRes.rows.length === 0) {
      throw new BadRequestException({ code: 'ERR_STATUTORY_NOT_READY', message: `Employee ${employeeId} has no tax profile — the readiness check should have caught this` });
    }
    const p = profileRes.rows[0]!;

    const bpjsRes = await client.query<Record<string, any>>('SELECT * FROM bpjs_configs');
    const terRes = await client.query<Record<string, any>>('SELECT * FROM pph21_ter_rates');
    const ptkpRes = await client.query<Record<string, any>>('SELECT * FROM pph21_ptkp');

    const isDecemberRun = periodEndDate.slice(5, 7) === '12';
    let decemberTrueUp: StatutoryCalculationInputs['decemberTrueUp'];
    if (isDecemberRun) {
      const year = periodEndDate.slice(0, 4);
      const yearTotals = await client.query<{ gross: string; pph21: string }>(
        `SELECT
           COALESCE(SUM(pl.amount) FILTER (WHERE sc.type = 'earning'), 0) AS gross,
           COALESCE(SUM(pl.amount) FILTER (WHERE sc.code = 'pph21'), 0) AS pph21
         FROM payroll_lines pl
         JOIN payroll_runs r ON r.id = pl.run_id
         JOIN payroll_periods pp ON pp.id = r.period_id
         JOIN salary_components sc ON sc.id = pl.component_id
        WHERE pl.employee_id = $1 AND r.status IN ('approved','paid') AND pp.period_code LIKE $2`,
        [employeeId, `${year}-%`],
      );
      const t = yearTotals.rows[0]!;
      const annualGrossIncome = (Number(t.gross) + Number(monthlyGross)).toFixed(2) as Money;
      const priorWithheldTotal = t.pph21 as Money;
      const art17Res = await client.query<Record<string, any>>('SELECT * FROM pph21_article17_brackets');
      decemberTrueUp = {
        annualGrossIncome,
        priorWithheldTotal,
        article17Brackets: art17Res.rows.map((r) => ({ bracketMin: r.bracket_min, bracketMax: r.bracket_max, ratePct: r.rate_pct, effectiveFrom: this.dateStr(r.effective_from), effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null })),
      };
    }

    return {
      asOfDate: periodEndDate,
      monthlyGross,
      monthlyBaseSalary,
      employeeTaxProfile: {
        npwp: p.npwp ?? null,
        ptkpCode: p.ptkp_code,
        dependantsCount: p.dependants_count,
        bpjsEnrollments: p.bpjs_enrollments ?? {},
        bpjsSalaryBase: p.bpjs_salary_base ?? null,
      },
      bpjsConfigs: bpjsRes.rows.map((r) => ({ program: r.program, employerPct: r.employer_pct, employeePct: r.employee_pct, salaryFloor: r.salary_floor, salaryCap: r.salary_cap, effectiveFrom: this.dateStr(r.effective_from), effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null })),
      pph21TerRates: terRes.rows.map((r) => ({ category: r.category, bracketMin: r.bracket_min, bracketMax: r.bracket_max, ratePct: r.rate_pct, effectiveFrom: this.dateStr(r.effective_from), effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null })),
      pph21Ptkp: ptkpRes.rows.map((r) => ({ ptkpCode: r.ptkp_code, annualAmount: r.annual_amount, terCategory: r.ter_category, effectiveFrom: this.dateStr(r.effective_from), effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null })),
      isDecemberRun,
      decemberTrueUp,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async closeOpenWindow(client: PoolClient, table: string, match: Record<string, string>, newEffectiveFrom: string): Promise<void> {
    const keys = Object.keys(match);
    const conditions = keys.map((k, i) => `${k} = $${i + 2}`).join(' AND ');
    const params = [newEffectiveFrom, ...keys.map((k) => match[k])];

    // A new window may only ever be opened AFTER every existing row's `effective_from` for the same
    // key — inserting a vintage into the past would silently reorder history. CONTRACTS' `ERR_EFFECTIVE_OVERLAP`.
    const laterRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE effective_from > $1 ${conditions ? `AND ${conditions}` : ''}`,
      params,
    );
    if (parseInt(laterRes.rows[0]?.count ?? '0', 10) > 0) {
      throw new BadRequestException({ code: ERR_EFFECTIVE_OVERLAP, message: `A window already exists at or after ${newEffectiveFrom} for this key` });
    }

    await client.query(
      `UPDATE ${table} SET effective_to = $1 WHERE effective_to IS NULL AND effective_from < $1 ${conditions ? `AND ${conditions}` : ''}`,
      params,
    );
  }

  /** CONTRACTS `ERR_BRACKET_GAP` — brackets must be contiguous from 0; the top bracket must be open-ended. */
  private assertContiguousBrackets(rows: readonly (TerRowDto | { bracketMin: string; bracketMax?: string })[]): void {
    if (rows.length === 0) return;
    const sorted = [...rows].sort((a, b) => Number(a.bracketMin) - Number(b.bracketMin));
    if (Number(sorted[0]!.bracketMin) !== 0) {
      throw new BadRequestException({ code: ERR_BRACKET_GAP, message: 'The first bracket must start at 0' });
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i]!;
      const next = sorted[i + 1]!;
      if (current.bracketMax === undefined || current.bracketMax === null || Number(current.bracketMax) !== Number(next.bracketMin)) {
        throw new BadRequestException({ code: ERR_BRACKET_GAP, message: `Bracket gap between ${current.bracketMin} and ${next.bracketMin}` });
      }
    }
    const last = sorted[sorted.length - 1]!;
    if (last.bracketMax !== undefined && last.bracketMax !== null) {
      throw new BadRequestException({ code: ERR_BRACKET_GAP, message: 'The top bracket must be open-ended (bracketMax omitted)' });
    }
  }

  private mapEffectiveDated<T extends Record<string, unknown>>(r: Record<string, any>, extra: T): T & { id: UUID; effectiveFrom: string; effectiveTo: string | null } {
    return { id: r.id, ...extra, effectiveFrom: this.dateStr(r.effective_from), effectiveTo: r.effective_to ? this.dateStr(r.effective_to) : null };
  }

  private mapTaxProfile(r: Record<string, any>) {
    return {
      employeeId: r.employee_id,
      npwp: r.npwp ?? null,
      ptkpCode: r.ptkp_code,
      dependantsCount: r.dependants_count,
      bpjsEnrollments: r.bpjs_enrollments ?? {},
      bpjsSalaryBase: r.bpjs_salary_base ?? null,
    };
  }

  private dateStr(value: unknown): string {
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return value as string;
  }
}
