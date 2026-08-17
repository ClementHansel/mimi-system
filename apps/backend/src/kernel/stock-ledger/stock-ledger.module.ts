import { Module } from '@nestjs/common';

import { EventsModule } from '../events/events.module';
import { StockMovedEventEmitter } from './stock-ledger-events';
import { StockLedgerService } from './stock-ledger.service';

/**
 * kernel/stock-ledger — owned by Wave 2, agent W2-A (senior-be).
 *
 * The ONLY writer of `stock_balances` (D-07, CONTRACTS.md §1.3 block 020).
 * `StockLedgerService.post(client, movements, mode)` with dual `'strict'`
 * (interactive: reject a movement that would go negative) / `'fact'` (sync
 * replay: post + open a reconciliation exception on negative) modes per
 * D-17a. Uses the shared projector from `@mimi/sync-protocol` (D-16a) rather
 * than reimplementing fact→movement→balance logic here.
 *
 * Imports `EventsModule` (W2-C's real `EventBus`, landed since this ticket
 * started) so every applied movement publishes a real `stock.moved` event —
 * see `stock-ledger-events.ts` for the payload adapter.
 *
 * Pre-created empty and wired into `app.module.ts` in Wave 1 (BUILD-PLAN §6
 * rule 2) so no later agent ever edits the root module. Wave 2 (this file)
 * fills it in place — every other kernel/domain module that needs stock
 * writes imports `StockLedgerModule` and injects `StockLedgerService`.
 */
@Module({
  imports: [EventsModule],
  providers: [StockLedgerService, StockMovedEventEmitter],
  exports: [StockLedgerService],
})
export class StockLedgerModule {}
