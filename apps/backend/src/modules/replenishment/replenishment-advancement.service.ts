import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApprovalDocumentType, SYSTEM_ACTOR, transition, type Actor, type Qty, type RoleKey, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import type { ReplenishmentFulfillmentPort } from '../delivery/ports/replenishment-fulfillment.port';
import { ReplenishmentRepository } from './replenishment.repository';

/**
 * M09's exposed interface for M10 `delivery` (W3-07) to advance a
 * replenishment request's status as its Surat Jalan progresses — the
 * brief's "expose a way for delivery to advance them rather than letting it
 * write your rows." Implements `ReplenishmentFulfillmentPort`
 * (`modules/delivery/ports/replenishment-fulfillment.port.ts`) VERBATIM —
 * that file's own header names the exact hand-off: "the IMPLEMENTATION
 * lives in `modules/replenishment/replenishment-advancement.service.ts`...
 * built by W3-06 against this exact contract." `implements
 * ReplenishmentFulfillmentPort` is a compile-time guarantee the two stay
 * signature-compatible; nothing here re-declares the shape by hand.
 *
 * `delivery.module.ts` binds `REPLENISHMENT_FULFILLMENT_PORT` to this class
 * directly, by file path (`ReplenishmentModule` is not imported there —
 * their own header explains why: avoiding an edit to this module's file
 * while both were built in parallel). Every M10 call site depends on the
 * PORT INTERFACE, never this concrete class, so nothing on their side needs
 * to change if that binding is later routed through a proper
 * `ReplenishmentModule` import instead (this module exports
 * `ReplenishmentRepository` for exactly that future collapse).
 *
 * FACT-APPLICATION STANCE (mirrors the port's own doc comment): a missing
 * request, or a transition `transition()` rejects (e.g. called twice, or a
 * request an operator already advanced by hand), is logged and SKIPPED,
 * never thrown — the SJ/drop side of a shipment is a physical fact that
 * must still apply even if the linked request row is in a state that
 * doesn't expect it. This mirrors D-17a's "a replayed fact is applied, not
 * rejected" stance one level up: the fact here is "this drop happened", not
 * "this document transition is valid".
 *
 * SYNC EMISSION: `fulfillment_started` (processing) and `shipped` are
 * emitted here (SYNC-PROTOCOL §3.3 group 4, `@mimi/sync-protocol`'s
 * registered payload schemas) so the requesting outlet's own devices learn
 * the status change. No op exists for the `shipped -> received` edge itself
 * — the wire fact for a drop being received is `sj_drops.received`, M10's
 * own event; `markReceived` below only projects the resulting status.
 */
@Injectable()
export class ReplenishmentAdvancementService implements ReplenishmentFulfillmentPort {
  private readonly logger = new Logger(ReplenishmentAdvancementService.name);

  constructor(
    private readonly repo: ReplenishmentRepository,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async linkSuratJalan(client: PoolClient, requestId: UUID, sjId: UUID): Promise<void> {
    await this.repo.setSjLink(client, requestId, sjId);
  }

  async markProcessing(client: PoolClient, requestId: UUID, actorUserId: UUID, actorRole: RoleKey): Promise<void> {
    const row = await this.repo.findByIdForUpdate(client, requestId);
    if (!row) return this.skip(requestId, 'process', 'request not found');
    const next = this.tryTransition(requestId, row.status, 'process', actorRole);
    if (!next) return;

    await this.repo.updateStatus(client, requestId, next);
    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: 'fulfillment_started',
      entityId: requestId,
      locationId: row.locationId,
      actorUserId,
      data: { id: requestId },
    });
  }

  async markShipped(
    client: PoolClient,
    requestId: UUID,
    lineShipments: readonly { requestLineId: UUID; qtyShipped: Qty }[],
    actorUserId: UUID,
    actorRole: RoleKey,
  ): Promise<void> {
    const row = await this.repo.findByIdForUpdate(client, requestId);
    if (!row) return this.skip(requestId, 'dispatch', 'request not found');
    const next = this.tryTransition(requestId, row.status, 'dispatch', actorRole);

    for (const line of lineShipments) {
      await this.repo.setLineShipped(client, line.requestLineId, line.qtyShipped);
    }
    if (!next) return;

    await this.repo.updateStatus(client, requestId, next);
    const sjId = row.sjId;
    if (sjId) {
      await this.syncEmit.emit(client, {
        entity: 'replenishment_requests',
        op: 'shipped',
        entityId: requestId,
        locationId: row.locationId,
        actorUserId,
        data: { id: requestId, sjId },
      });
    } else {
      this.logger.warn(`replenishment_requests/${requestId} marked shipped with no sj_id set — linkSuratJalan should have run at SJ creation`);
    }
  }

  async markReceived(
    client: PoolClient,
    requestId: UUID,
    lineReceipts: readonly { requestLineId: UUID; qtyReceived: Qty }[],
    _actorUserId: UUID,
    actorRole: RoleKey,
    isAmendment: boolean,
    reason: string | null,
  ): Promise<void> {
    const row = await this.repo.findByIdForUpdate(client, requestId);
    if (!row) return this.skip(requestId, 'receive', 'request not found');
    const next = this.tryTransition(requestId, row.status, 'receive', actorRole, {
      reasonProvided: Boolean(reason && reason.trim().length > 0),
      isAmendment,
    });

    for (const line of lineReceipts) {
      await this.repo.setLineReceived(client, line.requestLineId, line.qtyReceived);
    }
    if (!next) return;

    await this.repo.updateStatus(client, requestId, next);
    // No `replenishment_requests` sync op exists for this edge (see class header) — the wire fact is
    // `sj_drops.received`, emitted by M10 itself; this module only projects the resulting status.
  }

  async tryAutoComplete(client: PoolClient, requestId: UUID): Promise<boolean> {
    const row = await this.repo.findByIdForUpdate(client, requestId);
    if (!row || row.status !== 'received') return false;

    const unreconciled = await this.repo.countUnreconciledLines(client, requestId);
    if (unreconciled > 0) return false;

    const next = this.tryTransition(requestId, row.status, 'auto_complete', SYSTEM_ACTOR);
    if (next !== 'completed') return false;

    await this.repo.updateStatus(client, requestId, next);
    await this.syncEmit.emit(client, {
      entity: 'replenishment_requests',
      op: 'completed',
      entityId: requestId,
      locationId: row.locationId,
      // No human actor decided this edge — attributed to the request's original requester (a real,
      // traceable user row) rather than inventing a new global "system user" sentinel for one field.
      actorUserId: row.requestedBy,
      data: { id: requestId },
    });
    return true;
  }

  private tryTransition(
    requestId: UUID,
    currentState: string,
    action: string,
    actorRole: Actor,
    opts: { reasonProvided?: boolean; isAmendment?: boolean } = {},
  ): string | null {
    const result = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState,
      action,
      actorRole,
      reasonProvided: opts.reasonProvided,
      isAmendment: opts.isAmendment,
    });
    if (!result.ok) {
      this.skip(requestId, action, `${currentState} --${action}--> rejected: ${result.message}`);
      return null;
    }
    return result.nextState;
  }

  private skip(requestId: UUID, action: string, detail: string): void {
    this.logger.warn(`replenishment_requests/${requestId}: skipping '${action}' (${detail}) — the SJ/drop-side fact still applies`);
  }
}
