import { Module, type OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { EventsModule } from '../../kernel/events/events.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { StockOpnameController } from './stock-opname.controller';
import { StockOpnameRepository } from './stock-opname.repository';
import { StockOpnameService } from './stock-opname.service';
import { StockOpnameSyncProjector } from './stock-opname-sync-projector.service';

/**
 * M08 `stock-opname` — owned by Wave 3, agent W3-05 (medior).
 *
 * FR-SO-01..04: stock counts per storage area (D-15), variance reasons
 * required when `diff_qty <> 0`, approval → `stock_adjustments` → ledger
 * posting (CONTRACTS.md §4.8). Delegates to `kernel/approvals` (D-08) for
 * the approve/reject lifecycle and to `kernel/stock-ledger` for the
 * resulting adjustment posting — never hand-rolls either. `SyncEngineModule`
 * supplies `SyncEmitService` (every mutation emits a sync event, collision
 * rule 6) and `SyncConflictsRepository`/`SyncEventsRepository` (C1
 * double-count dispute resolution, SYNC-PROTOCOL §5.2).
 *
 * B-11: `StockOpnameSyncProjector` self-registers with the kernel's
 * `SyncProjectorRegistry` in `onModuleInit`. Without it a count made during an
 * outage synced up and never became a `stock_opname` row — silently, because
 * the registry treats an unhandled `(entity, op)` as success.
 */
@Module({
  imports: [ApprovalsModule, StockLedgerModule, SyncEngineModule, EventsModule],
  controllers: [StockOpnameController],
  providers: [StockOpnameRepository, StockOpnameService, StockOpnameSyncProjector],
})
export class StockOpnameModule implements OnModuleInit {
  constructor(
    private readonly registry: SyncProjectorRegistry,
    private readonly projector: StockOpnameSyncProjector,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.projector);
  }
}
