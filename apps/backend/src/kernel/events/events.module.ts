import { Module } from '@nestjs/common';
import { EventBus } from './event-bus.service';

/**
 * kernel/events — in-process typed `EventBus` (BUILD-PLAN §5 Wave 2 W2-C).
 *
 * `EventBus` is the seam `StockLedgerService` (W2-A) publishes `stock.moved`
 * through, and the seam the accounting posting-rule engine (W4-03, M17) will
 * subscribe to `journal.action` through — neither module imports the other.
 * See `event-bus.service.ts` for the full contract.
 *
 * `@Global()` is deliberately NOT used here: every module that wants to
 * publish or subscribe imports `EventsModule` explicitly and injects
 * `EventBus`, keeping the dependency visible in that module's own imports
 * array rather than implicit ambient state.
 */
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
