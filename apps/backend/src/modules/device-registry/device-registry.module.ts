import { Module } from '@nestjs/common';

/**
 * M21 `device-registry` — owned by Wave 3, agent W3-10 (senior-integrator).
 *
 * D-13: devices, pairing, heartbeat ingest, topology tree
 * (Pusat→Kota→Outlet→Node→Device), stale sweep, online/offline transition
 * alerts (CONTRACTS.md §4.21, §7). Device-token endpoints (register,
 * heartbeat, sync push/pull) authenticate with a DEVICE JWT, not a user
 * permission key (CONTRACTS.md §3 footnote) — `DeviceTokenGuard` is applied
 * per-route via `@UseGuards()` (see that file's header for why this is not
 * a global `APP_GUARD`).
 *
 * Exports `DeviceRegistryRepository` + `PairingTokensService` +
 * `TopologyGateway` for `NodeGatewayModule` to reuse (one `pairing_tokens`
 * table serves both device and node pairing, CONTRACTS §7.1; a node's
 * bridge heartbeat/discovery/command handling needs the same device
 * registry rows and the same F12 broadcast channel a device's heartbeat
 * uses) — both modules are this agent's, so this is an ordinary same-owner
 * cross-module import, not a collision-rule boundary crossing.
 */
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { NotificationModule } from '../../kernel/notification/notification.module';
import { DeviceRegistryRepository } from './device-registry.repository';
import { PairingTokensService } from './pairing-tokens.service';
import { DeviceTokenGuard } from './device-token.guard';
import { TopologyService } from './topology.service';
import { TopologyGateway } from './topology.gateway';
import { StalenessSweepService } from './staleness-sweep.service';
import { DevicesController } from './devices.controller';
import { TopologyController } from './topology.controller';

@Module({
  imports: [SyncEngineModule, NotificationModule],
  controllers: [DevicesController, TopologyController],
  providers: [
    DeviceRegistryRepository,
    PairingTokensService,
    DeviceTokenGuard,
    TopologyService,
    TopologyGateway,
    StalenessSweepService,
  ],
  exports: [DeviceRegistryRepository, PairingTokensService, TopologyGateway, TopologyService],
})
export class DeviceRegistryModule {}
