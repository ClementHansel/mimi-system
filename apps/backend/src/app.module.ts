import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RlsContextGuard } from './common/guards/rls-context.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RlsCleanupInterceptor } from './common/interceptors/rls-cleanup.interceptor';

// ── Kernel (Wave 2) — pre-created empty stubs, wired now so no Wave 2 agent
// ever edits this file (BUILD-PLAN §6 rule 2). Each fills its own file only.
import { StockLedgerModule } from './kernel/stock-ledger/stock-ledger.module';
import { ApprovalsModule } from './kernel/approvals/approvals.module';
import { AuditModule } from './kernel/audit/audit.module';
import { NotificationModule } from './kernel/notification/notification.module';
import { StorageModule } from './kernel/storage/storage.module';
import { EventsModule } from './kernel/events/events.module';
import { SyncEngineModule } from './kernel/sync/sync.module';

// ── Domain modules M01–M23 (Wave 3/4) — pre-created empty stubs, wired now
// for the same reason. §4.2 of BUILD-PLAN lists the owning agent per module;
// each stub file's header comment repeats it.
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { LocationModule } from './modules/location/location.module';
import { ItemModule } from './modules/item/item.module';
import { ProductModule } from './modules/product/product.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { StockOpnameModule } from './modules/stock-opname/stock-opname.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { WasteReturnModule } from './modules/waste-return/waste-return.module';
import { PosModule } from './modules/pos/pos.module';
import { HrModule } from './modules/hr/hr.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { AssetModule } from './modules/asset/asset.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ChatModule } from './modules/chat/chat.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReportModule } from './modules/report/report.module';
import { SettingsModule } from './modules/settings/settings.module';
import { DeviceRegistryModule } from './modules/device-registry/device-registry.module';
import { NodeGatewayModule } from './modules/node-gateway/node-gateway.module';
import { SyncModule } from './modules/sync/sync.module';
// `import` (BFF bulk-import, owner 2026-08-24) — added after Gate G1, not a
// pre-created Wave 2-4 stub. This file's own header comment calls itself
// "frozen" for exactly the modules already listed above; a genuinely new
// module still has to be wired somewhere for Nest to route to it, and this
// is the one place that happens for every other module too. Flagged here
// rather than silently matching the letter of "no agent edits this file"
// while missing its actual point (every module IS registered here).
import { ImportModule } from './modules/import/import.module';
// `document` + `voucher` (owner request 2026-08-27) — the document designers
// (invoice / receipt / voucher / Surat Jalan layouts + the resolvers that fill
// them) and printed discount coupons. Added after Gate G1 for the same reason
// `ImportModule` above was, and recorded here rather than left to look like an
// oversight: this file's header freezes it against the Wave 2-4 stubs it
// already lists, and a genuinely new module still has to be registered
// somewhere for Nest to route to it — this is the one place that happens for
// every other module too. Following the precedent, not quietly breaking the
// rule.
import { DocumentModule } from './modules/document/document.module';
import { VoucherModule } from './modules/voucher/voucher.module';

/**
 * Root module — frozen after Gate G1 (BUILD-PLAN §6 rule 2). Every module
 * Waves 2–4 will ever build is ALREADY imported here as an empty stub; no
 * agent past Wave 1 edits this file. A Wave 2/3/4 agent's job is to put real
 * providers/controllers INSIDE their own already-imported module file —
 * see e.g. `kernel/audit/audit.module.ts`'s header comment for how a module
 * activates a cross-cutting concern (like the real `@Audited()` interceptor)
 * without ever touching this file.
 *
 * Guard order matters and is deliberate: `JwtAuthGuard` populates
 * `request.user` → `RlsContextGuard` uses it to open the per-request RLS
 * transaction (and needs `ScopeService`, from `CommonModule`) →
 * `PermissionsGuard` checks `@RequirePermission()` against that same user.
 * `RlsCleanupInterceptor` is `RlsContextGuard`'s mandatory other half — see
 * that file for why a guard alone can't release the connection it opens.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,

    // Kernel (Wave 2)
    StockLedgerModule,
    ApprovalsModule,
    AuditModule,
    NotificationModule,
    StorageModule,
    EventsModule,
    SyncEngineModule,

    // Domain modules M01–M23 (Wave 3/4)
    AuthModule,
    UsersModule,
    LocationModule,
    ItemModule,
    ProductModule,
    SupplierModule,
    InventoryModule,
    StockOpnameModule,
    ReplenishmentModule,
    DeliveryModule,
    PurchasingModule,
    WasteReturnModule,
    PosModule,
    HrModule,
    PayrollModule,
    AssetModule,
    AccountingModule,
    ChatModule,
    DashboardModule,
    ReportModule,
    SettingsModule,
    DeviceRegistryModule,
    NodeGatewayModule,
    SyncModule,
    ImportModule,
    DocumentModule,
    VoucherModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ORDER IS LOAD-BEARING. Nest runs APP_GUARDs in registration order.
    //
    // `PermissionsGuard` MUST run before `RlsContextGuard`, and this is not a
    // preference — the other order leaks a database connection on every HTTP
    // 403, permanently, until the pool is empty and the whole API returns 500.
    //
    // Why: `RlsContextGuard` checks a connection out of the pool and opens a
    // transaction on it. `RlsCleanupInterceptor` is what rolls that back and
    // releases it — and **Nest does not run interceptors when a guard
    // rejects**. So with `RlsContextGuard` first, a denial from
    // `PermissionsGuard` left the connection checked out, mid-transaction,
    // with nothing on any code path able to reclaim it.
    //
    // MEASURED on the deployed box 2026-08-29, which is how this was found:
    // 20 of 20 pool connections sat `idle in transaction`, every one with the
    // same last statement — `set_config('app.location_ids', $1, true)`, the
    // final line of `RlsContextGuard`. Login returned 500 "timeout exceeded
    // when trying to connect"; the API was entirely down while the login PAGE
    // still served 200, so the deploy's own health check saw nothing wrong.
    // Confirmed by experiment after a restart: 0 leaked, then five 403s, then
    // exactly 5 leaked. One per denial.
    //
    // It needs no privileged traffic to trigger. A user opening a page their
    // role cannot see is enough, twenty times.
    //
    // `PermissionsGuard` is safe to run first: it depends only on `Reflector`
    // and `request.user`, is synchronous, and never touches the database — so
    // it needs `JwtAuthGuard` ahead of it and nothing else. Running it earlier
    // also means an unauthorised request never opens a transaction at all.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: RlsContextGuard },
    { provide: APP_INTERCEPTOR, useClass: RlsCleanupInterceptor },
  ],
})
export class AppModule {}
