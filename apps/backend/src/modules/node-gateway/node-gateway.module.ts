import { Module } from '@nestjs/common';

/**
 * M22 `node-gateway` — owned by Wave 3, agent W3-10 (senior-integrator).
 *
 * D-12/D-13: branch-node socket.io gateway (one OUTBOUND connection per
 * node, never inbound), pairing tokens, LAN discovery ingest, node health,
 * remote command channel (CONTRACTS.md §4.22). Talks to `apps/branch-node`
 * (W2-F/W5-07) over the `/bridge` socket.io namespace — never opens a port
 * toward a branch network. The `/sync` namespace a node ALSO uses to relay
 * its devices' events is `kernel/sync`'s (M23), not this module's — see
 * that gateway's own header comment for the multi-origin authorization fix
 * this ticket carried (BUILD-PLAN §1 carried item 1).
 *
 * Imports `DeviceRegistryModule` (same owner, W3-10): reuses its
 * `PairingTokensService` (one `pairing_tokens` table, `target_type`
 * discriminator, CONTRACTS §7.1), `DeviceRegistryRepository` (discovery
 * confirmation creates a `devices` row; node heartbeat/version/clock-skew
 * bookkeeping shares the `device_events` table), and `TopologyGateway` (a
 * node's own online/offline/stale transitions broadcast on the same F12
 * channel a device's do).
 */
import { SyncEngineModule } from '../../kernel/sync/sync.module';
import { DeviceRegistryModule } from '../device-registry/device-registry.module';
import { BranchNodesRepository } from './branch-nodes.repository';
import { DiscoveredDevicesRepository } from './discovered-devices.repository';
import { BridgeGateway } from './bridge.gateway';
import { NodesController } from './nodes.controller';
import { OutletNodeSettingRepository } from './outlet-node-setting.repository';
import { OutletNodeSettingController } from './outlet-node-setting.controller';

@Module({
  imports: [SyncEngineModule, DeviceRegistryModule],
  controllers: [NodesController, OutletNodeSettingController],
  providers: [
    BranchNodesRepository,
    DiscoveredDevicesRepository,
    BridgeGateway,
    OutletNodeSettingRepository,
  ],
  exports: [BranchNodesRepository, BridgeGateway, OutletNodeSettingRepository],
})
export class NodeGatewayModule {}
