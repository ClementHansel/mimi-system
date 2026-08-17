/**
 * D-18 statutory payroll wizard — CONTRACTS.md §4.15 (shipped under
 * `/api/settings/statutory/*`; see `statutory.repository.ts`'s header for
 * the CONTRACTS-path deviation this agent is flagging to the architect).
 *
 * `bpjs_configs`/`pph21_*`/`employee_tax_profiles` are class X
 * (`@mimi/sync-protocol`'s authority matrix — "client-maintained via the
 * §4.15 config endpoints, online only") — no sync event on their own
 * mutations. The GATE itself (`settings['payroll.statutory']`) IS class M
 * (`SyncEntity.SETTINGS`, pull global) — `enable`/`disable` emit
 * `settings.updated` exactly like a raw settings PUT would, per CONTRACTS
 * §4.15: "flips settings payroll.statutory.enabled=true (audited; emits
 * settings.updated master event)".
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { v5 as uuidV5 } from 'uuid';
import {
  ERR_BRACKET_GAP,
  ERR_EFFECTIVE_OVERLAP,
  ERR_NOT_FOUND,
  ERR_STATUTORY_NOT_READY,
  ERR_VALIDATION,
  SyncEntity,
  type BpjsProgram,
  type ISODate,
  type Money,
  type StatutoryStatus,
} from '@mimi/shared';

/**
 * CONTRACTS.md §4.15's `TaxProfile` response shape (`GET/PUT
 * /payroll/employees/:employeeId/tax-profile`) isn't itself exported by
 * `@mimi/shared` — only the calculator input `EmployeeTaxProfile` (no
 * `employeeId`) is. Defined locally rather than widening a frozen package.
 */
export interface TaxProfile {
  employeeId: string;
  npwp: string | null;
  ptkpCode: string;
  dependantsCount: number;
  bpjsEnrollments: Partial<Record<BpjsProgram, { enrolledSince: ISODate; endedAt: ISODate | null }>>;
  bpjsSalaryBase: Money | null;
}
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SettingsRepository } from './settings.repository';
import { StatutoryRepository } from './statutory.repository';
import { validateContiguousBrackets } from './statutory-bracket.util';
import type {
  BpjsRowDto,
  DisableStatutoryDto,
  EnableStatutoryDto,
  PutArticle17Dto,
  PutBpjsDto,
  PutPtkpDto,
  PutTerDto,
  TaxProfileDto,
  TerRowDto,
} from './statutory.dto';

/** Fixed namespace for deriving a stable UUID `entityId` from the `settings.key` string (settings' real PK is a VARCHAR, but `sync_events.entity_id` is UUID NOT NULL — `payload.data.key` carries the real identity per `@mimi/sync-protocol`'s schema registry; this UUID only satisfies the column). */
const SETTINGS_ENTITY_ID_NAMESPACE = '6f5a8f0a-0a0e-4a9b-9a3a-0f7b6a6a2f10';

@Injectable()
export class StatutoryService {
  constructor(
    private readonly repo: StatutoryRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async status(client: PoolClient): Promise<StatutoryStatus> {
    const gateRow = await this.settingsRepo.findByKey(client, 'payroll.statutory');
    const gate = (gateRow?.value as { enabled: boolean; enabledAt: string | null; enabledBy: string | null } | undefined) ?? {
      enabled: false,
      enabledAt: null,
      enabledBy: null,
    };

    const missing: StatutoryStatus['missing'] = [];
    if ((await this.repo.bpjsOpenProgramCount(client)) < this.repo.bpjsProgramCount) missing.push('bpjs_configs');
    if ((await this.repo.terOpenCategoryCount(client)) < this.repo.terCategoryCount) missing.push('pph21_ter_rates');
    if ((await this.repo.ptkpOpenCount(client)) === 0) missing.push('pph21_ptkp');
    const profileCoverage = await this.repo.profileCoverage(client);
    if (profileCoverage.withProfile === 0) missing.push('employee_tax_profiles');

    let enabledByName: string | null = null;
    if (gate.enabledBy) {
      const res = await client.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [gate.enabledBy]);
      enabledByName = res.rows[0]?.name ?? null;
    }

    return {
      enabled: gate.enabled,
      ready: missing.length === 0,
      enabledAt: gate.enabledAt,
      enabledBy: enabledByName,
      missing,
      profileCoverage,
    };
  }

  // ── BPJS ─────────────────────────────────────────────────────────────────

  async listBpjs(client: PoolClient, program?: string, asOf?: string) {
    return (await this.repo.listBpjs(client, program, asOf)).map(mapBpjs);
  }

  async putBpjs(dto: PutBpjsDto, client: PoolClient) {
    for (const row of dto.rows) {
      await this.upsertOneBpjsRow(row, client);
    }
    return this.listBpjs(client);
  }

  private async upsertOneBpjsRow(row: BpjsRowDto, client: PoolClient): Promise<void> {
    const overlap = await this.repo.findOverlappingBpjs(client, row.program, row.effectiveFrom);
    const openRow = await this.repo.findOpenBpjs(client, row.program);
    if (overlap && !(openRow && overlap.id === openRow.id)) {
      throw new BadRequestException({
        code: ERR_EFFECTIVE_OVERLAP,
        message: `a '${row.program}' BPJS window already covers ${row.effectiveFrom}`,
      });
    }
    if (openRow) {
      if (row.effectiveFrom <= openRow.effective_from) {
        throw new BadRequestException({
          code: ERR_EFFECTIVE_OVERLAP,
          message: `new effectiveFrom (${row.effectiveFrom}) must be after the currently open window's start (${openRow.effective_from})`,
        });
      }
      await this.repo.closeBpjs(client, openRow.id, row.effectiveFrom);
    }
    await this.repo.insertBpjs(client, {
      program: row.program,
      employerPct: row.employerPct,
      employeePct: row.employeePct,
      salaryFloor: (row.salaryFloor as Money | undefined) ?? null,
      salaryCap: (row.salaryCap as Money | undefined) ?? null,
      effectiveFrom: row.effectiveFrom,
    });
  }

  // ── PPh21 TER ────────────────────────────────────────────────────────────

  async listTer(client: PoolClient, category?: string, asOf?: string) {
    return (await this.repo.listTer(client, category, asOf)).map(mapTer);
  }

  async putTer(dto: PutTerDto, client: PoolClient) {
    this.validateTerBrackets(dto.rows);

    const overlap = await this.repo.findOverlappingTer(client, dto.effectiveFrom);
    if (overlap && overlap.effective_to !== null) {
      // Overlaps a HISTORICAL (already-closed) window — never legal to insert into.
      throw new BadRequestException({ code: ERR_EFFECTIVE_OVERLAP, message: `effectiveFrom ${dto.effectiveFrom} falls inside an already-closed TER window` });
    }
    const openRows = await this.repo.listTer(client);
    const anyOpen = openRows.find((r) => r.effective_to === null);
    if (anyOpen && dto.effectiveFrom <= anyOpen.effective_from) {
      throw new BadRequestException({
        code: ERR_EFFECTIVE_OVERLAP,
        message: `new effectiveFrom (${dto.effectiveFrom}) must be after the currently open window's start (${anyOpen.effective_from})`,
      });
    }

    await this.repo.closeOpenTer(client, dto.effectiveFrom);
    await this.repo.insertTerRows(
      client,
      dto.effectiveFrom,
      dto.rows.map((r) => ({ category: r.category, bracketMin: r.bracketMin, bracketMax: r.bracketMax ?? null, ratePct: r.ratePct })),
    );
    return this.listTer(client);
  }

  private validateTerBrackets(rows: TerRowDto[]): void {
    const byCategory = new Map<string, TerRowDto[]>();
    for (const row of rows) {
      const list = byCategory.get(row.category) ?? [];
      list.push(row);
      byCategory.set(row.category, list);
    }
    const errors: string[] = [];
    for (const [category, categoryRows] of byCategory) {
      const bracketErrors = validateContiguousBrackets(
        categoryRows.map((r) => ({ bracketMin: r.bracketMin, bracketMax: r.bracketMax ?? null })),
        { requireOpenEndedTop: false },
      );
      errors.push(...bracketErrors.map((e) => `category ${category}: ${e}`));
    }
    if (errors.length > 0) {
      throw new BadRequestException({ code: ERR_BRACKET_GAP, message: 'PPh21 TER brackets are not contiguous from 0 per category', details: errors });
    }
  }

  // ── PPh21 PTKP ───────────────────────────────────────────────────────────

  async listPtkp(client: PoolClient, asOf?: string) {
    return (await this.repo.listPtkp(client, asOf)).map(mapPtkp);
  }

  async putPtkp(dto: PutPtkpDto, client: PoolClient) {
    const overlap = await this.repo.findOverlappingPtkp(client, dto.effectiveFrom);
    if (overlap && overlap.effective_to !== null) {
      throw new BadRequestException({ code: ERR_EFFECTIVE_OVERLAP, message: `effectiveFrom ${dto.effectiveFrom} falls inside an already-closed PTKP window` });
    }
    const rows = await this.repo.listPtkp(client);
    const anyOpen = rows.find((r) => r.effective_to === null);
    if (anyOpen && dto.effectiveFrom <= anyOpen.effective_from) {
      throw new BadRequestException({
        code: ERR_EFFECTIVE_OVERLAP,
        message: `new effectiveFrom (${dto.effectiveFrom}) must be after the currently open window's start (${anyOpen.effective_from})`,
      });
    }

    const dupes = dto.rows.filter((r, i) => dto.rows.findIndex((r2) => r2.ptkpCode === r.ptkpCode) !== i);
    if (dupes.length > 0) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `duplicate ptkpCode(s) in one PUT: ${[...new Set(dupes.map((d) => d.ptkpCode))].join(', ')}` });
    }

    await this.repo.closeOpenPtkp(client, dto.effectiveFrom);
    await this.repo.insertPtkpRows(client, dto.effectiveFrom, dto.rows);
    return this.listPtkp(client);
  }

  // ── PPh21 Article 17 ─────────────────────────────────────────────────────

  async listArticle17(client: PoolClient, asOf?: string) {
    return (await this.repo.listArticle17(client, asOf)).map(mapArticle17);
  }

  async putArticle17(dto: PutArticle17Dto, client: PoolClient) {
    const bracketErrors = validateContiguousBrackets(
      dto.rows.map((r) => ({ bracketMin: r.bracketMin, bracketMax: r.bracketMax ?? null })),
      { requireOpenEndedTop: true },
    );
    if (bracketErrors.length > 0) {
      throw new BadRequestException({ code: ERR_BRACKET_GAP, message: 'Article 17 brackets are not contiguous from 0 / not open-ended at the top', details: bracketErrors });
    }

    const overlap = await this.repo.findOverlappingArticle17(client, dto.effectiveFrom);
    if (overlap && overlap.effective_to !== null) {
      throw new BadRequestException({ code: ERR_EFFECTIVE_OVERLAP, message: `effectiveFrom ${dto.effectiveFrom} falls inside an already-closed Article-17 window` });
    }
    const rows = await this.repo.listArticle17(client);
    const anyOpen = rows.find((r) => r.effective_to === null);
    if (anyOpen && dto.effectiveFrom <= anyOpen.effective_from) {
      throw new BadRequestException({
        code: ERR_EFFECTIVE_OVERLAP,
        message: `new effectiveFrom (${dto.effectiveFrom}) must be after the currently open window's start (${anyOpen.effective_from})`,
      });
    }

    await this.repo.closeOpenArticle17(client, dto.effectiveFrom);
    await this.repo.insertArticle17Rows(
      client,
      dto.effectiveFrom,
      dto.rows.map((r) => ({ bracketMin: r.bracketMin, bracketMax: r.bracketMax ?? null, ratePct: r.ratePct })),
    );
    return this.listArticle17(client);
  }

  // ── Employee tax profile ─────────────────────────────────────────────────

  async getTaxProfile(employeeId: string, client: PoolClient): Promise<TaxProfile> {
    if (!(await this.repo.employeeExists(client, employeeId))) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Employee not found' });
    }
    const row = await this.repo.findTaxProfile(client, employeeId);
    return mapTaxProfile(employeeId, row);
  }

  async putTaxProfile(employeeId: string, dto: TaxProfileDto, caller: { sub: string }, client: PoolClient): Promise<TaxProfile> {
    if (!(await this.repo.employeeExists(client, employeeId))) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Employee not found' });
    }
    if (!(await this.repo.ptkpCodeIsValid(client, dto.ptkpCode))) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `ptkpCode '${dto.ptkpCode}' is not a currently effective PTKP code` });
    }
    await this.repo.upsertTaxProfile(client, employeeId, {
      npwp: dto.npwp ?? null,
      ptkpCode: dto.ptkpCode,
      dependantsCount: dto.dependantsCount,
      bpjsEnrollments: dto.bpjsEnrollments ?? {},
      bpjsSalaryBase: (dto.bpjsSalaryBase as Money | undefined) ?? null,
      updatedBy: caller.sub,
    });
    return this.getTaxProfile(employeeId, client);
  }

  // ── enable / disable (the gate) ─────────────────────────────────────────

  async enable(dto: EnableStatutoryDto, caller: { sub: string }, client: PoolClient): Promise<StatutoryStatus> {
    if (dto.confirm !== true) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: "'confirm' must be true to enable statutory payroll" });
    }
    const current = await this.status(client);
    if (!current.ready) {
      throw new BadRequestException({ code: ERR_STATUTORY_NOT_READY, message: 'Statutory payroll setup is not complete', details: { missing: current.missing } });
    }
    const value = { enabled: true, enabledAt: new Date().toISOString(), enabledBy: caller.sub };
    await this.settingsRepo.updateValue(client, 'payroll.statutory', value, caller.sub);
    await this.emitSettingsUpdated('payroll.statutory', value, caller.sub, client);
    return this.status(client);
  }

  async disable(dto: DisableStatutoryDto, caller: { sub: string }, client: PoolClient): Promise<StatutoryStatus> {
    const value = { enabled: false, enabledAt: null, enabledBy: null, disabledReason: dto.reason };
    await this.settingsRepo.updateValue(client, 'payroll.statutory', value, caller.sub);
    await this.emitSettingsUpdated('payroll.statutory', value, caller.sub, client);
    return this.status(client);
  }

  private async emitSettingsUpdated(key: string, value: unknown, actorUserId: string, client: PoolClient): Promise<void> {
    await this.syncEmit.emit(client, {
      entity: SyncEntity.SETTINGS,
      op: 'updated',
      entityId: uuidV5(key, SETTINGS_ENTITY_ID_NAMESPACE),
      locationId: null,
      actorUserId,
      data: { key, value },
    });
  }
}

function mapBpjs(r: Awaited<ReturnType<StatutoryRepository['listBpjs']>>[number]) {
  return {
    id: r.id,
    program: r.program,
    employerPct: r.employer_pct,
    employeePct: r.employee_pct,
    salaryFloor: r.salary_floor,
    salaryCap: r.salary_cap,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

function mapTer(r: Awaited<ReturnType<StatutoryRepository['listTer']>>[number]) {
  return {
    id: r.id,
    category: r.category,
    bracketMin: r.bracket_min,
    bracketMax: r.bracket_max,
    ratePct: r.rate_pct,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

function mapPtkp(r: Awaited<ReturnType<StatutoryRepository['listPtkp']>>[number]) {
  return {
    id: r.id,
    ptkpCode: r.ptkp_code,
    annualAmount: r.annual_amount,
    terCategory: r.ter_category,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

function mapArticle17(r: Awaited<ReturnType<StatutoryRepository['listArticle17']>>[number]) {
  return {
    id: r.id,
    bracketMin: r.bracket_min,
    bracketMax: r.bracket_max,
    ratePct: r.rate_pct,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

function mapTaxProfile(employeeId: string, row: Awaited<ReturnType<StatutoryRepository['findTaxProfile']>> | undefined): TaxProfile {
  if (!row) {
    return { employeeId, npwp: null, ptkpCode: 'TK/0', dependantsCount: 0, bpjsEnrollments: {} as TaxProfile['bpjsEnrollments'], bpjsSalaryBase: null };
  }
  return {
    employeeId,
    npwp: row.npwp,
    ptkpCode: row.ptkp_code,
    dependantsCount: row.dependants_count,
    bpjsEnrollments: row.bpjs_enrollments as TaxProfile['bpjsEnrollments'],
    bpjsSalaryBase: row.bpjs_salary_base,
  };
}
