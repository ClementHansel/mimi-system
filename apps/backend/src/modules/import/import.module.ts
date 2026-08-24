import { Module } from '@nestjs/common';
import { ItemModule } from '../item/item.module';
import { ProductModule } from '../product/product.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/**
 * `import` — bulk import with a schema-derived template download (owner,
 * 2026-08-24: master data is currently hand-typed one row at a time; "add
 * bulk import with template download, so all the import would follow DB so
 * no errors").
 *
 * THREE ENTITIES, chosen for value and low risk:
 *   - `item_categories` — a real FK dependency of `items` (must exist first)
 *     and already defined in `database/import-schema.ts`'s CLI importer.
 *   - `items` — the highest-volume hand-typed screen (bahan baku), also
 *     already in the CLI importer.
 *   - `products` — the menu, also already in the CLI importer.
 * NOT `units`: `UnitService` exposes `createUnit` but no update method, so
 * an upsert-on-natural-key import could create a unit but could never
 * correct one — the one entity in the CLI importer's list this module
 * could not honestly support without editing `unit.service.ts` (outside
 * this ticket's file ownership). NOT `suppliers` (the brief's other
 * suggestion): `suppliers` is `class: 'X'` in `@mimi/sync-protocol`'s
 * authority matrix — `ops: []`, so `SyncEmitService.emit()` throws for it
 * unconditionally (`canOriginate` has no known op to match). `SupplierService`
 * already calls `syncEmit.emit(undefined, { entity: 'suppliers', ... })` in
 * its `create`/`update`/etc — a pre-existing latent bug in that module, out
 * of this ticket's scope to fix, but it confirms `suppliers` is not a sync
 * event source this module could safely reuse either. NOT anything
 * transactional (sales, stock movements, journal entries, purchase orders):
 * importing those from a spreadsheet bypasses the ledger and the approval
 * chains entirely, which the owner's brief explicitly rules out.
 *
 * NO NEW MIGRATION: every column this module reads or writes already exists
 * (`item_categories`, `items`, `products`, plus the `units`/
 * `product_categories` lookups it resolves foreign keys against) — this is
 * a new BFF surface over existing tables, not a schema change.
 *
 * Every write is delegated to `ItemService`/`ItemCategoryService`/
 * `ProductService` (imported here via their owning modules, which already
 * export them) — see `import.service.ts`'s header comment for why. Neither
 * `ItemModule` nor `ProductModule` is edited by this module; both are
 * imported read-only, the same way any Nest module consumes another
 * module's exported providers.
 *
 * Endpoints (CONTRACTS-style, no §4 entry yet — see this agent's final
 * report for why `docs/FRONTEND-BFF-CONTRACT.md` doesn't exist in this repo):
 * - GET  /api/import/:entity/template
 * - POST /api/import/:entity/preview  (multipart, field "file")
 * - POST /api/import/:entity/commit   (multipart, field "file")
 */
@Module({
  imports: [ItemModule, ProductModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
