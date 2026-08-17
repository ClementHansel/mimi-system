import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { EventsModule } from '../../kernel/events/events.module';
import { StorageModule } from '../../kernel/storage/storage.module';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';

/**
 * M05 `product` — owned by Wave 3, agent W3-02 (medior).
 *
 * Menu products + recipes/BOM, driving the FR-POS-06 ingredient usage
 * estimate posted at sale time (CONTRACTS.md §4.5). A price change on a
 * product emits a `products.price_changed` master event (kernel/events).
 *
 * Imports: `SyncEngineModule` (every mutation emits a `products`/`recipes`
 * sync event), `EventsModule` (`EventBus.publish('product.price_changed')`),
 * `StorageModule` (`StorageService.getUrl()` resolves `photoUrl` from
 * `photo_attachment_id`).
 */
@Module({
  imports: [SyncEngineModule, EventsModule, StorageModule],
  controllers: [ProductController],
  providers: [ProductService, RecipeService],
  exports: [ProductService, RecipeService],
})
export class ProductModule {}
