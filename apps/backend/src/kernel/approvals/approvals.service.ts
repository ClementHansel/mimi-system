import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  Optional,
  Inject,
  Logger,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  ApprovalDocumentType,
  ApprovalMode,
  ApprovalStepState,
  ERR_APPROVAL_ALREADY_DECIDED,
  ERR_APPROVAL_STEP_ROLE,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  isRoleAuthorized,
  RoleKey,
  transition,
  type Money,
  type Paginated,
  type ReverificationStatus,
} from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { NotificationService } from '../notification/notification.service';
import { ApprovalsRepository, type ChainStepConfigRow } from './approvals.repository';
import {
  resolveDocumentContext,
  resolveDocumentContextsBatch,
  resolveEligibleRoles,
} from './document-context.resolver';
import { resolveApproverUserIds } from './notification-recipients';
import { isAmountInWindow, resolveStepWindow } from './threshold.resolver';
import type {
  ApprovalDetailRow,
  ApprovalNotificationChannel,
  CallerScope,
  DbClient,
  DecideApprovalInput,
  DecisionOutcome,
  DecisionResult,
  DocumentContext,
  NamedDecisionInput,
  OfflineReverificationResult,
  PendingApprovalRow,
  PendingApprovalsQuery,
  SubmitApprovalInput,
  SubmitResult,
} from './types';

/**
 * D-23's mode→channel mapping, pulled out of `resolveNotificationChannels()`
 * (below) so `submit()`/`decide()` can reuse it against a `mode` they
 * already read live for their own purposes, instead of re-querying
 * `settings` a second time just to compute channels for the SAME mode value
 * within the SAME call.
 */
function channelsForMode(mode: ApprovalMode): ApprovalNotificationChannel[] {
  switch (mode) {
    case ApprovalMode.OFF:
      return []; // Nothing pending to decide — nobody to notify.
    case ApprovalMode.WHATSAPP:
      return ['in_app', 'whatsapp']; // D-24: WA carries a deep link only, never a decision itself.
    case ApprovalMode.AUTO:
    case ApprovalMode.MANUAL:
    default:
      return ['in_app', 'email'];
  }
}

/**
 * Generic approval engine (D-08). See `types.ts`'s header for the exact
 * division of labour with `@mimi/shared`'s `transition()` and with each
 * owning module's own status column.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  /**
   * B-07 — `notifications`/`pool` are `@Optional()` SOLELY so the ~10
   * existing call sites across domain-module test suites that construct this
   * service directly (`new ApprovalService(new ApprovalsRepository())`,
   * outside Nest DI and outside this kernel's own ownership — e.g.
   * `modules/replenishment/replenishment.integration.spec.ts`,
   * `modules/purchasing/purchasing.integration.spec.ts`,
   * `modules/hr/leaves/leaves.integration.spec.ts`, and others) keep
   * compiling and passing unchanged: with only one constructor arg supplied,
   * both stay `undefined` and every notify hook below no-ops (same
   * try/catch-and-log stance as everything else here — a missing dependency
   * behaves exactly like a failed send, never like a broken approval).
   * Real requests are unaffected: `ApprovalsModule` imports `NotificationModule`
   * and `DATABASE_POOL` is provided by the `@Global()` `DatabaseModule`, so
   * Nest always supplies both in production. This kernel's OWN integration
   * suite (`approvals.integration.spec.ts`) constructs `ApprovalService` with
   * both wired for real, against the live DB, specifically to prove B-07 is
   * closed — see that file's `serviceWithNotifications()` helper.
   */
  constructor(
    private readonly repo: ApprovalsRepository,
    @Optional() private readonly notifications?: NotificationService,
    @Optional() @Inject(DATABASE_POOL) private readonly pool?: Pool,
  ) {}

  // ── submit ──────────────────────────────────────────────────────────────

  async submit(client: DbClient, input: SubmitApprovalInput): Promise<SubmitResult> {
    const existing = await this.repo.findApproval(client, input.documentType, input.documentId);
    if (existing) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `An approval already exists for ${input.documentType}/${input.documentId}`,
      });
    }

    const amount = input.amount ?? null;
    const mode = await this.repo.getApprovalMode(client, input.documentType);

    // D-23 "off": no human gate for this document type — skip chain config
    // entirely (a type can be turned off even with zero/irrelevant chain
    // steps configured) but still record the actor, timestamp, and resulting
    // terminal state, never leave a hole for a report spanning the mode change.
    if (mode === ApprovalMode.OFF) {
      return this.submitWithModeOff(client, input, amount);
    }

    const chainSteps = await this.repo.loadChainSteps(client, input.documentType);
    if (chainSteps.length === 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `No approval_chain_steps configured for document type '${input.documentType}'`,
      });
    }

    const ctx = await resolveDocumentContext(client, input.documentType, input.documentId);
    const { activeStep, skipped } = await this.selectFirstActiveStep(
      client,
      input.documentType,
      chainSteps,
      amount,
    );

    const approval = await this.repo.insertApproval(client, {
      documentType: input.documentType,
      documentId: input.documentId,
      amount,
      locationId: input.locationId ?? null,
      requestedBy: input.requestedBy,
      currentStep: activeStep ? activeStep.stepNo : (chainSteps.at(-1)?.stepNo ?? 1),
    });

    for (const step of skipped) {
      await this.repo.markStepSkipped(client, approval.id, step.stepNo, step.approverRole);
    }

    if (!activeStep) {
      // Every configured step's window excludes this document's amount (e.g. below every escalation threshold) —
      // nothing gates it; the approval is immediately final.
      const finalized = await this.repo.finalizeApproval(client, approval.id, 'approved');
      return {
        approvalId: approval.id,
        approvalState: finalized.state,
        currentStep: null,
        stepState: ApprovalStepState.SKIPPED,
        mode,
      };
    }

    const eligible = resolveEligibleRoles(
      input.documentType,
      activeStep.stepNo,
      activeStep.approverRole as RoleKey,
      ctx,
    );
    const stepRow = await this.repo.insertStep(client, {
      approvalId: approval.id,
      stepNo: activeStep.stepNo,
      approverRole: eligible[0]!,
      state: 'pending',
    });

    // B-07 — step 1's approvers are told there is something waiting. Never for `submitWithModeOff`
    // above (no pending step ever exists there — off notifies nobody) and never when the amount
    // window skipped every step (the `!activeStep` branch above returns before reaching here).
    await this.notifyStepPending(
      client,
      input.documentType,
      input.documentId,
      activeStep.stepNo,
      activeStep.approverRole as RoleKey,
      ctx,
      input.locationId ?? null,
      mode,
    );

    return {
      approvalId: approval.id,
      approvalState: approval.state,
      currentStep: stepRow.stepNo,
      stepState: stepRow.state,
      mode,
    };
  }

  /**
   * D-23 "off" path — factored out of `submit()` so the normal chain-driven
   * path above stays exactly as readable as before this ticket. Bypasses
   * `approval_chain_steps` entirely: `off` is a per-document-type switch, not
   * a chain-shape decision, so it must work even for a type whose chain was
   * never configured (or was configured and is simply being bypassed).
   */
  private async submitWithModeOff(
    client: DbClient,
    input: SubmitApprovalInput,
    amount: Money | null,
  ): Promise<SubmitResult> {
    const approval = await this.repo.insertApproval(client, {
      documentType: input.documentType,
      documentId: input.documentId,
      amount,
      locationId: input.locationId ?? null,
      requestedBy: input.requestedBy,
      currentStep: 1,
    });

    const decidedStep = await this.repo.insertAutoApprovedStep(client, {
      approvalId: approval.id,
      stepNo: 1,
      approverRole: input.requestedByRole ?? 'system',
      actedBy: input.requestedBy,
      reason: `Auto-recorded — approval mode is 'off' for '${input.documentType}' (D-23); no human decision required.`,
    });

    const finalized = await this.repo.finalizeApproval(client, approval.id, 'approved');

    return {
      approvalId: approval.id,
      approvalState: finalized.state,
      currentStep: null,
      stepState: decidedStep.state,
      mode: ApprovalMode.OFF,
    };
  }

  /**
   * D-23 — which channels a `NotificationService.notify({ channels })` call
   * should be restricted to for THIS document type's current mode. Read live
   * (same call-time semantics as `submit()`'s own mode read) rather than
   * cached, so an Owner flipping a type between `manual`/`whatsapp` takes
   * effect on the very next request that needs to notify, with no restart.
   *
   * B-07: this is exactly the `channels` override every `notify()` call this
   * service itself makes (`notifyStepPending`/`notifyDecision` below) is
   * built on — `channelsForMode()` at the top of this file is the same
   * mapping, reused there against a `mode` already read live for other
   * reasons, to avoid a second `settings` round-trip within the same
   * `submit()`/`decide()` call. `kernel/notification`'s `approval_pending`/
   * `approval_decided` templates now both declare `channels: ['in_app',
   * 'email', 'whatsapp']` (widened as part of closing B-07 — previously
   * `approval_pending` declared `['in_app']` only, which `NotificationService
   * .notify()`'s INTERSECTION of the template's list with this method's
   * `channels` override silently collapsed every mode down to in-app-only)
   * — kept exposed publicly for any external caller/test that wants the
   * resolved channel set without re-deriving it.
   */
  async resolveNotificationChannels(
    client: DbClient,
    documentType: ApprovalDocumentType,
  ): Promise<ApprovalNotificationChannel[]> {
    const mode = await this.repo.getApprovalMode(client, documentType);
    return channelsForMode(mode);
  }

  /** D-23 — the live-resolved mode for a document type, exposed for callers/tests that need it without re-deriving it from a `submit()`/`resolveNotificationChannels()` call. */
  async getMode(client: DbClient, documentType: ApprovalDocumentType): Promise<ApprovalMode> {
    return this.repo.getApprovalMode(client, documentType);
  }

  // ── decide (approve / reject / amend / cancel, + any other named chain decision) ─

  async approve(client: DbClient, input: NamedDecisionInput): Promise<DecisionResult> {
    return this.decide(client, { ...input, action: 'approve', outcome: 'approved' });
  }

  async reject(client: DbClient, input: NamedDecisionInput): Promise<DecisionResult> {
    return this.decide(client, { ...input, action: 'reject', outcome: 'rejected' });
  }

  /** FR-LOG-13 / FR-SO-02: an "amend" is an approve that changed the requested quantity/lines — the reason gate is `transition()`'s `on_amend` rule. */
  async amend(client: DbClient, input: NamedDecisionInput): Promise<DecisionResult> {
    return this.decide(client, {
      ...input,
      action: 'approve',
      outcome: 'approved',
      isAmendment: true,
    });
  }

  async cancel(client: DbClient, input: NamedDecisionInput): Promise<DecisionResult> {
    return this.decide(client, { ...input, action: 'cancel', outcome: 'cancelled' });
  }

  /**
   * The general form behind the 4 sugar wrappers above. Takes an explicit
   * `action` (the `@mimi/shared` `transition()` action name for this edge)
   * and `outcome` (how it affects THIS engine's bookkeeping) separately —
   * required because one chain, `payment_verification`, names its
   * threshold-escalated decision `'pay'`, not `'approve'` (its `'verify'`
   * action has no escalation and never reaches this method at all — see
   * `types.ts`'s `DecideApprovalInput` doc comment).
   */
  async decide(client: DbClient, input: DecideApprovalInput): Promise<DecisionResult> {
    const approval = await this.repo.findApproval(client, input.documentType, input.documentId);
    if (!approval) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No approval found for ${input.documentType}/${input.documentId}`,
      });
    }
    if (approval.state !== 'pending') {
      throw new ConflictException({
        code: ERR_APPROVAL_ALREADY_DECIDED,
        message: `Approval ${approval.id} is already ${approval.state}`,
      });
    }
    // `approvals.current_step` is nullable (migration 216 — NULL means "chain finished"), but the
    // guard above just confirmed `state === 'pending'`, which invariantly means a step IS active.
    // One assertion here, not one per call site.
    const currentStep = approval.currentStep!;

    const ctx = await resolveDocumentContext(client, input.documentType, input.documentId);
    const chainSteps = await this.repo.loadChainSteps(client, input.documentType);
    // B-07 — read live only when a notify hook could actually fire (this service is wired with
    // `notifications`/`pool`); skips a `settings` round-trip entirely for the ~10 domain-module test
    // suites that construct `ApprovalService` bare (see the constructor's doc comment).
    const mode =
      this.notifications && this.pool
        ? await this.repo.getApprovalMode(client, input.documentType)
        : null;

    if (input.outcome !== 'cancelled') {
      const stepCfg = chainSteps.find((s) => s.stepNo === currentStep);
      if (!stepCfg) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `No approval_chain_steps row for ${input.documentType} step ${currentStep}`,
        });
      }
      const eligible = resolveEligibleRoles(
        input.documentType,
        currentStep,
        stepCfg.approverRole as RoleKey,
        ctx,
      );
      if (!isRoleAuthorized(eligible, input.actorRole)) {
        throw new ForbiddenException({
          code: ERR_APPROVAL_STEP_ROLE,
          message: `Role '${input.actorRole}' may not act on ${input.documentType} step ${currentStep} (eligible: ${eligible.join(', ')})`,
          details: { eligibleRoles: eligible },
        });
      }
    }

    const result = transition({
      documentType: input.documentType,
      variant: ctx.variant,
      currentState: input.currentState,
      action: input.action,
      actorRole: input.actorRole,
      reasonProvided: Boolean(input.reason && input.reason.trim().length > 0),
      isAmendment: input.isAmendment,
      offlineAttempt: Boolean(input.offline),
    });

    if (!result.ok) throw mapTransitionFailure(result.code, result.message);

    if (input.outcome === 'cancelled') {
      const finalized = await this.repo.finalizeApproval(client, approval.id, 'cancelled');
      const currentStepRow = await this.repo.findStep(client, approval.id, currentStep);
      await this.notifyDecision(
        client,
        input.documentType,
        input.documentId,
        approval.requestedBy,
        approval.locationId,
        'cancelled',
        input.reason ?? null,
        mode,
      );
      return {
        approvalId: approval.id,
        approvalState: finalized.state,
        nextState: result.nextState,
        currentStep: null,
        stepState: currentStepRow?.state ?? ApprovalStepState.PENDING,
      };
    }

    const decidedStepState = input.outcome === 'rejected' ? 'rejected' : 'approved';
    const decidedStep = await this.repo.decideStep(client, {
      approvalId: approval.id,
      stepNo: currentStep,
      state: decidedStepState,
      actedBy: input.actorUserId,
      reason: input.reason ?? null,
      offlineAuthorized: Boolean(input.offline),
      offlineCredentialId: input.offline?.credentialId ?? null,
    });
    if (!decidedStep) {
      // Someone else decided this exact step between our read and our write (approval.state was still 'pending' at
      // read time but the guarded UPDATE matched zero rows) — a genuine race, not a client bug.
      throw new ConflictException({
        code: ERR_APPROVAL_ALREADY_DECIDED,
        message: `Step ${currentStep} of approval ${approval.id} was already decided`,
      });
    }

    if (input.outcome === 'rejected') {
      const finalized = await this.repo.finalizeApproval(client, approval.id, 'rejected');
      // FR-LOG-13/FR-SO-02's reason gate already made `transition()` require a reason for this edge —
      // `input.reason` is never empty here, but `notifyDecision` still defends against `null` uniformly.
      await this.notifyDecision(
        client,
        input.documentType,
        input.documentId,
        approval.requestedBy,
        approval.locationId,
        'rejected',
        input.reason ?? null,
        mode,
      );
      return {
        approvalId: approval.id,
        approvalState: finalized.state,
        nextState: result.nextState,
        currentStep: null,
        stepState: decidedStep.state,
      };
    }

    // approved / amended — advance to the next active step, or finalize.
    const { activeStep, skipped } = await this.selectNextActiveStep(
      client,
      input.documentType,
      chainSteps,
      currentStep,
      approval.amount,
    );
    for (const step of skipped) {
      await this.repo.markStepSkipped(client, approval.id, step.stepNo, step.approverRole);
    }

    if (activeStep) {
      const eligible = resolveEligibleRoles(
        input.documentType,
        activeStep.stepNo,
        activeStep.approverRole as RoleKey,
        ctx,
      );
      await this.repo.insertStep(client, {
        approvalId: approval.id,
        stepNo: activeStep.stepNo,
        approverRole: eligible[0]!,
        state: 'pending',
      });
      const advanced = await this.repo.advanceApproval(client, approval.id, activeStep.stepNo);
      // B-07 — the NEXT step's approvers are told (step advance).
      await this.notifyStepPending(
        client,
        input.documentType,
        input.documentId,
        activeStep.stepNo,
        activeStep.approverRole as RoleKey,
        ctx,
        approval.locationId,
        mode,
      );
      // An amendment changed the requester's own document (FR-LOG-13/FR-SO-02 — "someone whose order
      // was silently halved needs to know") even though the CHAIN isn't finished yet — tell the
      // requester now rather than only once the whole chain eventually finalizes.
      if (input.isAmendment) {
        await this.notifyDecision(
          client,
          input.documentType,
          input.documentId,
          approval.requestedBy,
          approval.locationId,
          'approved',
          input.reason ?? null,
          mode,
        );
      }
      return {
        approvalId: approval.id,
        approvalState: advanced.state,
        nextState: result.nextState,
        currentStep: activeStep.stepNo,
        stepState: decidedStep.state,
      };
    }

    const finalized = await this.repo.finalizeApproval(client, approval.id, 'approved');
    // B-07 — chain finished: the requester is told the (final) outcome. Covers the plain terminal
    // approve case; the amendment-mid-chain case above already notified separately.
    await this.notifyDecision(
      client,
      input.documentType,
      input.documentId,
      approval.requestedBy,
      approval.locationId,
      'approved',
      input.reason ?? null,
      mode,
    );
    return {
      approvalId: approval.id,
      approvalState: finalized.state,
      nextState: result.nextState,
      currentStep: null,
      stepState: decidedStep.state,
    };
  }

  // ── step selection helpers (threshold-aware) ─────────────────────────────

  private async selectFirstActiveStep(
    client: DbClient,
    documentType: ApprovalDocumentType,
    chainSteps: readonly ChainStepConfigRow[],
    amount: Money | null,
  ): Promise<{ activeStep: ChainStepConfigRow | null; skipped: ChainStepConfigRow[] }> {
    const skipped: ChainStepConfigRow[] = [];
    for (const step of chainSteps) {
      const window = await resolveStepWindow(client, documentType, step.stepNo, {
        minAmount: step.minAmount,
        maxAmount: step.maxAmount,
      });
      if (isAmountInWindow(amount, window)) return { activeStep: step, skipped };
      skipped.push(step);
    }
    return { activeStep: null, skipped };
  }

  private async selectNextActiveStep(
    client: DbClient,
    documentType: ApprovalDocumentType,
    chainSteps: readonly ChainStepConfigRow[],
    afterStepNo: number,
    amount: Money | null,
  ): Promise<{ activeStep: ChainStepConfigRow | null; skipped: ChainStepConfigRow[] }> {
    const skipped: ChainStepConfigRow[] = [];
    for (const step of chainSteps) {
      if (step.stepNo <= afterStepNo) continue;
      const window = await resolveStepWindow(client, documentType, step.stepNo, {
        minAmount: step.minAmount,
        maxAmount: step.maxAmount,
      });
      if (isAmountInWindow(amount, window)) return { activeStep: step, skipped };
      skipped.push(step);
    }
    return { activeStep: null, skipped };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async getDetail(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: string,
  ): Promise<ApprovalDetailRow> {
    const approval = await this.repo.findApproval(client, documentType, documentId);
    if (!approval)
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No approval found for ${documentType}/${documentId}`,
      });
    const steps = await this.repo.listSteps(client, approval.id);
    return {
      approvalId: approval.id,
      documentType: approval.documentType,
      documentId: approval.documentId,
      state: approval.state,
      amount: approval.amount,
      locationId: approval.locationId,
      requestedBy: approval.requestedBy,
      requestedAt: approval.requestedAt,
      decidedAt: approval.decidedAt,
      currentStep: approval.currentStep,
      steps: steps.map((s) => ({
        stepNo: s.stepNo,
        approverRole: s.approverRole,
        state: s.state,
        // `actedBy` stays the USER ID: it is the audit fact, and
        // `approvals.integration.spec.ts` asserts an auto-approved step still
        // records a real actor rather than going anonymous.
        actedBy: s.actedBy,
        // …and the DISPLAY name travels beside it. The timeline renders
        // "… oleh {x}" directly, and with only the id available it printed
        // "oleh 640218f4-cdbd-4d65-80ae-8b1c31ececc0" for every decided step
        // (found 2026-09-02). Null when the caller may not read that user row —
        // `users_select` hides them from most roles — and the UI shows an em
        // dash rather than falling back to the id.
        actedByName: s.actedByName ?? null,
        actedAt: s.actedAt,
        reason: s.reason,
        offlineAuthorized: s.offlineAuthorized,
        offlineCredentialId: s.offlineCredentialId,
        reverificationStatus: s.reverificationStatus,
        reverifiedAt: s.reverifiedAt,
      })),
    };
  }

  /** "My pending approvals" — CONTRACTS.md §4.0 `GET /api/approvals/pending`, scoped by role AND location (BUILD-PLAN W2-B brief). */
  async getPending(
    client: DbClient,
    caller: CallerScope,
    query: PendingApprovalsQuery,
  ): Promise<Paginated<PendingApprovalRow>> {
    const candidates = await this.repo.findPendingCandidates(client, {
      documentType: query.documentType,
      locationIds: caller.locationIds,
    });

    const byType = new Map<string, typeof candidates>();
    for (const row of candidates) {
      const bucket = byType.get(row.documentType);
      if (bucket) bucket.push(row);
      else byType.set(row.documentType, [row]);
    }

    const eligibleRows: PendingApprovalRow[] = [];
    for (const [documentType, rows] of byType) {
      const docIds = rows.map((r) => r.documentId);
      // Sequential, not `Promise.all` — a single `PoolClient` runs one query at a time (BUILD-PLAN
      // §2 raw `pg`, no connection-per-call pooling trick here); concurrent queries on one client
      // is a deprecated pg pattern that will become a hard error.
      const contexts = await resolveDocumentContextsBatch(
        client,
        documentType as ApprovalDocumentType,
        docIds,
      );
      const numbers = await this.repo.loadDocumentNumbers(
        client,
        documentType as ApprovalDocumentType,
        docIds,
      );

      for (const row of rows) {
        const ctx: DocumentContext = contexts.get(row.documentId) ?? {};
        const eligible = resolveEligibleRoles(
          documentType as ApprovalDocumentType,
          row.stepNo,
          row.approverRole as RoleKey,
          ctx,
        );
        if (!isRoleAuthorized(eligible, caller.roleKey)) continue;

        eligibleRows.push({
          approvalId: row.approvalId,
          documentType: row.documentType,
          documentId: row.documentId,
          documentNumber: numbers.get(row.documentId) ?? null,
          amount: row.amount,
          locationId: row.locationId,
          locationName: row.locationName,
          requestedBy: row.requestedByName,
          requestedAt: row.requestedAt,
          stepNo: row.stepNo,
          summary: {},
        });
      }
    }

    eligibleRows.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const total = eligibleRows.length;
    const start = (query.page - 1) * query.pageSize;
    const rows = eligibleRows.slice(start, start + query.pageSize);
    return { rows, total, page: query.page, pageSize: query.pageSize };
  }

  // ── offline authorization (D-17) ─────────────────────────────────────────

  /**
   * Re-verification hook (D-17, SYNC-PROTOCOL §7.4). The actual credential
   * cryptography (binding HMAC, expiry-vs-`relay_received_at`, volume cap —
   * §7.4 checks 1-8) reads `offline_credentials`/`offline_authorizations`,
   * tables owned by `kernel/sync` (W2-D, migration block 120-129) — outside
   * this agent's `kernel/approvals` ownership. This engine's job is the
   * `approval_steps` side of D-17: recording `reverification_status` +
   * `reverified_at`, and flagging `failed`/`unprovable` outcomes for the
   * finance exception queue (SYNC-PROTOCOL §7.5), which `kernel/sync`/the
   * accounting module owns writing to (`sync_conflicts`, queue='finance').
   * Callers pass the outcome already computed by that pipeline.
   */
  async reverifyOfflineStep(
    client: DbClient,
    approvalStepId: string,
    outcome: ReverificationStatus,
  ): Promise<OfflineReverificationResult> {
    const updated = await this.repo.updateStepReverification(client, approvalStepId, outcome);
    if (!updated) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No approval step found with id ${approvalStepId}`,
      });
    }
    return {
      approvalId: updated.approvalId,
      stepNo: updated.stepNo,
      outcome,
      requiresFinanceException: outcome !== 'verified',
    };
  }

  // ── B-07: notify hooks (submit / step-advance / decision) ────────────────
  // Fired from `submit()`/`decide()` above — never from a domain module (see
  // this class's file header: "the service already knows the document type,
  // the resolved mode, and which roles are eligible for the current step").
  // Every hook below is wrapped so a notification failure NEVER surfaces to
  // the caller — same try/catch-and-log stance `AuditInterceptor` takes for
  // its own non-critical write (`kernel/audit/audit.interceptor.ts`): a
  // supervisor's phone being off, or an SMTP hiccup, is not a reason to fail
  // an approval that already committed its own bookkeeping.

  /** Step 1 (on submit) or the newly-advanced step (on decide) — tells that step's eligible approvers something is waiting. No-ops entirely under `off` mode (`channelsForMode` returns `[]`) or when this instance wasn't wired with `notifications`/`pool` (see the constructor's doc comment). */
  private async notifyStepPending(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: string,
    stepNo: number,
    storedRole: RoleKey,
    ctx: DocumentContext,
    locationId: string | null,
    mode: ApprovalMode | null,
  ): Promise<void> {
    if (!mode || !this.notifications || !this.pool) return;
    const channels = channelsForMode(mode);
    if (channels.length === 0) return;
    try {
      const eligible = resolveEligibleRoles(documentType, stepNo, storedRole, ctx);
      const userIds = await resolveApproverUserIds(this.pool, eligible, locationId);
      if (userIds.length === 0) return;
      const documentNumber = await this.documentNumberFor(client, documentType, documentId);
      const locationName = locationId ? await this.repo.findLocationName(client, locationId) : null;
      await this.notifications.notify({
        templateKey: 'approval_pending',
        userIds,
        channels,
        locationId: locationId ?? undefined,
        params: {
          documentType,
          documentNumber,
          locationName: locationName ?? '-',
          deepLink: this.deepLinkFor(documentType, documentId),
        },
      });
    } catch (err) {
      this.logger.warn(
        `B-07: failed to notify pending approvers for ${documentType}/${documentId} step ${stepNo} — approval itself is unaffected: ${errorMessage(err)}`,
      );
    }
  }

  /** Tells the requester the outcome of a decision — fired on reject, cancel, and every approve that either finishes the chain or was an amendment (FR-LOG-13/FR-SO-02: an amendment changed their document NOW, not just once the chain eventually finishes). `reason` is always rendered (a literal `'-'` when none was given) rather than conditionally included — see `template-registry.ts`'s `approval_decided` doc comment. */
  private async notifyDecision(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: string,
    requestedBy: string,
    locationId: string | null,
    outcome: DecisionOutcome,
    reason: string | null,
    mode: ApprovalMode | null,
  ): Promise<void> {
    if (!mode || !this.notifications || !this.pool) return;
    const channels = channelsForMode(mode);
    if (channels.length === 0) return;
    try {
      const documentNumber = await this.documentNumberFor(client, documentType, documentId);
      await this.notifications.notify({
        templateKey: 'approval_decided',
        userIds: [requestedBy],
        channels,
        locationId: locationId ?? undefined,
        params: {
          documentType,
          documentNumber,
          outcome,
          reason: reason?.trim() ? reason.trim() : '-',
          deepLink: this.deepLinkFor(documentType, documentId),
        },
      });
    } catch (err) {
      this.logger.warn(
        `B-07: failed to notify requester of ${documentType}/${documentId} decision (${outcome}) — approval itself is unaffected: ${errorMessage(err)}`,
      );
    }
  }

  /** `documentNumber` param for a notify call, falling back to the raw `documentId` for the 3 document types with no human-facing number column (`DOCUMENT_NUMBER_SOURCE` in `approvals.repository.ts`: void_refund, leave_request, cash_variance_proposal). */
  private async documentNumberFor(
    client: DbClient,
    documentType: ApprovalDocumentType,
    documentId: string,
  ): Promise<string> {
    const numbers = await this.repo.loadDocumentNumbers(client, documentType, [documentId]);
    return numbers.get(documentId) ?? documentId;
  }

  /**
   * D-24 — every channel (not just WhatsApp) carries a link into the
   * authenticated app rather than acting as the decision surface itself; a
   * WA reply must never approve anything. `documentType`+`documentId` is
   * exactly what `GET /api/approvals/:documentType/:documentId`
   * (`approvals.controller.ts`) already keys its own detail read on, so the
   * frontend route this points at mirrors that same shape
   * (`/approvals/:documentType/:documentId`).
   *
   * B-13 CLOSED 2026-08-23: that route was ASSUMED when this was written and
   * did not actually exist — every approval notification, WhatsApp included,
   * carried a link that 404'd, which is worse than sending nothing. Both halves
   * exist now (`app/approvals/[documentType]/[documentId]/page.tsx` for the
   * link, `app/approvals/page.tsx` for the inbox `getPending()` feeds), and two
   * tests stop them drifting apart: the shape is pinned below in
   * `approvals.integration.spec.ts`, and the ROUTE'S EXISTENCE is pinned in
   * `apps/frontend/src/app/approvals/deep-link-route.test.tsx` — a filesystem
   * assertion, because the failure mode is a folder rename that no amount of
   * rendering would catch.
   *
   * `APP_WEB_BASE_URL` is read directly from `process.env`
   * (not via `ConfigService`) so this stays a same-shaped optional add rather
   * than a third constructor dependency every bare `new ApprovalService(...)`
   * call site would also need to tolerate.
   */
  private deepLinkFor(documentType: ApprovalDocumentType, documentId: string): string {
    const base = (process.env.APP_WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/approvals/${documentType}/${documentId}`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapTransitionFailure(code: string, message: string): never {
  switch (code) {
    case ERR_APPROVAL_STEP_ROLE:
      throw new ForbiddenException({ code, message });
    default:
      throw new BadRequestException({ code, message });
  }
}
