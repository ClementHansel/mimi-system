import { Injectable } from '@nestjs/common';
import {
  ApprovalDocumentType,
  ApprovalMode,
  DEFAULT_APPROVAL_MODES,
  type ApprovalState,
  type ApprovalStepState,
  type Money,
  type ReverificationStatus,
} from '@mimi/shared';
import type { DbClient } from './types';

/** Same `settings` row `modules/settings`' `SettingsRepository` writes (D-23) — kept in sync by string literal, not a shared import, matching `loadChainSteps`' identical relationship to `modules/settings`' `approval_chain_steps` admin endpoints (this repository reads the table `modules/settings` administers; neither module imports the other). */
const APPROVAL_MODE_SETTINGS_KEY = 'approval.mode';

export interface ChainStepConfigRow {
  stepNo: number;
  approverRole: string;
  minAmount: Money | null;
  maxAmount: Money | null;
}

export interface ApprovalRow {
  id: string;
  documentType: string;
  documentId: string;
  state: ApprovalState;
  /** `null` once `state` is terminal (approved/rejected/cancelled) — migration 216 made the column nullable for exactly this. Guaranteed non-null while `state === 'pending'`. */
  currentStep: number | null;
  amount: Money | null;
  locationId: string | null;
  requestedBy: string;
  requestedAt: string;
  decidedAt: string | null;
}

export interface ApprovalStepRow {
  id: string;
  approvalId: string;
  /** Display name of whoever acted, or null when this caller may not read that user. */
  actedByName?: string | null;
  stepNo: number;
  approverRole: string;
  state: ApprovalStepState;
  actedBy: string | null;
  actedAt: string | null;
  reason: string | null;
  offlineAuthorized: boolean;
  offlineCredentialId: string | null;
  reverifiedAt: string | null;
  reverificationStatus: ReverificationStatus | null;
}

/** Per-document-type "human number" column — a fixed, code-reviewed whitelist (never user input) safe to splice into SQL identifiers. */
const DOCUMENT_NUMBER_SOURCE: Partial<
  Record<ApprovalDocumentType, { table: string; column: string }>
> = {
  [ApprovalDocumentType.REPLENISHMENT_REQUEST]: {
    table: 'replenishment_requests',
    column: 'request_number',
  },
  [ApprovalDocumentType.PURCHASE_REQUEST]: { table: 'purchase_requests', column: 'pr_number' },
  [ApprovalDocumentType.PURCHASE_ORDER]: { table: 'purchase_orders', column: 'po_number' },
  [ApprovalDocumentType.STOCK_OPNAME]: { table: 'stock_opname', column: 'opname_number' },
  [ApprovalDocumentType.RETURN]: { table: 'returns', column: 'return_number' },
  [ApprovalDocumentType.WASTE]: { table: 'waste_records', column: 'waste_number' },
  [ApprovalDocumentType.PAYROLL_RUN]: { table: 'payroll_runs', column: 'run_number' },
  [ApprovalDocumentType.PAYMENT_VERIFICATION]: {
    table: 'payment_verifications',
    column: 'pv_number',
  },
  [ApprovalDocumentType.EMPLOYEE_LOAN]: { table: 'employee_loans', column: 'loan_number' },
  // VOID_REFUND, LEAVE_REQUEST, CASH_VARIANCE_PROPOSAL carry no human-facing document number.
};

/** Hard cap on the pre-role-filter candidate fetch (see `findPendingCandidates`'s doc comment). */
export const PENDING_CANDIDATE_CAP = 2000;

function mapChainStep(row: {
  step_no: number;
  approver_role: string;
  min_amount: string | null;
  max_amount: string | null;
}): ChainStepConfigRow {
  return {
    stepNo: row.step_no,
    approverRole: row.approver_role,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
  };
}

function mapApproval(row: {
  id: string;
  document_type: string;
  document_id: string;
  state: string;
  current_step: number | null;
  amount: string | null;
  location_id: string | null;
  requested_by: string;
  requested_at: Date;
  decided_at: Date | null;
}): ApprovalRow {
  return {
    id: row.id,
    documentType: row.document_type,
    documentId: row.document_id,
    state: row.state as ApprovalState,
    currentStep: row.current_step,
    amount: row.amount,
    locationId: row.location_id,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

function mapStep(row: {
  id: string;
  approval_id: string;
  step_no: number;
  approver_role: string;
  state: string;
  acted_by: string | null;
  acted_by_name?: string | null;
  acted_at: Date | null;
  reason: string | null;
  offline_authorized: boolean;
  offline_credential_id: string | null;
  reverified_at: Date | null;
  reverification_status: string | null;
}): ApprovalStepRow {
  return {
    id: row.id,
    approvalId: row.approval_id,
    stepNo: row.step_no,
    approverRole: row.approver_role,
    state: row.state as ApprovalStepState,
    actedBy: row.acted_by,
    actedByName: row.acted_by_name ?? null,
    actedAt: row.acted_at ? row.acted_at.toISOString() : null,
    reason: row.reason,
    offlineAuthorized: row.offline_authorized,
    offlineCredentialId: row.offline_credential_id,
    reverifiedAt: row.reverified_at ? row.reverified_at.toISOString() : null,
    reverificationStatus: row.reverification_status as ReverificationStatus | null,
  };
}

/**
 * Raw `pg` data access for `approvals` / `approval_steps` / `approval_chain_steps`
 * (CONTRACTS.md §1.1 block 001-009). Every method takes the caller-supplied
 * `PoolClient` — never acquires its own connection — so it always runs
 * inside whatever transaction/RLS context the caller already opened
 * (`RlsContextGuard`'s pattern, `ScopeService`'s class comment explains why).
 * Parameterized queries only; no string-built predicates except the
 * document-number lookup's TABLE/COLUMN identifiers, which come from the
 * fixed `DOCUMENT_NUMBER_SOURCE` whitelist above, never from caller input.
 */
@Injectable()
export class ApprovalsRepository {
  /**
   * D-23 — live read of this document type's configured mode, defaulted to
   * `DEFAULT_APPROVAL_MODES` (all `manual`) when an Owner has never
   * explicitly changed it. Reads `settings` directly (no seed migration
   * needed — see `modules/settings`' `SettingsRepository.upsertApprovalMode`'s
   * self-seeding `INSERT ... ON CONFLICT`), the same "read the table the
   * admin module writes, never import its service" relationship this
   * repository already has with `approval_chain_steps`/`modules/settings`.
   */
  async getApprovalMode(
    client: DbClient,
    documentType: ApprovalDocumentType,
  ): Promise<ApprovalMode> {
    const res = await client.query<{ value: Record<string, ApprovalMode> }>(
      `SELECT value FROM settings WHERE key = $1`,
      [APPROVAL_MODE_SETTINGS_KEY],
    );
    const overrides = res.rows[0]?.value ?? {};
    return overrides[documentType] ?? DEFAULT_APPROVAL_MODES[documentType];
  }

  /**
   * D-23 "off" mode: a single already-decided step, inserted directly (never
   * `pending`) — the document type has no human gate, but `acted_by` (a real
   * user id, never null) is exactly the "actor recorded" contract the ticket
   * requires. `approverRole` is cosmetic metadata on this synthetic step
   * (`'system'` when the caller didn't supply `requestedByRole` — see
   * `SubmitApprovalInput`'s doc comment); it never gates anything since no
   * `decide()` call is ever made against an already-terminal approval.
   */
  async insertAutoApprovedStep(
    client: DbClient,
    input: {
      approvalId: string;
      stepNo: number;
      approverRole: string;
      actedBy: string;
      reason: string;
    },
  ): Promise<ApprovalStepRow> {
    const res = await client.query(
      `INSERT INTO approval_steps (approval_id, step_no, approver_role, state, acted_by, acted_at, reason, offline_authorized)
       VALUES ($1, $2, $3, 'approved', $4, NOW(), $5, false)
       RETURNING *`,
      [input.approvalId, input.stepNo, input.approverRole, input.actedBy, input.reason],
    );
    return mapStep(res.rows[0]);
  }

  async loadChainSteps(
    client: DbClient,
    documentType: ApprovalDocumentType,
  ): Promise<ChainStepConfigRow[]> {
    const res = await client.query(
      `SELECT step_no, approver_role, min_amount, max_amount
         FROM approval_chain_steps
        WHERE document_type = $1
        ORDER BY step_no`,
      [documentType],
    );
    return res.rows.map(mapChainStep);
  }

  async findApproval(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: string,
  ): Promise<ApprovalRow | null> {
    const res = await client.query(
      `SELECT * FROM approvals WHERE document_type = $1 AND document_id = $2 FOR UPDATE`,
      [documentType, documentId],
    );
    return res.rows[0] ? mapApproval(res.rows[0]) : null;
  }

  async insertApproval(
    client: DbClient,
    input: {
      documentType: ApprovalDocumentType;
      documentId: string;
      amount: Money | null;
      locationId: string | null;
      requestedBy: string;
      currentStep: number;
    },
  ): Promise<ApprovalRow> {
    const res = await client.query(
      `INSERT INTO approvals (document_type, document_id, amount, location_id, requested_by, current_step)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.documentType,
        input.documentId,
        input.amount,
        input.locationId,
        input.requestedBy,
        input.currentStep,
      ],
    );
    return mapApproval(res.rows[0]);
  }

  async insertStep(
    client: DbClient,
    input: {
      approvalId: string;
      stepNo: number;
      approverRole: string;
      state: 'pending' | 'skipped';
    },
  ): Promise<ApprovalStepRow> {
    const res = await client.query(
      `INSERT INTO approval_steps (approval_id, step_no, approver_role, state)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.approvalId, input.stepNo, input.approverRole, input.state],
    );
    return mapStep(res.rows[0]);
  }

  async findStep(
    client: DbClient,
    approvalId: string,
    stepNo: number,
  ): Promise<ApprovalStepRow | null> {
    const res = await client.query(
      `SELECT * FROM approval_steps WHERE approval_id = $1 AND step_no = $2`,
      [approvalId, stepNo],
    );
    return res.rows[0] ? mapStep(res.rows[0]) : null;
  }

  async findStepById(client: DbClient, stepId: string): Promise<ApprovalStepRow | null> {
    const res = await client.query(`SELECT * FROM approval_steps WHERE id = $1`, [stepId]);
    return res.rows[0] ? mapStep(res.rows[0]) : null;
  }

  /**
   * The chain's steps, each carrying WHO acted as a NAME.
   *
   * `acted_by` is a user id, and the approval timeline rendered it straight
   * into "1 Sep 2026, 14.28 WITA oleh 640218f4-cdbd-4d65-80ae-8b1c31ececc0"
   * (found 2026-09-02). Nobody can read that, and it discloses a key — the
   * same fall-back-to-the-id shape already fixed on Gudang's approval queue
   * and on Finance's payee column.
   *
   * The join is LEFT and the name is nullable on purpose: `users_select`
   * (migration 263) hides user rows from most roles, so a caller who cannot
   * read the actor gets `null` and the UI shows an em dash. An unresolvable
   * name is not a licence to print the id.
   */
  async listSteps(client: DbClient, approvalId: string): Promise<ApprovalStepRow[]> {
    const res = await client.query(
      `SELECT s.*, u.name AS acted_by_name
         FROM approval_steps s
         LEFT JOIN users u ON u.id = s.acted_by
        WHERE s.approval_id = $1
        ORDER BY s.step_no`,
      [approvalId],
    );
    return res.rows.map(mapStep);
  }

  /** Guarded: only succeeds while the step is still `pending` — prevents a double-decide race (FR-AUDIT / ERR_APPROVAL_ALREADY_DECIDED). */
  async decideStep(
    client: DbClient,
    input: {
      approvalId: string;
      stepNo: number;
      state: 'approved' | 'rejected';
      actedBy: string;
      reason: string | null;
      offlineAuthorized: boolean;
      offlineCredentialId: string | null;
    },
  ): Promise<ApprovalStepRow | null> {
    const res = await client.query(
      `UPDATE approval_steps
          SET state = $1, acted_by = $2, acted_at = NOW(), reason = $3,
              offline_authorized = $4, offline_credential_id = $5
        WHERE approval_id = $6 AND step_no = $7 AND state = 'pending'
        RETURNING *`,
      [
        input.state,
        input.actedBy,
        input.reason,
        input.offlineAuthorized,
        input.offlineCredentialId,
        input.approvalId,
        input.stepNo,
      ],
    );
    return res.rows[0] ? mapStep(res.rows[0]) : null;
  }

  async markStepSkipped(
    client: DbClient,
    approvalId: string,
    stepNo: number,
    approverRole: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO approval_steps (approval_id, step_no, approver_role, state)
       VALUES ($1, $2, $3, 'skipped')
       ON CONFLICT (approval_id, step_no) DO NOTHING`,
      [approvalId, stepNo, approverRole],
    );
  }

  async advanceApproval(
    client: DbClient,
    approvalId: string,
    nextStep: number,
  ): Promise<ApprovalRow> {
    const res = await client.query(
      `UPDATE approvals SET current_step = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [nextStep, approvalId],
    );
    return mapApproval(res.rows[0]);
  }

  /**
   * `current_step` is set to NULL here — not left at the last-acted step
   * number — because `currentStep === null` IS the documented signal
   * (`DecisionResult`/`SubmitResult`) that a chain is finished; every
   * consuming module keys its own finalization on that contract. Before this
   * fix the column was never cleared, so only `ApprovalService`'s in-memory
   * return value (which hardcodes `currentStep: null` on finalize) was
   * correct — the persisted row silently disagreed with its own contract,
   * a trap for any future reader or reporting query that reads the column
   * directly instead of going through the service.
   */
  async finalizeApproval(
    client: DbClient,
    approvalId: string,
    state: 'approved' | 'rejected' | 'cancelled',
  ): Promise<ApprovalRow> {
    const res = await client.query(
      `UPDATE approvals SET state = $1, current_step = NULL, decided_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [state, approvalId],
    );
    return mapApproval(res.rows[0]);
  }

  async updateStepReverification(
    client: DbClient,
    stepId: string,
    outcome: ReverificationStatus,
  ): Promise<ApprovalStepRow | null> {
    const res = await client.query(
      `UPDATE approval_steps SET reverification_status = $1, reverified_at = NOW() WHERE id = $2 RETURNING *`,
      [outcome, stepId],
    );
    return res.rows[0] ? mapStep(res.rows[0]) : null;
  }

  /**
   * Every candidate pending step within (documentType, location) scope, NOT
   * yet role-filtered or paginated. Role eligibility for the 4 irregular
   * chains (BUILD-PLAN carried-forward item 2) cannot be expressed as a
   * `s.approver_role = $callerRole` predicate — it depends on runtime
   * context (location type / return direction / the leave "any-of" set) —
   * so the service applies `resolveEligibleRoles` + pagination AFTER this
   * fetch. Bounded by `PENDING_CANDIDATE_CAP` rather than SQL LIMIT/OFFSET
   * so a role-filtered page is never silently under-filled; see the kernel
   * report for the scale assumption this rests on (dozens-to-low-hundreds
   * pending approvals system-wide, not millions — revisit at NFR-01 load
   * test, W6-05, if that assumption breaks).
   */
  async findPendingCandidates(
    client: DbClient,
    filter: { documentType?: ApprovalDocumentType; locationIds: readonly string[] | null },
  ): Promise<
    Array<{
      approvalId: string;
      documentType: string;
      documentId: string;
      amount: Money | null;
      locationId: string | null;
      locationName: string | null;
      requestedBy: string;
      requestedByName: string;
      requestedAt: string;
      stepNo: number;
      approverRole: string;
    }>
  > {
    const params: unknown[] = [];
    const conditions: string[] = [
      `s.state = 'pending'`,
      `a.state = 'pending'`,
      `s.step_no = a.current_step`,
    ];

    if (filter.documentType) {
      params.push(filter.documentType);
      conditions.push(`a.document_type = $${params.length}`);
    }
    if (filter.locationIds !== null) {
      params.push(filter.locationIds);
      conditions.push(`(a.location_id IS NULL OR a.location_id = ANY($${params.length}::uuid[]))`);
    }

    const where = conditions.join(' AND ');
    params.push(PENDING_CANDIDATE_CAP);

    // NO join against `users` here — deliberately. `users_select` (migration 009) is
    // `app_is_central() OR app_is_self(id)`; Supervisor Cabang and Kepala Gudang are neither, so a
    // `JOIN users u ON u.id = a.requested_by` run as either role silently DROPS every row whose
    // requester isn't the approver themselves — an INNER JOIN eliminating the row, not a null name.
    // That is exactly how "my pending approvals" went silently empty for every scoped approver (found
    // live by two Wave 3 agents + the coordinator). `locations` has no such restriction
    // (`locations_select = true`, world-readable) so that LEFT JOIN is unaffected and stays.
    // Requester display names are resolved separately below via `app_user_display()`, a narrow
    // SECURITY DEFINER lookup (migration 212_w1c_user_display_lookup.sql) exposing only
    // `(id, name, role_key)` — never widening `users_select` itself.
    const rowsRes = await client.query(
      `SELECT a.id AS approval_id, a.document_type, a.document_id, a.amount, a.location_id,
              l.name AS location_name, a.requested_by,
              a.requested_at, s.step_no, s.approver_role
         FROM approval_steps s
         JOIN approvals a ON a.id = s.approval_id
         LEFT JOIN locations l ON l.id = a.location_id
        WHERE ${where}
        ORDER BY a.requested_at ASC
        LIMIT $${params.length}`,
      params,
    );

    const requesterIds = [...new Set(rowsRes.rows.map((r) => r.requested_by as string))];
    const names = await this.loadUserDisplayNames(client, requesterIds);

    return rowsRes.rows.map((r) => ({
      approvalId: r.approval_id,
      documentType: r.document_type,
      documentId: r.document_id,
      amount: r.amount,
      locationId: r.location_id,
      locationName: r.location_name,
      requestedBy: r.requested_by,
      requestedByName: names.get(r.requested_by) ?? r.requested_by,
      requestedAt: (r.requested_at as Date).toISOString(),
      stepNo: r.step_no,
      approverRole: r.approver_role,
    }));
  }

  /**
   * Batched requester-display-name lookup via `app_user_display()` (migration
   * 212_w1c_user_display_lookup.sql) — a `SECURITY DEFINER` function returning only
   * `(id, name, role_key)`, never the full `users` row, and never touching `users_select` itself.
   * Works for ANY caller role (including Supervisor/Kepala Gudang, who `users_select` alone would
   * block from seeing another user's row at all) because it runs with the function owner's
   * privileges, not the calling session's `app.role`.
   */
  private async loadUserDisplayNames(
    client: DbClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (userIds.length === 0) return result;
    const res = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM app_user_display($1::uuid[])`,
      [userIds],
    );
    for (const row of res.rows) result.set(row.id, row.name);
    return result;
  }

  /**
   * B-07 — single-location-name lookup for a notification's `locationName`
   * param. Safe to run on the caller's own (possibly narrow) `DbClient`,
   * unlike the recipient-resolution read in `notification-recipients.ts`:
   * `locations_select` (migration 009) is `true` — world-readable, no RLS
   * restriction at all, matching the identical unrestricted `LEFT JOIN
   * locations` already relied on by `findPendingCandidates` above.
   */
  async findLocationName(client: DbClient, locationId: string): Promise<string | null> {
    const res = await client.query<{ name: string }>(`SELECT name FROM locations WHERE id = $1`, [
      locationId,
    ]);
    return res.rows[0]?.name ?? null;
  }

  /** Batched "human document number" lookup — one query per distinct document type present on the page, from the fixed whitelist only. */
  async loadDocumentNumbers(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentIds: readonly string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const source = DOCUMENT_NUMBER_SOURCE[documentType];
    if (!source || documentIds.length === 0) return result;

    const res = await client.query(
      `SELECT id, ${source.column} AS number FROM ${source.table} WHERE id = ANY($1::uuid[])`,
      [documentIds],
    );
    for (const row of res.rows as Array<{ id: string; number: string }>)
      result.set(row.id, row.number);
    return result;
  }
}
