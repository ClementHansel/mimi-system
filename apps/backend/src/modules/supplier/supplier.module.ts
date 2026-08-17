import { Module } from '@nestjs/common';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';

/**
 * M06 `supplier` — owned by Wave 3, agent W3-03 (junior).
 *
 * FR-SUP-01..06: supplier master data, `supplier_items`, append-only
 * `supplier_price_history` (CONTRACTS.md §4.6). Role-locked pricing (D-20):
 * outlet roles (Supervisor Cabang, Leader/Staff Outlet) see supplier name +
 * contact but never price/termin — RLS hides COLUMNS, not rows, for those
 * roles, so this module's read paths must respect `supplier.price.read`
 * even where `supplier.read` already passed.
 *
 * Endpoints:
 * - GET /api/suppliers (full shape; outlet roles get 403)
 * - GET /api/suppliers/directory (name/contact only; outlet-visible rows)
 * - GET /api/suppliers/:id, POST /api/suppliers, PATCH, DELETE
 * - GET /api/suppliers/:id/items (pricing; outlet roles get 403)
 * - PUT /api/suppliers/:id/items/:itemId (price change → history)
 * - DELETE /api/suppliers/:id/items/:itemId
 * - GET /api/suppliers/:id/price-history (append-only)
 * - GET /api/suppliers/:id/transactions (PO history)
 */
@Module({
  // SyncEngineModule provides SyncEmitService (collision rule 6 — every
  // mutation emits a sync event). Missing here until boot-tested: the unit and
  // integration suites construct SupplierService directly, so nothing
  // exercised Nest's DI container and the app could not start.
  imports: [SyncEngineModule],
  controllers: [SupplierController],
  providers: [SupplierService],
  exports: [SupplierService],
})
export class SupplierModule {}
