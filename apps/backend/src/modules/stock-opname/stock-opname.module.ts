import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { EventsModule } from '../../kernel/events/events.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { StockOpnameController } from './stock-opname.controller';
import { StockOpnameRepository } from './stock-opname.repository';
import { StockOpnameService } from './stock-opname.service';

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
 */
@Module({
  imports: [ApprovalsModule, StockLedgerModule, SyncEngineModule, EventsModule],
  controllers: [StockOpnameController],
  providers: [StockOpnameRepository, StockOpnameService],
})
export class StockOpnameModule {}
