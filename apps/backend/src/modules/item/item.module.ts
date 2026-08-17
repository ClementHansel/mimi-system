import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { ItemController } from './item.controller';
import { UnitController } from './unit.controller';
import { ItemService } from './item.service';
import { ItemCategoryService } from './item-category.service';
import { UnitService } from './unit.service';

/**
 * M04 `item` — owned by Wave 3, agent W3-02 (medior).
 *
 * Stockable items, categories, units, unit conversions (CONTRACTS.md §4.4).
 * `avgCost`/`lastPurchaseCost` fields are role-filtered by `supplier.price.read`
 * (FR-SUP-06 / D-20) — column-level, not row-level.
 *
 * `SyncEngineModule` for `SyncEmitService` — every mutation emits an
 * `items`/`item_categories`/`units`/`unit_conversions` sync event.
 */
@Module({
  imports: [SyncEngineModule],
  controllers: [ItemController, UnitController],
  providers: [ItemService, ItemCategoryService, UnitService],
  exports: [ItemService, ItemCategoryService, UnitService],
})
export class ItemModule {}
