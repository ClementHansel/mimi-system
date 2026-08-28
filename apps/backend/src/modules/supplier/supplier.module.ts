import { Module } from '@nestjs/common';
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
  // NO SyncEngineModule (2026-08-27). It used to be imported so
  // `SupplierService` could inject `SyncEmitService` — "collision rule 6, every
  // mutation emits a sync event". That rule does not apply to this module:
  // `suppliers` and `supplier_items` are class `X` in the authority matrix,
  // never on the wire in either direction (FR-SUP-06), so `emit` THREW on every
  // supplier write and the whole surface failed. See `supplier.service.ts`'s
  // constructor comment. With the emits gone the dependency is gone too.
  controllers: [SupplierController],
  providers: [SupplierService],
  exports: [SupplierService],
})
export class SupplierModule {}
