/**
 * Boots the REAL Nest DI graph for `SupplierModule` and for `ImportModule`
 * (which now depends on it), against the LIVE `mimi_app` connection.
 *
 * WHY THIS FILE EXISTS. `supplier.integration.spec.ts` constructs
 * `SupplierService` directly with `new`, which proves the SQL and the RLS
 * boundary and nothing about wiring. `SupplierModule`'s own header records
 * what that gap already cost once: `SyncEngineModule` was missing from its
 * imports until someone tried to boot the app, "the unit and integration
 * suites construct SupplierService directly, so nothing exercised Nest's DI
 * container and the app could not start".
 *
 * Both sides of that dependency changed on 2026-08-27 — `SyncEngineModule` was
 * REMOVED from `SupplierModule` (the emits it existed for always threw; see
 * `supplier.service.ts`'s constructor) and `SupplierModule` was ADDED to
 * `ImportModule` (bulk supplier import). Either change is exactly the kind that
 * a `new Service()` test cannot see and a boot can.
 */
import { describe, expect, it } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CommonModule } from '../../common/common.module';
import { SupplierModule } from './supplier.module';
import { SupplierService } from './supplier.service';
import { SupplierController } from './supplier.controller';
import { ImportModule } from '../import/import.module';
import { ImportService } from '../import/import.service';
import { ImportController } from '../import/import.controller';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://mimi_app:mimi_app_secret@localhost:55433/mimi';

describe('M06 supplier module wiring — live database, real Nest DI graph', () => {
  it('SupplierModule resolves with NO SyncEngineModule import', async () => {
    process.env.DATABASE_URL = DATABASE_URL;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule, SupplierModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.not.toThrow();

    // The service must be constructible with an EMPTY constructor. If someone
    // re-adds a `SyncEmitService` parameter without also re-importing
    // `SyncEngineModule`, compile() fails here rather than at boot in
    // production — and if they re-add both, the supplier writes start throwing
    // again and `import.integration.test.ts`'s `suppliers` block catches that.
    expect(app.get(SupplierService)).toBeDefined();
    expect(app.get(SupplierController)).toBeDefined();

    await app.close();
  }, 30_000);

  it('ImportModule resolves SupplierService through SupplierModule exports', async () => {
    process.env.DATABASE_URL = DATABASE_URL;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule, ImportModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.not.toThrow();

    // `ImportService` takes nine domain services. This asserts the whole
    // constructor is satisfiable — a module that forgot to `exports:` its
    // service fails right here, which is how `suppliers` was wired in.
    expect(app.get(ImportService)).toBeDefined();
    expect(app.get(ImportController)).toBeDefined();

    await app.close();
  }, 30_000);
});
