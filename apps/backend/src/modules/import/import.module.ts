import { Module } from '@nestjs/common';
import { ItemModule } from '../item/item.module';
import { ProductModule } from '../product/product.module';
import { AccountingModule } from '../accounting/accounting.module';
import { HrModule } from '../hr/hr.module';
import { AssetModule } from '../asset/asset.module';
import { PayrollModule } from '../payroll/payroll.module';
import { SupplierModule } from '../supplier/supplier.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/**
 * `import` — bulk import with a schema-derived template download (owner,
 * 2026-08-24: master data is currently hand-typed one row at a time; "add
 * bulk import with template download, so all the import would follow DB so
 * no errors").
 *
 * ORIGINAL THREE ENTITIES, chosen for value and low risk:
 *   - `item_categories` — a real FK dependency of `items` (must exist first)
 *     and already defined in `database/import-schema.ts`'s CLI importer.
 *   - `items` — the highest-volume hand-typed screen (bahan baku), also
 *     already in the CLI importer.
 *   - `products` — the menu, also already in the CLI importer.
 *
 * FIVE MORE MASTER/REFERENCE ENTITIES added 2026-08-27 (owner ask —
 * `suppliers` explicitly, plus four more chosen for the same value/risk
 * profile as the original three):
 *   - `chart_of_accounts` — `AccountingModule` already exports
 *     `ChartOfAccountsService` for exactly this kind of cross-module
 *     consumption (see that module's own doc comment).
 *   - `employees` — the HR roster. `HrModule` did not previously export
 *     anything; `EmployeesService`/`ShiftsService` were added to its
 *     `exports` in this same round.
 *   - `work_shifts` — the roster's reusable shift TEMPLATES (`RosterPanel`'s
 *     "Pagi"/"Sore"/"Malam" definitions), not `shift_assignments` (the actual
 *     per-employee-per-date grid — genuinely transactional, out of scope).
 *   - `assets` — the asset register. `AssetModule` did not previously export
 *     anything; `AssetsService` was added to its `exports` in this same
 *     round. `condition`/`status` (lifecycle transitions, e.g. retiring) are
 *     deliberately not importable columns — see `import.service.ts`'s
 *     `planAsset` doc comment.
 *   - `salary_components` — the payroll component master (16 seeded system
 *     rows + custom lines). `PayrollModule` did not previously export
 *     anything; `ComponentsService` was added to its `exports` in this same
 *     round — safe to reuse here specifically because `PayrollModule`'s own
 *     header already documents that `ComponentsService` never calls
 *     `SyncEmitService` (`salary_components` is class X).
 *
 *   - `suppliers` — the supplier master (contact, terms, bank). Its
 *     `outlet_visible` flag is the D-20 switch that decides whether outlet
 *     roles see the supplier in their directory at all, so the template says
 *     so and a create defaults it to "no". Per-item PRICES are deliberately
 *     not importable here: they live in `supplier_items` with an append-only
 *     `supplier_price_history` row per change (FR-SUP-04) — a different
 *     natural key and a different sheet.
 *
 * NINTH ENTITY, added 2026-08-27 (same day, W7 CRUD/import/export follow-up,
 * owner ask verbatim: "the contract for employee need to be able to be made,
 * signed by all, and will be linked to each employee. (need crud), import
 * and export"):
 *   - `employment_contracts` — the kontrak kerja register (migration 230,
 *     plus 252's new `contract_signatures`). `HrModule` already exported
 *     `ContractsService` — sorry, gained that export in THIS round, for
 *     exactly this consumer, the same way `EmployeesService`/`ShiftsService`
 *     did two days prior. Natural key `contract_number`; `employee` resolves
 *     against `employees.employee_number`, `location` against
 *     `locations.code`. NOT importable: `status`/signatures — see
 *     `import-schema.ts`'s doc comment on this entity for why a CSV that
 *     could assert a contract was signed is a forged signature, not a bulk
 *     edit, and why every imported row lands as `draft` regardless.
 *
 * `suppliers` WAS BLOCKED for most of the round it was asked for, and the
 * reason is worth keeping. `SupplierService.create`/`update` unconditionally
 * called `SyncEmitService.emit(undefined, { entity: 'suppliers', ... })`, and
 * `suppliers` is class `X` with an EMPTY `ops` list in `@mimi/sync-protocol`'s
 * authority matrix (FR-SUP-06: supplier pricing must never reach a device).
 * `canOriginate` rejects an unknown op BEFORE the cloud-tier exemption, so the
 * call threw on every supplier write — and because this module delegates every
 * write to the real domain service (see `import.service.ts`'s header), an
 * importer would have inherited that failure on every row.
 *
 * It was never breakage from this module: the hand-typed "Add Supplier" screen
 * failed identically. It stayed invisible because every test in
 * `supplier.integration.spec.ts` constructed the service with a no-op `emit`
 * stub. The emits were the error rather than the matrix — a class-X event has
 * no consumer at all — so they were removed from `supplier.service.ts` along
 * with the dependency, which fixed the screen and unblocked this entity.
 *
 * NOT `units`: `UnitService` exposes `createUnit` but no update method, so
 * an upsert-on-natural-key import could create a unit but could never
 * correct one — the one entity in the CLI importer's list this module
 * could not honestly support without editing `unit.service.ts` (outside
 * this ticket's file ownership). NOT anything transactional (sales, stock
 * movements, journal entries, purchase orders, payments, payment
 * verifications, fiscal periods, attendance, payroll runs, leave requests,
 * maintenance jobs, audit log, surat jalan): importing those from a
 * spreadsheet bypasses the exact controls the system exists to enforce —
 * double-entry posting rules and fiscal-period locks, geofence/selfie
 * anti-fraud, statutory derivation, approval workflows, and the append-only
 * audit interceptor.
 *
 * NO NEW MIGRATION: every column this module reads or writes already exists
 * — this is a new BFF surface over existing tables, not a schema change.
 *
 * Every write is delegated to the owning module's own already-exported (or,
 * this round, newly-exported) service — `ItemModule`/`ProductModule`/
 * `AccountingModule`/`HrModule`/`AssetModule`/`PayrollModule` are all
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
  imports: [
    ItemModule,
    ProductModule,
    AccountingModule,
    HrModule,
    AssetModule,
    PayrollModule,
    SupplierModule,
  ],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
