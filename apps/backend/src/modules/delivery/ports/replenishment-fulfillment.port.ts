import type { PoolClient } from 'pg';
import type { Qty, RoleKey, UUID } from '@mimi/shared';

/**
 * M09 `replenishment`'s exposed interface for M10 `delivery` to advance a
 * request's status as its Surat Jalan progresses (W3-07 brief: "Advance the
 * originating replenishment request's status via the interface M09 exposes
 * — do not write M09's rows directly").
 *
 * OWNERSHIP: this file declares the shape only — a pure TypeScript
 * `interface`, no logic, no imports beyond types. The IMPLEMENTATION lives
 * in `modules/replenishment/replenishment-advancement.service.ts`
 * (`export class ReplenishmentAdvancementService implements
 * ReplenishmentFulfillmentPort`), built by W3-06 against this exact
 * contract. `delivery.module.ts` imports that class by file path (a
 * read-only cross-directory import of the SAME kind it already does for
 * `ReplenishmentRepository` — `ReplenishmentModule` is still a stub, so
 * there is no module boundary to import through yet) and binds it to the
 * `REPLENISHMENT_FULFILLMENT_PORT` token below. Every call site in THIS
 * module (`services/surat-jalan.service.ts`, `services/drop.service.ts`)
 * depends only on this interface + the token, never on the concrete class,
 * so the binding is the one place that would need to change if W3-06's
 * module wiring lands differently later.
 *
 * `markProcessing`/`markShipped`/`markReceived`/`tryAutoComplete` all run
 * through `@mimi/shared`'s `transition()` state machine internally (never a
 * hand-rolled status check) and treat a rejected/impossible transition as a
 * logged skip, not a thrown error — the SJ/drop side of a shipment is a
 * physical fact that must still apply even if the linked request's own
 * status doesn't expect it (mirrors D-17a's "a replayed fact applies
 * regardless" stance one level up).
 */
export const REPLENISHMENT_FULFILLMENT_PORT = 'REPLENISHMENT_FULFILLMENT_PORT';

export interface ReplenishmentFulfillmentPort {
  /** Sets the fulfilment link at SJ creation (CONTRACTS.md block 030 comment: "sj_id — fulfilment link"). Idempotent. */
  linkSuratJalan(client: PoolClient, requestId: UUID, sjId: UUID): Promise<void>;

  /** `approved -> processing` — SJ `ready` (CONTRACTS.md §4.10: "picking done; linked requests → processing"). */
  markProcessing(client: PoolClient, requestId: UUID, actorUserId: UUID, actorRole: RoleKey): Promise<void>;

  /** `processing -> shipped` at SJ `dispatch` — stamps each line's `qty_shipped`. */
  markShipped(
    client: PoolClient,
    requestId: UUID,
    lineShipments: readonly { requestLineId: UUID; qtyShipped: Qty }[],
    actorUserId: UUID,
    actorRole: RoleKey,
  ): Promise<void>;

  /** `shipped -> received` at a drop's `receive` — stamps each reconciled line's `qty_received`. `isAmendment` forces the `on_amend` reason gate (FR-LOG-13's sibling for internal transfers). */
  markReceived(
    client: PoolClient,
    requestId: UUID,
    lineReceipts: readonly { requestLineId: UUID; qtyReceived: Qty }[],
    actorUserId: UUID,
    actorRole: RoleKey,
    isAmendment: boolean,
    reason: string | null,
  ): Promise<void>;

  /** `received -> completed` once the owning Surat Jalan is fully `completed` and every line is reconciled. Returns whether it advanced. */
  tryAutoComplete(client: PoolClient, requestId: UUID): Promise<boolean>;
}
