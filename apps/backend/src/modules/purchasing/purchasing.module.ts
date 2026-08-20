import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { EventsModule } from '../../kernel/events/events.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { AccountingModule } from '../accounting/accounting.module';

import { PurchaseRequestController } from './controllers/purchase-request.controller';
import { PurchaseOrderController } from './controllers/purchase-order.controller';
import { PettyCashController } from './controllers/petty-cash.controller';

import { PurchaseRequestRepository } from './purchase-request.repository';
import { PurchaseRequestService } from './purchase-request.service';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderService } from './purchase-order.service';
import { PettyCashRepository } from './petty-cash.repository';
import { PettyCashService } from './petty-cash.service';

/**
 * M11 `purchasing` — owned by Wave 4, agent W4-02 (medior).
 *
 * FR-PO-01..04, FR-PUR-01..05: purchase requests → purchase orders → goods
 * receipt → moving-average cost update on `items`, plus petty cash
 * (CONTRACTS.md §4.11). PR/PO approval chains delegate to `kernel/approvals`;
 * receipt/petty-cash-verify stock posting delegates to `kernel/stock-ledger`;
 * the `payment_verifications` row each creates delegates to
 * `AccountingModule`'s exported `PaymentVerificationsService` (its
 * `createSystemVerification` escalation path — the receiving/verifying actor
 * here is routinely a non-central role, KGD/LDR, per RBAC §3) rather than a
 * raw INSERT this module has no RLS grant to perform directly. Read-only
 * cross-directory import (their file, never written here) — the same
 * pattern `modules/delivery` uses for `modules/replenishment`.
 */
@Module({
  imports: [ApprovalsModule, StockLedgerModule, SyncEngineModule, AccountingModule, EventsModule],
  controllers: [PurchaseRequestController, PurchaseOrderController, PettyCashController],
  providers: [
    PurchaseRequestRepository,
    PurchaseRequestService,
    PurchaseOrderRepository,
    PurchaseOrderService,
    PettyCashRepository,
    PettyCashService,
  ],
})
export class PurchasingModule {}
