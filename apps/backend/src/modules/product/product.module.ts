import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { EventsModule } from '../../kernel/events/events.module';
import { StorageModule } from '../../kernel/storage/storage.module';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { RecipeService } from './recipe.service';
import { ProductCategoryService } from './product-category.service';
import { PackageService } from './package.service';

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
 * `photo_attachment_id`, and `getThumbnailBytes()` serves the till's
 * offline-cacheable `photoPath`).
 *
 * `ProductCategoryService` (migration 247) owns the POS menu categories that
 * used to be free text on `products.category`; `PackageService` (migration 248)
 * owns bundle membership — the two master-data surfaces the back office needs
 * in order to set up a menu without a database session.
 */
@Module({
  imports: [SyncEngineModule, EventsModule, StorageModule],
  controllers: [ProductController],
  providers: [ProductService, RecipeService, ProductCategoryService, PackageService],
  exports: [ProductService, RecipeService, ProductCategoryService, PackageService],
})
export class ProductModule {}
