import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../../kernel/approvals/approvals.module';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';

import { WasteController } from './controllers/waste.controller';
import { ReturnController } from './controllers/return.controller';
import { WasteRepository } from './waste.repository';
import { WasteService } from './waste.service';
import { ReturnRepository } from './return.repository';
import { ReturnService } from './return.service';

/**
 * M12 `waste-return` — owned by Wave 4, agent W4-02 (medior).
 *
 * FR-WST-01..04: waste records (wajib foto) and both retur directions —
 * outlet→gudang and gudang→supplier (`ReturnDirection` — CONTRACTS.md
 * §4.12). Posts `waste_out`/`return_out`/`return_in` movements exclusively
 * through `kernel/stock-ledger`; approval lifecycle through
 * `kernel/approvals`, whose `document-context.resolver.ts` already resolves
 * step-1 eligible role from EITHER the waste record's own location type or
 * the return's own `direction` column — this module supplies real document
 * ids and never re-derives that routing.
 */
@Module({
  imports: [ApprovalsModule, StockLedgerModule, SyncEngineModule],
  controllers: [WasteController, ReturnController],
  providers: [WasteRepository, WasteService, ReturnRepository, ReturnService],
})
export class WasteReturnModule {}
