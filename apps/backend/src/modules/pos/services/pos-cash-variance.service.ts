import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ApprovalDocumentType, ERR_NOT_FOUND, ERR_VALIDATION, RoleKey, type CashVarianceProposal, type Paginated, type UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../../common/database/database-pool.provider';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { resolveUserNames } from '../notify-eligible-users.util';
import { mapCashVarianceProposal, type CashVarianceProposalRow } from './pos-mappers';

// No `JOIN users` for `kasirName`/`decidedBy` — see `notify-eligible-users.util.ts`'s header: under
// a non-central caller's own RLS, `JOIN users ku` would silently drop a proposal from the result
// whenever the caller isn't the kasir who closed that shift (a Supervisor deciding proposals
// opened by DIFFERENT cashiers at their outlet — the normal case — would see rows disappear).
const SELECT = `
  SELECT cvp.id, cvp.shift_id, cvp.location_id, cvp.kasir_user_id, cvp.amount, cvp.status,
         cvp.decided_by, cvp.decided_at, cvp.decision_reason
    FROM cash_variance_proposals cvp
`;

interface RawCashVarianceProposalRow extends Omit<CashVarianceProposalRow, 'kasir_name' | 'decided_by_name'> {
  kasir_user_id: UUID;
  decided_by: UUID | null;
}

/**
 * `PosCashVarianceService` — D-19 / Amendment 2 / CONTRACTS.md §5.9.
 * Proposals are auto-created by `PosShiftService.close()`; this service only
 * covers the human decision (`approve`/`reject`), always through
 * `ApprovalService`, and is deliberately NEVER offline-eligible — the
 * `CASH_VARIANCE_PROPOSAL` transition rows in
 * `packages/shared/src/approvals/state-machine.ts` all carry
 * `offlineEligible: false`, so an `offline` decision attempt would be
 * rejected by the kernel itself (`ERR_OFFLINE_NOT_ELIGIBLE`) even before
 * this module's own refusal to expose an offline path at all.
 *
 * `cash_variance_proposals` is class **X** (SYNC-PROTOCOL §3 group 6,
 * `@mimi/sync-protocol`'s `AUTHORITY` table) — never on the wire in either
 * direction. `SyncEmitService.emit()` would reject it outright (its own
 * guard: cloud-origin events are only valid for `pull`/`bidirectional`
 * entities), so this service never calls it — the kasir learns of a
 * decision only via the shift/report surfaces, never via a sync entity.
 */
@Injectable()
export class PosCashVarianceService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly approvals: ApprovalService,
  ) {}

  async list(
    client: PoolClient,
    query: { locationId?: UUID; status?: string; from?: string; to?: string; page: number; pageSize: number },
  ): Promise<Paginated<CashVarianceProposal>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (query.locationId) {
      params.push(query.locationId);
      where += ` AND cvp.location_id = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      where += ` AND cvp.status = $${params.length}`;
    }
    if (query.from) {
      params.push(query.from);
      where += ` AND cvp.created_at >= $${params.length}::date`;
    }
    if (query.to) {
      params.push(query.to);
      where += ` AND cvp.created_at <= $${params.length}::date + INTERVAL '1 day'`;
    }

    const countRes = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM cash_variance_proposals cvp WHERE ${where}`, params);
    const total = Number.parseInt(countRes.rows[0]?.count ?? '0', 10);

    const offset = (query.page - 1) * query.pageSize;
    params.push(query.pageSize, offset);
    const res = await client.query<RawCashVarianceProposalRow>(
      `${SELECT} WHERE ${where} ORDER BY cvp.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: await this.hydrateRows(res.rows), total, page: query.page, pageSize: query.pageSize };
  }

  async approve(client: PoolClient, id: UUID, actorUserId: UUID, actorRole: RoleKey, reason: string): Promise<CashVarianceProposal> {
    const row = await this.mustLoadForUpdate(client, id);
    if (row.status !== 'pending') {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `Cash variance proposal ${id} is already ${row.status}` });
    }

    // `transition()`'s CASH_VARIANCE_PROPOSAL 'approve' rule requires a reason on APPROVE too
    // (§5.9 row 2) — the kernel enforces `ERR_REASON_REQUIRED` if it's missing; this endpoint's
    // DTO already requires a non-empty string, so this is a defence-in-depth backstop, not the
    // only gate.
    await this.approvals.approve(client, {
      documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
      documentId: id,
      currentState: row.status,
      actorUserId,
      actorRole,
      reason,
    });

    await client.query(
      `UPDATE cash_variance_proposals SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_reason = $3 WHERE id = $1`,
      [id, actorUserId, reason],
    );

    return this.mustGetById(client, id);
  }

  async reject(client: PoolClient, id: UUID, actorUserId: UUID, actorRole: RoleKey, reason: string): Promise<CashVarianceProposal> {
    const row = await this.mustLoadForUpdate(client, id);
    if (row.status !== 'pending') {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `Cash variance proposal ${id} is already ${row.status}` });
    }

    await this.approvals.reject(client, {
      documentType: ApprovalDocumentType.CASH_VARIANCE_PROPOSAL,
      documentId: id,
      currentState: row.status,
      actorUserId,
      actorRole,
      reason,
    });

    await client.query(
      `UPDATE cash_variance_proposals SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_reason = $3 WHERE id = $1`,
      [id, actorUserId, reason],
    );

    return this.mustGetById(client, id);
  }

  private async mustLoadForUpdate(client: PoolClient, id: UUID): Promise<{ id: UUID; status: string }> {
    const res = await client.query<{ id: UUID; status: string }>(`SELECT id, status FROM cash_variance_proposals WHERE id = $1 FOR UPDATE`, [id]);
    if (!res.rows[0]) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Cash variance proposal not found' });
    return res.rows[0];
  }

  private async mustGetById(client: PoolClient, id: UUID): Promise<CashVarianceProposal> {
    const res = await client.query<RawCashVarianceProposalRow>(`${SELECT} WHERE cvp.id = $1`, [id]);
    if (!res.rows[0]) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Cash variance proposal not found' });
    return (await this.hydrateRows([res.rows[0]]))[0]!;
  }

  private async hydrateRows(rows: readonly RawCashVarianceProposalRow[]): Promise<CashVarianceProposal[]> {
    const names = await resolveUserNames(this.pool, [...rows.map((r) => r.kasir_user_id), ...rows.map((r) => r.decided_by)]);
    return rows.map((r) =>
      mapCashVarianceProposal({
        ...r,
        kasir_name: names.get(r.kasir_user_id) ?? r.kasir_user_id,
        decided_by_name: r.decided_by ? (names.get(r.decided_by) ?? r.decided_by) : null,
      }),
    );
  }
}
