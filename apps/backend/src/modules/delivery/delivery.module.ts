import { Module, OnModuleInit } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { StockLedgerModule } from '../../kernel/stock-ledger/stock-ledger.module';
import { EventsModule } from '../../kernel/events/events.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { ReplenishmentRepository } from '../replenishment/replenishment.repository';
import { ReplenishmentAdvancementService as ReplenishmentAdvancementServiceImpl } from '../replenishment/replenishment-advancement.service';

import { SuratJalanController } from './controllers/surat-jalan.controller';
import { DropController } from './controllers/drop.controller';
import { DeliveryMiscController } from './controllers/delivery-misc.controller';

import { SuratJalanService } from './services/surat-jalan.service';
import { DropService } from './services/drop.service';
import { DriverVehicleService } from './services/driver-vehicle.service';
import { RecapService } from './services/recap.service';
import { GoodsReceiptService } from './services/goods-receipt.service';
import { ColdChainService } from './services/cold-chain.service';
import { DeliverySyncProjector } from './services/delivery-sync-projector.service';
import { REPLENISHMENT_FULFILLMENT_PORT } from './ports/replenishment-fulfillment.port';

/**
 * M10 `delivery` — owned by Wave 3, agent W3-07 (senior-be). Largest Wave 3
 * module.
 *
 * D-14 Surat Jalan: multi-drop routes, driver/vehicle, frozen/dry split
 * (FR-LOG-02 — one SJ never mixes shipment types), per-drop departure/
 * arrival timestamps, cold-chain temperature + seal logging, receiving
 * signature + wajib-foto, discrepancy capture (FR-LOG-01..05, 08, 14..16 —
 * CONTRACTS.md §4.10). `ScopeService`'s driver-scope branch
 * (`common/scope/scope.service.ts`) already computes "outlets on this
 * driver's active SJ" from this module's tables (`surat_jalan`, `sj_drops`)
 * — keep those table/column names in sync if this module's schema evolves.
 *
 * `ReplenishmentRepository` AND `ReplenishmentAdvancementService` are
 * imported directly from `modules/replenishment/` (plain classes; the latter
 * depends only on the former + `SyncEmitService`) rather than via
 * `ReplenishmentModule` (still a stub — BUILD-PLAN §6 rule 1 forbids editing
 * it): `ports/replenishment-fulfillment.port.ts` is the interface this
 * module owns and depends on (`REPLENISHMENT_FULFILLMENT_PORT`);
 * `ReplenishmentAdvancementService` is W3-06's real implementation of it,
 * built against that exact contract in parallel. This is a read-only
 * cross-directory import (their file, never written here), expected to
 * collapse to a normal `ReplenishmentModule` import + export once W3-06
 * wires that module's own file.
 *
 * `DeliverySyncProjector` (`services/delivery-sync-projector.service.ts`)
 * self-registers with `kernel/sync`'s `SyncProjectorRegistry` in
 * `onModuleInit` below — the ONLY way an offline driver/outlet fact
 * (`sj_drops.received`, etc.) becomes a real domain row + stock posting
 * instead of a durably-logged, never-materialized `sync_events` entry. See
 * that file's header for the full design and `sync-projector.types.ts` for
 * why kernel/sync never imports this module directly.
 */
@Module({
  imports: [SyncEngineModule, StockLedgerModule, EventsModule, NotificationModule],
  controllers: [SuratJalanController, DropController, DeliveryMiscController],
  providers: [
    SuratJalanService,
    DropService,
    DriverVehicleService,
    RecapService,
    GoodsReceiptService,
    ColdChainService,
    DeliverySyncProjector,
    ReplenishmentRepository,
    { provide: REPLENISHMENT_FULFILLMENT_PORT, useClass: ReplenishmentAdvancementServiceImpl },
  ],
})
export class DeliveryModule implements OnModuleInit {
  constructor(
    private readonly registry: SyncProjectorRegistry,
    private readonly projector: DeliverySyncProjector,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.projector);
  }
}
