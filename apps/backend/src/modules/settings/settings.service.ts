/**
 * M20 `settings` — CONTRACTS.md §4.20. `settings`/`approval_chain_steps`
 * carry no RLS (§1.14 "NONE" group) — `PermissionsGuard`
 * (`settings.read`/`settings.manage`/`settings.approval_chain.manage`) is
 * the only gate.
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { v5 as uuidV5 } from 'uuid';
import {
  ApprovalDocumentType,
  ApprovalMode,
  DEFAULT_APPROVAL_MODES,
  ERR_NOT_FOUND,
  ERR_USE_WIZARD,
  ERR_VALIDATION,
  SETTINGS_KEY_LIST,
  SyncEntity,
  type SettingsKey,
  type UUID,
} from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SettingsRepository, type ApprovalChainStepRow, type SettingRow } from './settings.repository';
import { validateSettingValue } from './settings-value-validator';
import type { ChainStepDto, PutApprovalChainDto, PutApprovalModeDto, PutSettingDto } from './settings.dto';

/** Same fixed namespace convention as `statutory.service.ts` — `sync_events.entity_id` is UUID NOT NULL but `settings.key` is a VARCHAR PK; `payload.data.key` carries the real identity. */
const SETTINGS_ENTITY_ID_NAMESPACE = '6f5a8f0a-0a0e-4a9b-9a3a-0f7b6a6a2f10';

/** `payroll.statutory` is flipped ONLY via `/api/settings/statutory/enable|disable` (D-18/Amendment 1) — CONTRACTS.md §4.20. */
const WIZARD_ONLY_KEY: SettingsKey = 'payroll.statutory';

const SETTINGS_KEY_SET = new Set<string>(SETTINGS_KEY_LIST);
const APPROVAL_DOCUMENT_TYPES = new Set<string>(Object.values(ApprovalDocumentType));

export interface SettingRes {
  key: string;
  value: unknown;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ApprovalChainRes {
  documentType: string;
  steps: { stepNo: number; approverRole: string; minAmount: string | null; maxAmount: string | null }[];
}

/** D-23 — `GET /api/settings/approval-modes` row shape. */
export interface ApprovalModeRes {
  documentType: ApprovalDocumentType;
  mode: ApprovalMode;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async list(prefix: string | undefined, client: PoolClient): Promise<SettingRes[]> {
    const rows = await this.repo.list(client, prefix);
    return rows.map(mapSetting);
  }

  async getOne(key: string, client: PoolClient): Promise<SettingRes> {
    const row = await this.repo.findByKey(client, key);
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown settings key '${key}'` });
    return mapSetting(row);
  }

  async putOne(key: string, dto: PutSettingDto, caller: { sub: string }, client: PoolClient): Promise<SettingRes> {
    if (key === WIZARD_ONLY_KEY) {
      throw new ForbiddenException({
        code: ERR_USE_WIZARD,
        message: `'${WIZARD_ONLY_KEY}' can only be changed via POST /api/settings/statutory/enable or /disable`,
      });
    }
    if (!SETTINGS_KEY_SET.has(key)) {
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown settings key '${key}'` });
    }
    const errors = validateSettingValue(key as SettingsKey, dto.value);
    if (errors.length > 0) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `Invalid value for '${key}'`, details: errors });
    }

    const updated = await this.repo.updateValue(client, key, dto.value, caller.sub);
    if (!updated) throw new NotFoundException({ code: ERR_NOT_FOUND, message: `Unknown settings key '${key}'` });

    await this.syncEmit.emit(client, {
      entity: SyncEntity.SETTINGS,
      op: 'updated',
      entityId: uuidV5(key, SETTINGS_ENTITY_ID_NAMESPACE),
      locationId: null,
      actorUserId: caller.sub,
      data: { key, value: dto.value },
    });

    return mapSetting(updated);
  }

  async listApprovalChains(client: PoolClient): Promise<ApprovalChainRes[]> {
    const rows = await this.repo.listApprovalChains(client);
    return groupChainRows(rows);
  }

  async putApprovalChain(documentType: string, dto: PutApprovalChainDto, client: PoolClient): Promise<ApprovalChainRes> {
    if (!APPROVAL_DOCUMENT_TYPES.has(documentType)) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `Unknown document type '${documentType}'` });
    }

    this.assertStepsWellFormed(dto.steps);

    const existing = await this.repo.findChainSteps(client, documentType);
    const existingFirst = existing.find((s) => s.step_no === 1);
    const incomingFirst = dto.steps.find((s) => s.stepNo === 1);
    if (existingFirst && incomingFirst && existingFirst.approver_role !== incomingFirst.approverRole) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `step 1's approver role is fixed per document type (CONTRACTS.md §5) — cannot change '${existingFirst.approver_role}' to '${incomingFirst.approverRole}' for '${documentType}'`,
      });
    }

    await this.repo.replaceChainSteps(
      client,
      documentType,
      dto.steps.map((s) => ({ stepNo: s.stepNo, approverRole: s.approverRole, minAmount: s.minAmount ?? null, maxAmount: s.maxAmount ?? null })),
    );

    const rows = await this.repo.findChainSteps(client, documentType);
    return groupChainRows(rows)[0]!;
  }

  // ── D-23: per-document-type approval mode ────────────────────────────────

  /** Every `ApprovalDocumentType`, defaulted to `manual` (`DEFAULT_APPROVAL_MODES`) and overlaid with whatever an Owner has explicitly changed. */
  async getApprovalModes(client: PoolClient): Promise<ApprovalModeRes[]> {
    const overrides = await this.repo.getApprovalModesRaw(client);
    return Object.values(ApprovalDocumentType).map((documentType) => ({
      documentType,
      mode: overrides[documentType] ?? DEFAULT_APPROVAL_MODES[documentType],
    }));
  }

  async putApprovalMode(documentType: string, dto: PutApprovalModeDto, caller: { sub: UUID }, client: PoolClient): Promise<ApprovalModeRes> {
    if (!APPROVAL_DOCUMENT_TYPES.has(documentType)) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `Unknown document type '${documentType}'` });
    }

    const values = await this.repo.upsertApprovalMode(client, documentType, dto.mode, caller.sub);

    await this.syncEmit.emit(client, {
      entity: SyncEntity.SETTINGS,
      op: 'updated',
      entityId: uuidV5(`approval.mode.${documentType}`, SETTINGS_ENTITY_ID_NAMESPACE),
      locationId: null,
      actorUserId: caller.sub,
      data: { key: 'approval.mode', documentType, mode: dto.mode },
    });

    return { documentType: documentType as ApprovalDocumentType, mode: values[documentType] ?? dto.mode };
  }

  private assertStepsWellFormed(steps: ChainStepDto[]): void {
    const stepNos = steps.map((s) => s.stepNo).sort((a, b) => a - b);
    for (let i = 0; i < stepNos.length; i++) {
      if (stepNos[i] !== i + 1) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `steps must be numbered 1..N with no gaps or duplicates (got ${JSON.stringify(steps.map((s) => s.stepNo))})`,
        });
      }
    }
  }
}

function mapSetting(row: SettingRow): SettingRes {
  return {
    key: row.key,
    value: row.value,
    description: row.description,
    updatedBy: row.updated_by_name,
    updatedAt: row.updated_at,
  };
}

function groupChainRows(rows: ApprovalChainStepRow[]): ApprovalChainRes[] {
  const byType = new Map<string, ApprovalChainStepRow[]>();
  for (const row of rows) {
    const list = byType.get(row.document_type) ?? [];
    list.push(row);
    byType.set(row.document_type, list);
  }
  return [...byType.entries()].map(([documentType, stepRows]) => ({
    documentType,
    steps: stepRows
      .sort((a, b) => a.step_no - b.step_no)
      .map((r) => ({ stepNo: r.step_no, approverRole: r.approver_role, minAmount: r.min_amount, maxAmount: r.max_amount })),
  }));
}
