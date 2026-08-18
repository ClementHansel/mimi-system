import { Module, OnModuleInit } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { EventsModule } from '../../kernel/events/events.module';
import { AccountingModule } from '../accounting/accounting.module';
import { PosController } from './pos.controller';
import { PosCatalogService } from './services/pos-catalog.service';
import { PosShiftService } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { PosVoidRefundService } from './services/pos-void-refund.service';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import { PosCashVarianceService } from './services/pos-cash-variance.service';
import { PosDailyStockService } from './services/pos-daily-stock.service';
import { PosSyncProjector } from './services/pos-sync-projector.service';

/**
 * M13 `pos` — owned by Wave 3, agent W3-08 (senior-be).
 *
 * FR-POS-01..07: shift open/close, sale + payment (cash/QRIS/transfer),
 * void/refund, GoFood/ShopeeFood online orders (CONTRACTS.md §4.13).
 *
 * **This REST surface is the ONLINE/apply/test path.** The offline-first
 * tablet UI (F02, W4-06) enqueues sync events instead (`pos_shifts.opened/
 * closed`, `sales.completed`, `void_refunds.*`, `online_orders.recorded`)
 * through the W2-E device outbox, which reach the cloud via
 * `kernel/sync`'s `/sync/v1/push` — a SEPARATE ingest pipeline
 * (`SyncIngestService`) from this module's REST controller.
 *
 * **The domain-projection gap is closed.** W2-D built the hook
 * (`kernel/sync/sync-projector.types.ts` — `SyncProjector`,
 * `SyncProjectorRegistry`) this module's report flagged as missing: a
 * device that pushes `sales.completed`/`pos_shifts.opened/closed`/
 * `void_refunds.*`/`online_orders.*` while genuinely offline now gets a
 * real `sales`/`sale_lines`/`sale_payments`/`pos_shifts`/`void_refunds`/
 * `online_orders` write AND a `StockLedgerService.post(..., 'fact')` call,
 * from `PosSyncProjector` (`services/pos-sync-projector.service.ts`),
 * self-registered below in `onModuleInit`. This module's own REST endpoints
 * remain the ONLINE/interactive path (both paths share the same recipe-
 * explosion/payment-status-ladder logic where practical — see that file's
 * header for exactly what is and isn't shared).
 */
@Module({
  imports: [
    ApprovalsModule,
    StockLedgerModule,
    SyncEngineModule,
    NotificationModule,
    EventsModule,
    AccountingModule,
  ],
  controllers: [PosController],
  providers: [
    PosCatalogService,
    PosShiftService,
    PosSaleService,
    PosVoidRefundService,
    PosOnlineOrderService,
    PosCashVarianceService,
    PosDailyStockService,
    PosSyncProjector,
  ],
})
export class PosModule implements OnModuleInit {
  constructor(
    private readonly registry: SyncProjectorRegistry,
    private readonly projector: PosSyncProjector,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.projector);
  }
}
