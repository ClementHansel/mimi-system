/**
 * Raw `pg` access for M20 `settings` (CONTRACTS.md §4.20). `settings` and
 * `approval_chain_steps` both carry NO RLS (§1.14 "NONE" group — master/kernel
 * config, API-guarded only via `PermissionsGuard`); table-level grants to
 * `app_user` (migration 009) already cover read/write once `SET LOCAL ROLE
 * app_user` has run (`RlsContextGuard`, every authenticated request).
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ApprovalMode, UUID } from '@mimi/shared';

/** The single `settings` row D-23's per-document-type modes live under — see `settings.service.ts`'s `getApprovalModes`/`putApprovalMode`. */
export const APPROVAL_MODE_SETTINGS_KEY = 'approval.mode';

export interface SettingRow {
  key: string;
  value: unknown;
  description: string | null;
  updated_by_name: string | null;
  updated_at: string;
}

export interface ApprovalChainStepRow {
  document_type: string;
  step_no: number;
  approver_role: string;
  min_amount: string | null;
  max_amount: string | null;
}

@Injectable()
export class SettingsRepository {
  async list(client: PoolClient, prefix?: string): Promise<SettingRow[]> {
    const params: unknown[] = [];
    let where = '';
    if (prefix) {
      params.push(`${prefix}%`);
      where = `WHERE s.key LIKE $1`;
    }
    const res = await client.query<SettingRow>(
      `SELECT s.key, s.value, s.description, u.name AS updated_by_name, s.updated_at
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
         ${where}
        ORDER BY s.key`,
      params,
    );
    return res.rows;
  }

  async findByKey(client: PoolClient, key: string): Promise<SettingRow | undefined> {
    const res = await client.query<SettingRow>(
      `SELECT s.key, s.value, s.description, u.name AS updated_by_name, s.updated_at
         FROM settings s LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = $1`,
      [key],
    );
    return res.rows[0];
  }

  /** Returns `undefined` if the key doesn't exist as a row yet (shouldn't happen — every `SettingsKey` is seeded, migration 007). */
  async updateValue(
    client: PoolClient,
    key: string,
    value: unknown,
    updatedBy: UUID,
  ): Promise<SettingRow | undefined> {
    const res = await client.query<{ key: string }>(
      `UPDATE settings SET value = $2::jsonb, updated_by = $3, updated_at = NOW() WHERE key = $1 RETURNING key`,
      [key, JSON.stringify(value), updatedBy],
    );
    if (!res.rows[0]) return undefined;
    return this.findByKey(client, key);
  }

  async listApprovalChains(client: PoolClient): Promise<ApprovalChainStepRow[]> {
    const res = await client.query<ApprovalChainStepRow>(
      `SELECT document_type, step_no, approver_role, min_amount, max_amount
         FROM approval_chain_steps
        ORDER BY document_type, step_no`,
    );
    return res.rows;
  }

  async findChainSteps(client: PoolClient, documentType: string): Promise<ApprovalChainStepRow[]> {
    const res = await client.query<ApprovalChainStepRow>(
      `SELECT document_type, step_no, approver_role, min_amount, max_amount
         FROM approval_chain_steps
        WHERE document_type = $1
        ORDER BY step_no`,
      [documentType],
    );
    return res.rows;
  }

  /** Full replace of one document type's chain — delete + re-insert inside the caller's transaction. */
  async replaceChainSteps(
    client: PoolClient,
    documentType: string,
    steps: {
      stepNo: number;
      approverRole: string;
      minAmount: string | null;
      maxAmount: string | null;
    }[],
  ): Promise<void> {
    await client.query(`DELETE FROM approval_chain_steps WHERE document_type = $1`, [documentType]);
    for (const step of steps) {
      await client.query(
        `INSERT INTO approval_chain_steps (document_type, step_no, approver_role, min_amount, max_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [documentType, step.stepNo, step.approverRole, step.minAmount, step.maxAmount],
      );
    }
  }

  /**
   * D-23 raw read of the `approval.mode` settings row — `{ [documentType]: mode }`,
   * only the document types an Owner has ever explicitly changed (unset types are
   * NOT written here; `SettingsService.getApprovalModes` fills every other
   * `ApprovalDocumentType` from `DEFAULT_APPROVAL_MODES`). No seed migration
   * exists for this key (deliberately — see `putApprovalMode`'s upsert below), so
   * a fresh install legitimately has no `settings` row at all for it yet.
   */
  async getApprovalModesRaw(client: PoolClient): Promise<Record<string, ApprovalMode>> {
    const res = await client.query<{ value: Record<string, ApprovalMode> }>(
      `SELECT value FROM settings WHERE key = $1`,
      [APPROVAL_MODE_SETTINGS_KEY],
    );
    return res.rows[0]?.value ?? {};
  }

  /**
   * Single-key `jsonb_set` inside an `INSERT ... ON CONFLICT DO UPDATE` — atomic
   * (no separate read-modify-write race across concurrent Owners) and self-seeding
   * (works whether or not the `approval.mode` row exists yet, so this needs no
   * migration from W1-C: reusing the already-generic, already-seeded `settings`
   * table's existing JSONB-value shape rather than a new table/column).
   */
  async upsertApprovalMode(
    client: PoolClient,
    documentType: string,
    mode: ApprovalMode,
    updatedBy: UUID,
  ): Promise<Record<string, ApprovalMode>> {
    const res = await client.query<{ value: Record<string, ApprovalMode> }>(
      `INSERT INTO settings (key, value, description, updated_by, updated_at)
       VALUES ($1, jsonb_build_object($2::text, $3::text), 'Per-document-type approval mode (D-23)', $4, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = jsonb_set(COALESCE(settings.value, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true),
             updated_by = $4,
             updated_at = NOW()
       RETURNING value`,
      [APPROVAL_MODE_SETTINGS_KEY, documentType, mode, updatedBy],
    );
    return res.rows[0]!.value;
  }
}
