/**
 * APPLICATION BOOT TEST — the check whose absence let a dead API ship green.
 *
 * On 2026-08-17 the backend had 74 test files and 744 passing tests, and the
 * application could not start: `SupplierModule` never imported the module
 * providing `SyncEmitService`, so Nest threw
 * `UnknownDependenciesException` on the first `createApplicationContext()`.
 *
 * Nothing caught it because **every suite constructs services directly**
 * (`new SupplierService(pool, syncEmit)`), which bypasses Nest's dependency
 * injection container entirely. Unit tests, integration tests and live-DB
 * tests all passed while the DI graph was broken.
 *
 * This test compiles the real `AppModule` — the same graph `main.ts` builds.
 * It fails the moment any module injects a provider its module does not
 * import, which is the only class of defect that can make the whole API
 * unreachable while every other test stays green.
 *
 * It deliberately does NOT assert on routes or behaviour. Its single job is:
 * *does the application wire up at all?* Keep it that way — a boot test that
 * grows assertions becomes a slow test people skip.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { describe, it, expect, afterAll } from 'vitest';
import { AppModule } from '../src/app.module';

const hasDb = Boolean(process.env.DATABASE_URL);

let app: INestApplication | undefined;

afterAll(async () => {
  await app?.close();
});

describe.skipIf(!hasDb)('application boot (real AppModule, real DI graph)', () => {
  it('compiles and initialises every module without an unresolved provider', async () => {
    // `compile()` resolves the whole graph — this is the step that threw
    // `UnknownDependenciesException` while 744 other tests passed.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // `init()` additionally runs every OnModuleInit / OnApplicationBootstrap
    // hook, mirroring what main.ts does. Several modules self-register into
    // kernel registries in those hooks (sync projectors, the staleness sweep),
    // so a graph that compiles but fails to initialise is still a dead API.
    app = moduleRef.createNestApplication();
    await app.init();

    expect(app).toBeDefined();
  }, 120_000);
});
