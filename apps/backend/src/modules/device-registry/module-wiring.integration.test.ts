/**
 * Boots the REAL Nest DI graph for `DeviceRegistryModule` + `NodeGatewayModule`
 * (plus their actual dependencies: `kernel/sync`'s `SyncEngineModule`,
 * `kernel/notification`'s `NotificationModule`, and the global
 * `DatabaseModule`/`ConfigModule` every module needs) against the LIVE
 * `mimi_app` connection — the same one `DATABASE_URL` points production at.
 * A unit-level `new Service(...)` construction (this suite's other files)
 * proves the LOGIC is correct; this test proves the two modules' provider
 * graphs actually RESOLVE — no missing export, no circular import, no
 * unhandled `OnApplicationBootstrap` throw (`StalenessSweepService`'s sweep
 * fires for real here, against the real DB, exactly as it would in
 * production).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CommonModule } from '../../common/common.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { DeviceRegistryModule } from './device-registry.module';
import { StalenessSweepService } from './staleness-sweep.service';
import { NodeGatewayModule } from '../node-gateway/node-gateway.module';
import { NodesController } from '../node-gateway/nodes.controller';
import { DevicesController } from './devices.controller';
import { TopologyController } from './topology.controller';

const DB_ENV = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgres://mimi_app:mimi_app_secret@localhost:55433/mimi',
};

describe('M21/M22 module wiring — live database, real Nest DI graph', () => {
  afterAll(() => {
    // Nothing to close explicitly per-test; each `it` below tears down its own testing module.
  });

  it('DeviceRegistryModule + NodeGatewayModule compile and initialize without a missing provider, circular import, or bootstrap-hook throw', async () => {
    process.env.DATABASE_URL = DB_ENV.DATABASE_URL;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        CommonModule,
        SyncEngineModule,
        NotificationModule,
        DeviceRegistryModule,
        NodeGatewayModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.not.toThrow();

    // Every controller/service this ticket built is actually resolvable from the graph — not just
    // "the module decorator didn't throw," but each concrete class this report claims exists.
    expect(app.get(DevicesController)).toBeDefined();
    expect(app.get(TopologyController)).toBeDefined();
    expect(app.get(NodesController)).toBeDefined();
    expect(app.get(StalenessSweepService)).toBeDefined();

    await app.close();
  }, 30_000);
});
