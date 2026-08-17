import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { ReplenishmentAdvancementService } from './replenishment-advancement.service';
import { ReplenishmentController } from './replenishment.controller';
import { ReplenishmentRepository } from './replenishment.repository';
import { ReplenishmentService } from './replenishment.service';

/**
 * M09 `replenishment` — Wave 3, agent W3-06 (senior-be).
 *
 * FR-LOG-06..13: outlet request → Supervisor → Kepala Gudang approval chain
 * (kernel `ApprovalService`, D-08) → fulfilment handoff to M10 `delivery`
 * (CONTRACTS.md §4.9). The 9-state lifecycle (`ReplenishmentStatus`) walks
 * `draft → submitted → awaiting_approval → approved → processing` here;
 * `shipped/received/completed` are advanced ONLY through
 * `ReplenishmentAdvancementService`, built against the exact
 * `ReplenishmentFulfillmentPort` interface `modules/delivery/ports/
 * replenishment-fulfillment.port.ts` declares (W3-07's contract; that file
 * is a pure type + a DI token, no logic — see its own header for the split).
 * `delivery.module.ts` binds `REPLENISHMENT_FULFILLMENT_PORT` to this class
 * directly by file path today (both modules were built in parallel, so
 * `ReplenishmentModule` wasn't importable yet when M10 wired that binding);
 * `ReplenishmentRepository` is exported here too so that binding can later
 * collapse to a normal `ReplenishmentModule` import — a change to
 * `delivery.module.ts`, outside this module's exclusive ownership, not made
 * here.
 */
@Module({
  imports: [ApprovalsModule, SyncEngineModule],
  controllers: [ReplenishmentController],
  providers: [ReplenishmentRepository, ReplenishmentService, ReplenishmentAdvancementService],
  exports: [ReplenishmentRepository, ReplenishmentAdvancementService],
})
export class ReplenishmentModule {}
