import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApprovalDocumentType,
  DocumentPrefix,
  ERR_APPROVAL_ALREADY_DECIDED,
  ERR_APPROVAL_REQUIRED,
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_PROOF_REQUIRED,
  formatCloudDocNumber,
  SyncEntity,
  type Paginated,
  type PaymentVerification,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { assertSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';
import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import type { CreatePaymentDto, ListPaymentsQueryDto, PayPaymentDto } from './dto/accounting.dto';
import { extractPvKind, PV_KIND_MARKER, type PaymentVerificationRow } from './accounting.types';
import { withWrite } from './db-tx';

const PV_SELECT = `
  SELECT pv.id, pv.pv_number, pv.ref_type, pv.ref_id, pv.reference_number AS ref_number, pv.payee_type, pv.payee_id,
         -- NEVER pv.payee_id::text as a third fallback. It put raw UUIDs in
         -- Finance's "Penerima" column for every payment whose payee row could
         -- not be resolved: a supplier since deleted, an employee outside the
         -- caller's RLS scope, or a reference that no longer points anywhere.
         -- PaymentsPanel already renders payeeName ?? em-dash; an identifier is
         -- not a name, and showing one discloses a key while telling the reader
         -- nothing. Same fix as Replenishment.requestedBy (2026-09-01).
         --
         -- NO BACKTICKS IN HERE: this comment lives inside a TEMPLATE LITERAL,
         -- and the first version quoted identifiers in backticks, which closed
         -- the string and broke the build.
         COALESCE(s.name, e.name) AS payee_name,
         pv.amount, pv.status, pv.proof_attachment_id, pv.reference_number,
         pv.submitted_by, pv.verified_by, pv.verified_at, pv.approval_id, pv.paid_by, pv.paid_at, pv.paid_via,
         pv.rejection_reason, pv.location_id, l.name AS location_name, pv.notes
    FROM payment_verifications pv
    LEFT JOIN locations l ON l.id = pv.location_id
    LEFT JOIN suppliers s ON pv.payee_type = 'supplier' AND s.id = pv.payee_id
    LEFT JOIN employees e ON pv.payee_type = 'employee' AND e.id = pv.payee_id
`;

export interface PaymentActor {
  userId: UUID;
  /** The RLS `app.role` this request's session is running as (`RequestWithDbContext`'s JWT `roleKey`) — needed to restore the caller's own session context after the escalated INSERT (see `create()`/`createSystemVerification()`). */
  roleKey: string;
  locationScope: readonly UUID[] | null;
}

/**
 * M17 payment verification (CONTRACTS.md §4.17, §5.8; FR-ACCT-01..04): the
 * Pending → Verified → Paid ladder, plus `rejected`. Every state-changing
 * write here is a `PAYMENT_VERIFICATIONS` sync event (`@mimi/shared`'s
 * `SyncEntity`, block 090-099 — unlike `journal_entries`/`chart_of_accounts`
 * /`posting_rules`, which are explicitly NOT sync entities, D-04 derived/
 * cloud-only data).
 *
 * CARRIED ITEM #3 (RLS gap): migration 095's `payment_verifications_role`
 * policy is `ROLE(owner,manager,finance)` for ALL operations, including
 * INSERT's `WITH CHECK` — yet §3's RBAC matrix grants `payment.proof.upload`
 * (the permission gating `POST /api/accounting/payments`, this class's
 * `create()`) to nearly every role, Kasir included. Taken together: a Kasir
 * passes the `PermissionsGuard` and then gets an RLS `WITH CHECK` violation
 * from Postgres on the INSERT itself — exactly the shape of bug
 * `modules/pos/services/pos-sale.service.ts` hit and documented (its own
 * comment, lines ~218-224): a transfer-method sale payment needs a `pending`
 * PV row for Finance's queue (§5.8), and neither a Kasir's own session nor a
 * naive system-context call satisfies the narrower central-role check
 * without a dedicated M17 service. `create()` and `createSystemVerification`
 * below are both that service: each escalates ONLY around the one INSERT
 * (`assertSystemContext` to the central-role bypass), then restores the
 * caller's own session vars before returning — never leaves the surrounding
 * transaction running wider than the acting user's real scope for whatever
 * statement runs next on the same client. `create()` covers the public HTTP
 * endpoint (any of the many roles §3 grants `payment.proof.upload` to);
 * `createSystemVerification` is the same mechanism exposed for a SEPARATE
 * module's own transaction (e.g. POS creating a PV row inline while
 * recording a sale) — cross-module WIRING of that second path (POS actually
 * calling it) is NOT done by this agent, `modules/pos/**` being out of this
 * module's file-ownership — flagged in the module report as the integration
 * step whoever owns POS (or the coordinator) still needs to make.
 */
@Injectable()
export class PaymentVerificationsService {
  private readonly logger = new Logger(PaymentVerificationsService.name);

  constructor(
    private readonly sync: SyncEmitService,
    private readonly eventBus: EventBus,
    private readonly approvals: ApprovalService,
  ) {}

  async list(
    client: PoolClient,
    query: ListPaymentsQueryDto,
  ): Promise<Paginated<PaymentVerification>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (query.status) {
      conds.push(`pv.status = $${i++}`);
      args.push(query.status);
    }
    if (query.refType) {
      conds.push(`pv.ref_type = $${i++}`);
      args.push(query.refType);
    }
    if (query.locationId) {
      conds.push(`pv.location_id = $${i++}`);
      args.push(query.locationId);
    }
    if (query.from) {
      conds.push(`pv.created_at >= $${i++}`);
      args.push(query.from);
    }
    if (query.to) {
      conds.push(`pv.created_at <= $${i++}`);
      args.push(query.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      client.query<PaymentVerificationRow>(
        `${PV_SELECT} ${where} ORDER BY pv.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM payment_verifications pv ${where}`,
        args,
      ),
    ]);
    return {
      rows: rows.rows.map(toPaymentVerification),
      total: Number(count.rows[0]?.count ?? '0'),
      page,
      pageSize,
    };
  }

  async getDetail(
    client: PoolClient,
    id: UUID,
  ): Promise<PaymentVerification & { history: unknown[] }> {
    const row = await this.requireRow(client, id);
    // `AuditRow[]` history is `kernel/audit`'s territory (the `@Audited()` interceptor, W2-C) — this
    // module surfaces an empty history array rather than reaching into audit_log's schema directly,
    // consistent with `Audited()`'s own doc comment (metadata-only until that interceptor is live).
    return { ...toPaymentVerification(row), history: [] };
  }

  async create(
    client: PoolClient,
    actor: PaymentActor,
    dto: CreatePaymentDto,
  ): Promise<PaymentVerification> {
    this.assertScope(actor, dto.locationId ?? null);

    return withWrite(client, async () => {
      const pvNumber = await this.nextPvNumber(client);

      // The read-back (building the response row via `PV_SELECT`'s JOINs) must ALSO happen escalated,
      // not after restoring `actor`'s own session — `payment_verifications_role`'s RLS is central-role-
      // only for SELECT too, so a genuinely scoped caller (Kasir) could insert successfully and then
      // immediately fail to read the very row it just created. Found live by this module's own
      // integration test, which is exactly why it runs under a real `kasir` session rather than `owner`.
      return this.escalatedInsert(client, actor, async () => {
        const res = await client.query<{ id: UUID }>(
          `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, proof_attachment_id, reference_number, submitted_by, location_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            pvNumber,
            dto.refType,
            dto.refId ?? null,
            dto.payeeType,
            dto.payeeId ?? null,
            dto.amount,
            dto.proofAttachmentId ?? null,
            dto.referenceNumber ?? null,
            actor.userId,
            dto.locationId ?? null,
            dto.notes ?? null,
          ],
        );
        // NOTE: no sync event here — `@mimi/sync-protocol`'s registry (`schema/registry.ts`) defines only
        // three wire ops for `payment_verifications`: 'verified', 'paid', 'rejected' ("pull-only: no
        // device push op exists at all" per that package's own authority-matrix test). Creation is a
        // cloud-only fact a device never needs pushed back to it — matches the vocabulary exactly.
        return this.getOne(client, res.rows[0]!.id);
      });
    });
  }

  /**
   * The escalated creation path `pos-sale.service.ts` (and any future
   * caller outside owner/manager/finance) should use instead of a direct
   * INSERT — see the class doc for the RLS reasoning. Runs on the SAME
   * `client`/transaction the caller supplies (so the PV row commits
   * atomically with whatever domain row it references), escalating only for
   * the duration of this one INSERT and restoring the caller's own session
   * context immediately after — a caller mid-transaction as `kasir` is still
   * `kasir` for every statement after this call returns.
   */
  async createSystemVerification(
    client: PoolClient,
    callerContext: { role: string; userId: UUID; locationIds: readonly UUID[] },
    params: {
      refType: string;
      refId: UUID | null;
      payeeType: string;
      payeeId: UUID | null;
      amount: string;
      locationId: UUID | null;
      submittedBy: UUID;
      notes?: string | null;
    },
  ): Promise<UUID> {
    const pvNumber = await this.nextPvNumber(client);
    const actor: PaymentActor = {
      userId: callerContext.userId,
      roleKey: callerContext.role,
      locationScope: callerContext.locationIds,
    };

    const id = await this.escalatedInsert(
      client,
      actor,
      async () =>
        (
          await client.query<{ id: UUID }>(
            `INSERT INTO payment_verifications (pv_number, ref_type, ref_id, payee_type, payee_id, amount, submitted_by, location_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
            [
              pvNumber,
              params.refType,
              params.refId,
              params.payeeType,
              params.payeeId,
              params.amount,
              params.submittedBy,
              params.locationId,
              params.notes ?? null,
            ],
          )
        ).rows[0]!.id,
    );

    // Same reasoning as `create()` above — no 'submitted'/'created' op exists in the wire vocabulary.
    // CAVEAT for the eventual caller (POS or otherwise): a SUBSEQUENT plain `SELECT ... FROM
    // payment_verifications WHERE id = $1` on THIS SAME client, after this method returns, will find
    // nothing — `payment_verifications_role`'s RLS is central-role-only for SELECT too, and this
    // method restores the caller's own (non-central) session before returning. Reading the row back
    // needs the SAME escalation `create()` uses internally (or a read through `PaymentsController`'s
    // `payment.read`-gated endpoint, by a central-role user later). Returning only the bare `id` here
    // — never a hydrated `PaymentVerification` — is deliberate, not an oversight.
    return id;
  }

  /**
   * The one place `assertSystemContext`'s central-role escalation is applied
   * — brackets `fn` (expected to run exactly one INSERT on `client`) between
   * "become the central-role bypass" and "become `actor` again", so neither
   * `fn` nor anything the caller runs afterward on this same client/
   * transaction is ever left running wider than `actor`'s real session.
   * `finally` restores even if `fn` throws (e.g. a CHECK constraint
   * violation) — an escalated role must never leak past its one write.
   */
  private async escalatedInsert<T>(
    client: PoolClient,
    actor: PaymentActor,
    fn: () => Promise<T>,
  ): Promise<T> {
    await assertSystemContext(client, { role: SYSTEM_CENTRAL_ROLE });
    try {
      return await fn();
    } finally {
      await assertSystemContext(client, {
        role: actor.roleKey,
        userId: actor.userId,
        locationIds: actor.locationScope ?? [],
      });
    }
  }

  async uploadProof(
    client: PoolClient,
    _actor: PaymentActor,
    id: UUID,
    proofAttachmentId: UUID,
    referenceNumber?: string,
  ): Promise<PaymentVerification> {
    const row = await this.requireRow(client, id);
    if (row.status !== 'pending') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PV ${row.pv_number} is '${row.status}' — proof can only be attached while pending`,
      });
    }
    return withWrite(client, async () => {
      await client.query(
        `UPDATE payment_verifications SET proof_attachment_id = $2, reference_number = COALESCE($3, reference_number), updated_at = NOW() WHERE id = $1`,
        [id, proofAttachmentId, referenceNumber ?? null],
      );
      // No wire op for 'proof_uploaded' either (see `create()`'s note) — the eventual 'verified' emit is
      // the first point in this ladder a device-facing subscriber needs to hear about.
      return this.getOne(client, id);
    });
  }

  /** FR-ACCT-02/03 — requires proof attached (`ERR_PROOF_REQUIRED`). */
  async verify(
    client: PoolClient,
    actor: PaymentActor,
    id: UUID,
    _note: string | undefined,
  ): Promise<PaymentVerification> {
    const row = await this.requireRow(client, id);
    if (row.status !== 'pending') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PV ${row.pv_number} is '${row.status}', not 'pending'`,
      });
    }
    if (!row.proof_attachment_id) {
      throw new BadRequestException({
        code: ERR_PROOF_REQUIRED,
        message: `PV ${row.pv_number} has no proof attachment — upload one before verifying`,
      });
    }
    return withWrite(client, async () => {
      const verifiedAt = new Date().toISOString();
      await client.query(
        `UPDATE payment_verifications SET status = 'verified', verified_by = $2, verified_at = $3 WHERE id = $1`,
        [id, actor.userId, verifiedAt],
      );
      await this.sync.emit(client, {
        entity: SyncEntity.PAYMENT_VERIFICATIONS,
        op: 'verified',
        entityId: id,
        locationId: row.location_id,
        actorUserId: actor.userId,
        data: { verifiedBy: actor.userId, verifiedAt },
      });
      // §5.8 row 5's Owner step is RAISED here, at verify, and only DECIDED at
      // `pay()` — the same submit-then-decide split `purchase-order.service.ts`
      // uses. The first implementation raised it inside `pay()` instead, and
      // this module's own integration test caught why that cannot work: when
      // Finance is refused, `pay()`'s `withWrite` rolls back, and a single
      // transaction cannot keep the approval while discarding the payment. The
      // approval row AND the Owner's notification were both destroyed on the
      // way out, so Finance was told "needs Owner approval" and the Owner was
      // never told anything.
      //
      // Raising it here commits it with the verify, which is also when it is
      // genuinely true: a verified voucher is exactly one waiting on a
      // decision. Below the threshold `submit()` finds no active step and
      // finalizes `approved` immediately, notifying nobody — so this costs a
      // cheap no-op row on the ordinary path and buys a real queue on the
      // expensive one.
      await this.raiseApprovalChain(client, actor, row);
      return this.getOne(client, id);
    });
  }

  /**
   * Opens the §5.8 approval chain for a verified PV and stores its id on the
   * row. Idempotent by the `approval_id` guard: `ApprovalService.submit`
   * throws `ERR_CONFLICT` on a duplicate, and re-verifying is impossible
   * anyway (`verify()` requires `pending`).
   */
  private async raiseApprovalChain(
    client: PoolClient,
    actor: PaymentActor,
    row: PaymentVerificationRow,
  ): Promise<void> {
    if (row.approval_id) return;
    const submitted = await this.approvals.submit(client, {
      documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
      documentId: row.id,
      requestedBy: actor.userId,
      requestedByRole: actor.roleKey as RoleKey,
      amount: row.amount,
      locationId: row.location_id,
    });
    await client.query(`UPDATE payment_verifications SET approval_id = $2 WHERE id = $1`, [
      row.id,
      submitted.approvalId,
    ]);
  }

  /**
   * FR-ACCT-03/04 — posts the §6 payment journal for the ref type via
   * `EventBus.publish('journal.action', ...)`, exactly like every other
   * domain module (never calls `JournalService`/`PostingEngineService`
   * directly — this module is a producer of the same event its own engine
   * consumes, kept as one seam rather than two).
   */
  async pay(
    client: PoolClient,
    actor: PaymentActor,
    id: UUID,
    dto: PayPaymentDto,
  ): Promise<PaymentVerification> {
    const row = await this.requireRow(client, id);
    if (row.status !== 'verified') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PV ${row.pv_number} is '${row.status}', not 'verified'`,
      });
    }
    return withWrite(client, async () => {
      // §5.8 row 5's Owner step, at last actually enforced. Only DECIDED here
      // — `verify()` is what raised it (see there for why).
      await this.assertOwnerStepCleared(client, actor, row);

      const paidAt = dto.paidAt ?? new Date().toISOString();
      await client.query(
        `UPDATE payment_verifications SET status = 'paid', paid_by = $2, paid_at = $3, paid_via = $4 WHERE id = $1`,
        [id, actor.userId, paidAt, dto.paidVia],
      );
      await this.sync.emit(client, {
        entity: SyncEntity.PAYMENT_VERIFICATIONS,
        op: 'paid',
        entityId: id,
        locationId: row.location_id,
        actorUserId: actor.userId,
        data: { paidBy: actor.userId, paidAt, paidVia: dto.paidVia },
      });

      await this.publishPaymentJournal(row, dto.paidVia, paidAt);
      return this.getOne(client, id);
    });
  }

  async reject(
    client: PoolClient,
    actor: PaymentActor,
    id: UUID,
    reason: string,
  ): Promise<PaymentVerification> {
    const row = await this.requireRow(client, id);
    if (row.status === 'paid' || row.status === 'rejected') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `PV ${row.pv_number} is '${row.status}' — cannot reject`,
      });
    }
    return withWrite(client, async () => {
      await client.query(
        `UPDATE payment_verifications SET status = 'rejected', rejection_reason = $2 WHERE id = $1`,
        [id, reason],
      );
      await this.sync.emit(client, {
        entity: SyncEntity.PAYMENT_VERIFICATIONS,
        op: 'rejected',
        entityId: id,
        locationId: row.location_id,
        actorUserId: actor.userId,
        data: { reason },
      });
      return this.getOne(client, id);
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * CONTRACTS §5.8 row 5: "pay — FIN (`payment.pay`); OWN approval step first
   * when amount >= `approval.threshold.payment.ownerAboveIdr`".
   *
   * ## Why this method had to be written at all
   *
   * Every piece of that gate already existed except the call. The threshold is
   * a `SettingsKey` with a default (`DEFAULT_APPROVAL_THRESHOLDS.payment`,
   * Rp 20.000.000), a validator row, an admin-UI field, and a mapping in
   * `kernel/approvals/threshold.resolver.ts`. The chain step is seeded
   * (`('payment_verification', 1, 'owner', 20000000.00, NULL)`, migration 069).
   * The state machine has the edge, and `ApprovalService.decide`'s own doc
   * comment singles this chain out: "one chain, `payment_verification`, names
   * its threshold-escalated decision `'pay'`, not `'approve'`". `pay()` simply
   * never called any of it and checked nothing but `status === 'verified'` —
   * so a Rp 45.000.000 payroll voucher could be paid outright by Finance, and
   * `payment_verifications.approval_id` was SELECTed everywhere and written
   * nowhere (0 of 395 rows on the dev database had one).
   *
   * ## Decide only — `verify()` is what raised the chain
   *
   * This method never submits. It used to, and the module's own integration
   * test is what proved that wrong: on the refusal path `pay()`'s `withWrite`
   * rolls back, and one transaction cannot keep a freshly-submitted approval
   * while discarding the payment — the approval row and the Owner's
   * notification went with it, so Finance was told "needs Owner approval"
   * while the Owner was told nothing and no pending approval existed anywhere.
   * `verify()` raises it instead, committing it with the verify.
   *
   * ## Why folded into `pay` rather than a separate `/approve` endpoint
   *
   * `frontend/components/approvals/lib/document-types.ts` marks this document
   * type `approveSupported: false` precisely because "the Owner approval step
   * is folded into `POST /api/accounting/payments/:id/pay` (§5.8) — there is no
   * standalone 'approve' endpoint". Honouring that keeps one action for the
   * user and adds no new permission:
   *
   *   - **Below threshold** — `submit()`'s amount window excluded step 1 at
   *     verify time, so the approval was finalized `approved` on creation and
   *     `decide()` reports `ERR_APPROVAL_ALREADY_DECIDED`, which the catch
   *     below reads as "approved, proceed". Payment completes as it always did.
   *   - **At/above threshold, caller is Finance** — the pending Owner step
   *     exists (raised and notified at verify), and `decide()` refuses Finance
   *     with `ERR_APPROVAL_STEP_ROLE`. Translated here into
   *     `ERR_APPROVAL_REQUIRED`, which says the truthful thing: not "you may
   *     not", but "not until the Owner decides".
   *   - **At/above threshold, caller is the Owner** — `decide()` accepts (the
   *     §5 role-rank override lets Owner act on a step listing Finance), the
   *     step closes, and the payment completes in that same click.
   *
   * A PV verified BEFORE this change has no `approval_id`, so the chain is
   * raised inline as a fallback. Such a row is still payable — by the Owner
   * outright, and by Finance once the Owner has acted — but its first refusal
   * rolls back that inline submit, exactly as described above. That is a
   * one-off cost on legacy rows only, and the alternative (a second pool
   * connection purely to commit an approval mid-refusal) buys nothing for the
   * ordinary path.
   */
  private async assertOwnerStepCleared(
    client: PoolClient,
    actor: PaymentActor,
    row: PaymentVerificationRow,
  ): Promise<void> {
    // Legacy rows only — verified before `verify()` started raising the chain.
    if (!row.approval_id) await this.raiseApprovalChain(client, actor, row);
    const approvalId = row.approval_id ?? (await this.currentApprovalId(client, row.id));

    // Let the acting user try to decide the step — the engine owns both the
    // eligibility check and the rank override, and duplicating either here is
    // how the two drift apart. An approval already finalized `approved` (the
    // below-threshold case) surfaces as `ERR_APPROVAL_ALREADY_DECIDED` and is
    // handled in the catch.
    try {
      const decision = await this.approvals.decide(client, {
        documentType: ApprovalDocumentType.PAYMENT_VERIFICATION,
        documentId: row.id,
        currentState: row.status,
        // §5.8's escalated action is named 'pay', not 'approve' — see
        // `ApprovalService.decide`'s doc comment. `approve()`'s sugar wrapper
        // would look tidier here and would fail the state-machine lookup.
        action: 'pay',
        outcome: 'approved',
        actorUserId: actor.userId,
        actorRole: actor.roleKey as RoleKey,
        reason: null,
      });
      if (decision.currentStep !== null) {
        // A multi-step chain would land here (this one has a single step, but
        // the chain is Finance-editable data, not a constant).
        throw new ConflictException({
          code: ERR_APPROVAL_REQUIRED,
          message: `PV ${row.pv_number} still needs approval at step ${decision.currentStep} before it can be paid`,
        });
      }
    } catch (err) {
      if (err instanceof ForbiddenException) {
        const details = err.getResponse() as { details?: { eligibleRoles?: string[] } };
        const eligible = details?.details?.eligibleRoles?.join(', ') ?? 'owner';
        throw new ConflictException({
          code: ERR_APPROVAL_REQUIRED,
          message: `PV ${row.pv_number} is Rp${row.amount} and needs approval from ${eligible} before it can be paid`,
        });
      }
      if (err instanceof ConflictException) {
        const body = err.getResponse() as { code?: string };
        // Already decided: approved earlier (this is a retry after the Owner
        // signed off, or after a failure further down `pay()`) — let it
        // through. Rejected/cancelled must not.
        if (body?.code === ERR_APPROVAL_ALREADY_DECIDED) {
          const state = await client.query<{ state: string }>(
            `SELECT state FROM approvals WHERE id = $1`,
            [approvalId],
          );
          if (state.rows[0]?.state === 'approved') return;
          throw new ConflictException({
            code: ERR_APPROVAL_REQUIRED,
            message: `PV ${row.pv_number}'s approval is '${state.rows[0]?.state ?? 'unknown'}' — it cannot be paid`,
          });
        }
      }
      throw err;
    }
  }

  /**
   * §6.3's X2..X5/JOUT-09 + the two prose-only extensions, dispatched by
   * `ref_type`/`paid_via`/the `notes` kind marker (see `accounting.types.ts`
   * for why `notes` carries the marker instead of a new column/enum value).
   */
  private async publishPaymentJournal(
    row: PaymentVerificationRow,
    paidVia: string,
    paidAt: string,
  ): Promise<void> {
    const kind = extractPvKind(row.notes);
    const base = {
      documentType: 'payment_verification',
      documentId: row.id,
      locationId: row.location_id,
      amount: row.amount,
      occurredAt: paidAt,
    };

    if (kind === 'petty_cash_topup') {
      await this.eventBus.publish('journal.action', {
        ...base,
        eventType: 'petty_cash_topup',
        context: {},
      });
      return;
    }
    if (kind === 'employee_loan_disbursement') {
      await this.eventBus.publish('journal.action', {
        ...base,
        eventType: 'employee_loan_disbursement',
        context: {},
      });
      return;
    }

    switch (row.ref_type) {
      case 'payroll_run':
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'payroll_payment',
          context: {},
        });
        return;
      case 'purchase_order':
        // Settles the 2000 Hutang Supplier leg JGUD-01 credited at PO receipt.
        // The old `default:` swallowed this on the stated grounds that "the
        // ORIGINATING module already posts" the entry — it posts the ACCRUAL,
        // which is precisely what has to be reversed here. Nothing else in §6
        // ever debits 2000 except a retur, so before migration 267 the payable
        // was never cleared and the cash outflow never recorded at all.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'supplier_payment',
          context: { paidVia },
        });
        return;
      case 'maintenance_job':
        // `asset/jobs.service.ts` posts NO journal at completion (it only opens
        // this PV, FR-ACCT-04), so payment is the sole recognition point for
        // maintenance cost. 6200 was an orphan account until migration 267.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'maintenance_payment',
          context: { paidVia },
        });
        return;
      case 'incentive':
      case 'thr':
        // Compensation outside a payroll run — no X1 accrual against 2100 to
        // settle, so 6000 Beban Gaji is debited directly. One shared event
        // type; `journal_entries.ref_type` still records which of the two.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'employee_compensation_payment',
          context: { paidVia },
        });
        return;
      case 'employee_loan':
        // Migration 259 added this `ref_type` and `payroll/loans/loans.service
        // .ts` writes it, but no case existed for it here, so the
        // `employee_loan_disbursement` rule seeded back in migration 093 was
        // unreachable: it keyed off `extractPvKind`'s `#kind:` marker, which no
        // production code has ever written into `notes`. Dispatching on
        // `ref_type` — the real, CHECK-constrained discriminator — is what the
        // marker was a workaround for before 259 existed.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'employee_loan_disbursement',
          context: {},
        });
        return;
      case 'petty_cash':
        // The float REPLENISHMENT. JOUT-07/08 already posted the expense at
        // verify, but those credit 1010 Kas Kecil — i.e. they draw the float
        // DOWN. Paying this PV is what puts the money back (Dr 1010 / Cr 1020),
        // which is exactly the `petty_cash_topup` rule, unreachable behind the
        // same dead `#kind:` marker until now. Without it Kas Kecil declined
        // monotonically in the books while the real tin kept being refilled.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'petty_cash_topup',
          context: {},
        });
        return;
      case 'sale_payment':
        // Distinguish QRIS settlement (X3) vs. transfer verification (X4) by paid_via, per §6.3.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: paidVia === 'qris' ? 'qris_settlement' : 'transfer_verified',
          context: {},
        });
        return;
      case 'online_order':
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'platform_settlement',
          context: {},
        });
        return;
      case 'other':
        // The `if (row.location_id)` guard that used to wrap this is GONE.
        // JOUT-09's trigger is worded "`ref_type='other'` + outlet location",
        // so the guard read as faithful — but combined with a create form that
        // never captured `locationId` at all, it silently discarded the journal
        // for every manually-entered voucher in the system. An expense with no
        // location is a central/HQ expense, not a non-expense: dropping it
        // overstates profit by the full amount and loses the cash movement too.
        //
        // A non-located entry lands on 6100 Beban Operasional Outlet, whose
        // NAME is then mildly wrong. That is the lesser error by a wide margin,
        // and it is visible/correctable in the ledger rather than invisible.
        // The real fix for the naming is a dedicated central-expense account
        // (there is no 61xx "Beban Operasional Pusat" in migration 090's chart)
        // — a chart-of-accounts decision for Finance, not something to invent
        // here. `journal_entries.location_id` stays NULL on those rows, so they
        // are trivially findable if and when that account is added.
        await this.eventBus.publish('journal.action', {
          ...base,
          eventType: 'outlet_operating_expense',
          context: { paidVia },
        });
        return;
      default:
        // Now genuinely unreachable: all ten `ref_type` values in the CHECK
        // constraint (migration 094 + 259's `employee_loan`) have a case above
        // — `sale_payment` and `online_order` among the earlier ones. It is a log
        // rather than a silent return so that ADDING an eleventh ref_type
        // without a posting rule announces itself instead of quietly costing
        // money — which is exactly how the five missing ones survived this long.
        this.logger.error(
          `PV ${row.pv_number} paid with ref_type '${row.ref_type}', which has no journal posting — the general ledger is now short by ${row.amount}. Add a case in publishPaymentJournal and a posting_rules row for it.`,
        );
        return;
    }
  }

  /** The PV's `approval_id` as it stands NOW — `row` is a pre-write snapshot. */
  private async currentApprovalId(client: PoolClient, id: UUID): Promise<UUID | null> {
    const res = await client.query<{ approval_id: UUID | null }>(
      `SELECT approval_id FROM payment_verifications WHERE id = $1`,
      [id],
    );
    return res.rows[0]?.approval_id ?? null;
  }

  private async requireRow(client: PoolClient, id: UUID): Promise<PaymentVerificationRow> {
    const res = await client.query<PaymentVerificationRow>(`${PV_SELECT} WHERE pv.id = $1`, [id]);
    const row = res.rows[0];
    if (!row)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `Payment verification ${id} not found`,
      });
    return row;
  }

  private async getOne(client: PoolClient, id: UUID): Promise<PaymentVerification> {
    return toPaymentVerification(await this.requireRow(client, id));
  }

  private async nextPvNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [DocumentPrefix.PAYMENT_VERIFICATION, period],
    );
    return formatCloudDocNumber(
      DocumentPrefix.PAYMENT_VERIFICATION,
      period,
      res.rows[0]!.last_number,
    );
  }

  /** `payment.proof.upload` (§3) is granted to nearly every role including scoped ones (Kasir, Supervisor) — RLS on `payment_verifications` itself is central-role-only (migration 095), so a scoped submitter's OWN location check has to happen here, in application code, same shape as every other module's `assertLocationInScope`. */
  private assertScope(actor: PaymentActor, locationId: UUID | null): void {
    if (actor.locationScope === null || locationId === null) return;
    if (!actor.locationScope.includes(locationId)) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Not assigned to location ${locationId}`,
      });
    }
  }
}

function toPaymentVerification(row: PaymentVerificationRow): PaymentVerification {
  return {
    id: row.id,
    pvNumber: row.pv_number,
    refType: row.ref_type,
    refId: row.ref_id,
    refNumber: row.ref_number,
    payeeType: row.payee_type,
    payeeName: row.payee_name,
    amount: row.amount,
    status: row.status as PaymentVerification['status'],
    // The ATTACHMENT ID, resolved to a presigned URL by the client
    // (`lib/attachment-url.ts`) — the same contract `waste-return`'s proof
    // fields already use. This used to be `a.object_key AS proof_url`, i.e.
    // the raw S3 key, handed straight to `<a href>` in `PaymentsPanel`. The
    // browser resolved it against the current page and 404'd, so "Lihat Bukti"
    // never opened the proof and a verifier approved payments without once
    // seeing the evidence they were approving against.
    proofAttachmentId: row.proof_attachment_id,
    referenceNumber: row.reference_number,
    submittedBy: row.submitted_by,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    paidBy: row.paid_by,
    paidAt: row.paid_at,
    paidVia: row.paid_via,
    locationName: row.location_name,
  };
}

export { PV_KIND_MARKER };
