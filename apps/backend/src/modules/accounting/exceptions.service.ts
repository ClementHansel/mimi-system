import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  type OfflineAuthCase,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import { EventBus } from '../../kernel/events/event-bus.service';
import type { ExceptionVerdictDto, ListExceptionsQueryDto } from './dto/accounting.dto';
import { withWrite } from './db-tx';

interface OfflineAuthConflictRow {
  id: UUID;
  kind: string;
  entity: string;
  entity_id: UUID | null;
  location_id: UUID | null;
  location_name: string | null;
  detail: Record<string, unknown>;
  physical_effect_suspected: boolean;
  status: 'open' | 'resolved' | 'dismissed';
  oa_id: UUID | null;
  document_type: string | null;
  document_id: UUID | null;
  amount: string | null;
  approver_name: string | null;
  device_name: string | null;
  occurred_at: string | null;
  relay_received_at: string | null;
  selfie_url: string | null;
  pin_attempts: number | null;
  outcome: string | null;
  verdict: 'upheld' | 'rejected' | null;
}

const CASE_SELECT = `
  SELECT sc.id, sc.kind, sc.entity, sc.entity_id, sc.location_id, l.name AS location_name, sc.detail,
         sc.physical_effect_suspected, sc.status,
         oa.id AS oa_id, oa.document_type, oa.document_id, oa.amount::text AS amount,
         u.name AS approver_name, d.name AS device_name,
         oa.granted_at AS occurred_at, oa.relay_received_at,
         att.object_key AS selfie_url, oa.pin_attempts_before_success AS pin_attempts,
         oa.outcome, oa.verdict
    FROM sync_conflicts sc
    LEFT JOIN locations l ON l.id = sc.location_id
    LEFT JOIN offline_authorizations oa ON oa.id = sc.entity_id AND sc.entity = 'offline_authorizations'
    LEFT JOIN users u ON u.id = oa.user_id
    LEFT JOIN devices d ON d.id = oa.device_id
    LEFT JOIN attachments att ON att.id = oa.selfie_attachment_id
   WHERE sc.kind = 'offline_auth'
`;

/**
 * D-17 finance exception queue (`GET/POST /api/accounting/exceptions*`,
 * CONTRACTS.md §4.17, SYNC-PROTOCOL §7.5). Reads `sync_conflicts` (kind=
 * 'offline_auth') joined to the `offline_authorizations` row it references —
 * both tables are `kernel/sync`'s (block 120-129), read-only from here under
 * the caller's own RLS (central roles only, per `sync.exception.review`'s
 * §3 gate — owner/finance). The one WRITE this service performs
 * (`recordVerdict`) is the seam back into M17: `rejected` + physical effect
 * fires `OFFLINE_AUTH_REJECTED` (X7, §6.3) via the SAME `EventBus.publish
 * ('journal.action', ...)` path every other domain module uses — this
 * service is a producer, `PostingEngineService` still the only consumer.
 */
@Injectable()
export class ExceptionsService {
  constructor(private readonly eventBus: EventBus) {}

  async list(
    client: PoolClient,
    query: ListExceptionsQueryDto,
  ): Promise<Paginated<OfflineAuthCase>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.status) {
      conds.push(`sc.status = $${i++}`);
      args.push(query.status);
    }
    if (query.class) {
      conds.push(`oa.outcome = $${i++}`);
      args.push(query.class === 'offline_auth_failed' ? 'failed' : 'unprovable');
    }
    const where = conds.length ? `AND ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      client.query<OfflineAuthConflictRow>(
        `${CASE_SELECT} ${where} ORDER BY sc.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_conflicts sc LEFT JOIN offline_authorizations oa ON oa.id = sc.entity_id AND sc.entity = 'offline_authorizations' WHERE sc.kind = 'offline_auth' ${where}`,
        args,
      ),
    ]);
    return {
      rows: rows.rows.map(toOfflineAuthCase),
      total: Number(count.rows[0]?.count ?? '0'),
      page,
      pageSize,
    };
  }

  async recordVerdict(
    client: PoolClient,
    actorId: UUID,
    id: UUID,
    dto: ExceptionVerdictDto,
  ): Promise<OfflineAuthCase> {
    const res = await client.query<OfflineAuthConflictRow>(`${CASE_SELECT} AND sc.id = $1`, [id]);
    const row = res.rows[0];
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Exception case ${id} not found`,
      });
    if (row.status !== 'open') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Exception case ${id} is '${row.status}', not 'open'`,
      });
    }
    if (!row.oa_id || !row.document_type || !row.document_id) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Exception case ${id} has no linked offline_authorizations row — cannot record a verdict`,
      });
    }

    // Capture the narrowed values as consts BEFORE entering the callback below.
    // `document_type`/`document_id` are `string | null` on the row type, and the
    // guard above narrows them — but TypeScript discards narrowing of a mutable
    // property once it crosses into a closure, since it cannot prove the object
    // was not reassigned in between. Wrapping this method in `withWrite` (the
    // silent-rollback fix) moved the publish call into exactly such a closure,
    // which is what broke the build. Consts keep the narrowing.
    const documentType = row.document_type;
    const documentId = row.document_id;

    return withWrite(client, async () => {
      await client.query(
        `UPDATE offline_authorizations SET verdict = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.oa_id, dto.verdict, actorId],
      );
      await client.query(
        `UPDATE sync_conflicts SET status = 'resolved', resolved_by = $2, resolved_at = NOW(), resolution = $3, updated_at = NOW() WHERE id = $1`,
        [id, actorId, dto.reason],
      );

      if (dto.verdict === 'rejected' && row.physical_effect_suspected && row.amount) {
        // X7 — the ledger is append-only, the cash/goods are gone: post a claim receivable, never a
        // deletion. `source` distinguishes the two account pairs §6.3/posting_rules seed for
        // 'offline_auth_rejected' (refund/void -> Dr 1220/Cr 4000 re-recognized revenue; waste -> Dr
        // 1220/Cr 5100 expense reversal).
        await this.eventBus.publish('journal.action', {
          eventType: 'offline_auth_rejected',
          documentType,
          documentId,
          locationId: row.location_id,
          amount: row.amount,
          context: {
            source: row.document_type === 'waste' ? 'waste' : 'refund_or_void',
            routeToPayrollDeduction: !!dto.routeToPayrollDeduction,
          },
          occurredAt: new Date().toISOString(),
        });
      }

      const updated = await client.query<OfflineAuthConflictRow>(`${CASE_SELECT} AND sc.id = $1`, [
        id,
      ]);
      return toOfflineAuthCase(updated.rows[0]!);
    });
  }
}

function toOfflineAuthCase(row: OfflineAuthConflictRow): OfflineAuthCase {
  return {
    id: row.id,
    class: row.outcome === 'unprovable' ? 'offline_auth_unprovable' : 'offline_auth_failed',
    documentType: row.document_type ?? row.entity,
    documentId: row.document_id ?? row.entity_id ?? row.id,
    amount: row.amount,
    approverName: row.approver_name ?? '',
    deviceName: row.device_name ?? '',
    outletName: row.location_name ?? '',
    occurredAt: row.occurred_at ?? '',
    relayReceivedAt: row.relay_received_at ?? '',
    evidence: { selfieUrl: row.selfie_url, pinAttempts: row.pin_attempts },
    physicalEffectSuspected: row.physical_effect_suspected,
    outcome: row.outcome ?? 'pending_verification',
    verdict: row.verdict,
  };
}
