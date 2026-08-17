import { Module } from '@nestjs/common';

import { EventsModule } from '../../kernel/events/events.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';

import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import {
  DEFAULT_LOW_STOCK_DETECTOR_OPTIONS,
  LOW_STOCK_DETECTOR_OPTIONS,
  LowStockDetectorService,
} from './low-stock/low-stock-detector.service';

/**
 * M07 `inventory` — owned by Wave 3, agent W3-04 (senior-be).
 *
 * Stock balances per storage area, movements, min-stock rules, low-stock
 * detection (FR-LOG-06/07/17..21 — CONTRACTS.md §4.7). Reads
 * `stock_balances`/`stock_movements` freely; writes ONLY through
 * `kernel/stock-ledger`'s `StockLedgerService.post(tx, movements, mode)`
 * (D-07) — never touches those tables directly.
 *
 * Imports (all Wave 2 kernels, none `@Global()` — every consuming module
 * imports them explicitly, per each module's own header comment):
 *  - `StockLedgerModule` — the D-15 area-transfer action.
 *  - `SyncEngineModule` — `SyncEmitService`, for `min_stock_rules.updated`
 *    (class M, SYNC-PROTOCOL §3.3 group 3) after every `PUT /min-stock`.
 *  - `NotificationModule` + `EventsModule` — `LowStockDetectorService`
 *    subscribes to `StockLedgerService`'s `stock.moved` event and calls
 *    `NotificationService` (template `low_stock`, already registered in the
 *    kernel's template registry) on a debounced crossing.
 */
@Module({
  controllers: [InventoryController],
  providers: [
    InventoryRepository,
    InventoryService,
    LowStockDetectorService,
    { provide: LOW_STOCK_DETECTOR_OPTIONS, useValue: DEFAULT_LOW_STOCK_DETECTOR_OPTIONS },
  ],
  imports: [StockLedgerModule, SyncEngineModule, NotificationModule, EventsModule],
})
export class InventoryModule {}
