/**
 * The `/bridge` socket.io namespace (CONTRACTS.md §4.22; AIRE pattern —
 * SYNC-PROTOCOL §4.1 "the proven AIRE bridge shape"). One OUTBOUND
 * connection per branch node, authenticated with its `nodeToken`
 * (`branch_nodes.node_token_hash`) — never an inbound port toward a branch
 * network. Distinct from `kernel/sync`'s `/sync` namespace: `/bridge`
 * carries node control-plane traffic (registration already happened over
 * HTTP; this namespace is heartbeat, discovery, commands, logs, and the
 * cloud->node pushes `cert_rotated`/`config_updated`/`revoked`), while
 * `/sync` carries the append-only event stream a node ALSO relays (a node
 * holds both connections simultaneously, per `apps/branch-node/src/relay.ts`
 * — which this gateway is the authoritative cloud-side counterpart to).
 *
 * Message names, request/response shapes, and the node-heartbeat threshold
 * rules below are CONTRACTS.md §7.2/§7.3 and `apps/branch-node/src/bridge-
 * types.ts` transcribed — that file documents this exact contract from the
 * node's side and was written by a concurrent Wave-2 agent who could not see
 * this implementation; the two are kept in lockstep deliberately.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import type { UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from '../device-registry/device-registry.repository';
import { TopologyGateway } from '../device-registry/topology.gateway';
import { BranchNodesRepository } from './branch-nodes.repository';
import { DiscoveredDevicesRepository } from './discovered-devices.repository';

const CLOCK_SKEW_THRESHOLD_MS = 120_000; // §7.2: "|clockOffsetMs| > 120000 ⇒ clock_skew event"
const QUEUE_ALERT_THRESHOLD = 200; // §7.2: "queueDepth > 200 ... ⇒ queue_alert" (the monotonic-2h growth leg is a follow-up, see report)
const CLOUD_ORIGIN_ACTOR = '00000000-0000-0000-0000-0000000000c1' as UUID;

interface NodeHeartbeatBody {
  nodeId: UUID;
  at: string;
  version: string;
  uptimeSec: number;
  relayQueueDepth: number;
  deviceCount: number;
  deviceSummaries: { deviceId: UUID; lastSeenAt: string; queueDepth: number }[];
  discoveryLastRunAt: string | null;
  db: { ok: boolean; sizeMb: number };
  system: { cpuPct: number; memPct: number; diskFreePct: number };
  clockOffsetMs: number;
}

interface DiscoveryReportBody {
  nodeId: UUID;
  scannedAt: string;
  devices: {
    ipAddress: string;
    macAddress: string | null;
    source: string;
    vendor: string | null;
    model: string | null;
    suggestedCategory: string | null;
    suggestedName: string | null;
  }[];
}

interface CommandAckBody {
  commandId: UUID;
  status: 'accepted' | 'done' | 'failed';
  detail?: string;
}

interface LogsChunkBody {
  nodeId: UUID;
  commandId: UUID;
  seq: number;
  done: boolean;
  lines: string[];
}

interface NetworkConfigAckFieldBody {
  field: string;
  applied: boolean;
  reason: string;
}

/** node -> cloud, `network_config_ack` (W3-10) — the apply-then-confirm outcome for a `config_updated`
 *  push (`sendNetworkConfig` below). */
interface NetworkConfigAckBody {
  configId: UUID;
  nodeId: UUID;
  status: 'applied' | 'reverted' | 'failed';
  fields: NetworkConfigAckFieldBody[];
  detail?: string;
}

@Injectable()
@WebSocketGateway({ namespace: '/bridge', transports: ['polling', 'websocket'] })
export class BridgeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BridgeGateway.name);

  @WebSocketServer()
  server!: Server;

  /** nodeId -> connected socket id. In-process only (same scaling caveat `kernel/sync/sync.gateway.ts` already documents for its own fan-out — no Redis adapter wired yet). */
  private readonly nodeSockets = new Map<UUID, string>();
  private readonly lastKnownVersion = new Map<UUID, string>();
  /** `commandId` -> accumulated log lines while a `log_pull`'s `logs:chunk` stream is still in flight (W3-10). */
  private readonly pendingLogChunks = new Map<UUID, string[]>();
  private static readonly MAX_PERSISTED_LOG_LINES = 200;

  constructor(
    private readonly nodes: BranchNodesRepository,
    private readonly discovered: DiscoveredDevicesRepository,
    private readonly deviceRegistry: DeviceRegistryRepository,
    private readonly syncEmit: SyncEmitService,
    private readonly topologyGateway: TopologyGateway,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (!token) {
      socket.disconnect(true);
      return;
    }
    const node = await withSystemContext(this.pool, (client) =>
      this.nodes.findByTokenHash(client, hashDeviceToken(token)),
    );
    if (!node || node.status === 'retired' || node.status === 'unpaired') {
      socket.disconnect(true);
      return;
    }
    (socket.data as { nodeId?: UUID }).nodeId = node.id;
    (socket.data as { locationId?: UUID }).locationId = node.location_id;
    this.nodeSockets.set(node.id, socket.id);
    this.lastKnownVersion.set(node.id, node.version ?? '');

    await withSystemContext(this.pool, (client) =>
      this.deviceRegistry.insertDeviceEvent(client, {
        nodeId: node.id,
        locationId: node.location_id,
        type: 'online',
      }),
    );
  }

  handleDisconnect(socket: Socket): void {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    if (nodeId) this.nodeSockets.delete(nodeId);
  }

  /** §7.2/§7.3 — every 30s. Updates `branch_nodes` bookkeeping and raises `version_changed`/`clock_skew` device_events exactly as CONTRACTS.md's heartbeat-ingest paragraph specifies; the staleness SWEEP (device-registry) is what actually flips `online/stale/offline`, this handler only proves liveness `last_seen_at`. */
  @SubscribeMessage('node:heartbeat')
  async onHeartbeat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: NodeHeartbeatBody,
  ): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;

    await withSystemContext(this.pool, async (client) => {
      // §7.3 "any -> online recovery": captured here, before `recordHeartbeat` overwrites
      // `status` — the sweep (device-registry) only ever moves a row TOWARD stale/offline, so a
      // node coming back only ever transitions the instant its heartbeat arrives.
      const before = await this.nodes.findById(client, nodeId);
      const wasDown = before && before.status !== 'online';

      await this.nodes.recordHeartbeat(client, nodeId, {
        version: body.version,
        relayQueueDepth: body.relayQueueDepth,
      });

      if (wasDown && before) {
        await this.deviceRegistry.insertDeviceEvent(client, { nodeId, locationId, type: 'online' });
        await this.syncEmit
          .emit(client, {
            entity: 'device_events',
            op: 'went_online',
            entityId: nodeId,
            locationId,
            actorUserId: CLOUD_ORIGIN_ACTOR,
            data: {},
          })
          .catch(() => undefined);
        this.topologyGateway.emitUpdate({ locationId, nodeId, status: 'online' });
      }

      const previousVersion = this.lastKnownVersion.get(nodeId);
      if (
        previousVersion !== undefined &&
        previousVersion !== '' &&
        previousVersion !== body.version
      ) {
        await this.deviceRegistry.insertDeviceEvent(client, {
          nodeId,
          locationId,
          type: 'version_changed',
          detail: { from: previousVersion, to: body.version },
        });
      }
      this.lastKnownVersion.set(nodeId, body.version);

      if (Math.abs(body.clockOffsetMs ?? 0) > CLOCK_SKEW_THRESHOLD_MS) {
        await this.deviceRegistry.insertDeviceEvent(client, {
          nodeId,
          locationId,
          type: 'clock_skew',
          detail: { offsetMs: body.clockOffsetMs },
        });
      }
      if ((body.relayQueueDepth ?? 0) > QUEUE_ALERT_THRESHOLD) {
        await this.deviceRegistry.insertDeviceEvent(client, {
          nodeId,
          locationId,
          type: 'queue_alert',
          detail: { queueDepth: body.relayQueueDepth },
        });
      }
    });
  }

  /** §4.22 discovery ingest (D-13) — one upsert per reported device; `discovered_devices` never applies through the generic sync pipeline (no projector exists for it, and CONTRACTS' own `GET/.../discovered-devices` endpoints are plain queryable rows) — see the registry.ts schema-resolution note in the W3-10 report for why. */
  @SubscribeMessage('discovery:report')
  async onDiscoveryReport(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: DiscoveryReportBody,
  ): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    if (!nodeId) return;

    await withSystemContext(this.pool, async (client) => {
      for (const item of body.devices ?? []) {
        await this.discovered.upsert(client, nodeId, {
          source: item.source,
          ipAddress: item.ipAddress,
          macAddress: item.macAddress,
          vendor: item.vendor,
          model: item.model,
          suggestedCategory: item.suggestedCategory,
          suggestedName: item.suggestedName,
        });
      }
    });
  }

  /** `POST /api/nodes/:id/command`'s ack — persisted as a `device_events` row (`command_result`,
   *  migration 254) against the node for F12 visibility/history (W3-10: `restart`/`log_pull` are now
   *  real actions, `update` an honest failure — none of them worth losing the moment this socket
   *  handler returns). */
  @SubscribeMessage('command:ack')
  async onCommandAck(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: CommandAckBody,
  ): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;
    this.logger.debug(
      `command ${body.commandId} on node ${nodeId}: ${body.status}${body.detail ? ` (${body.detail})` : ''}`,
    );
    await withSystemContext(this.pool, (client) =>
      this.deviceRegistry.insertDeviceEvent(client, {
        nodeId,
        locationId,
        type: 'command_result',
        detail: { commandId: body.commandId, status: body.status, detail: body.detail },
      }),
    );
  }

  /**
   * `POST /api/nodes/:id/command {type:'log_pull'}`'s response stream (W3-10: now a real pull, see
   * `apps/branch-node/src/relay.ts`'s `handleCommand`). Chunks are accumulated in-memory per
   * `commandId` and, once `done`, persisted as ONE `device_events` row (`command_result`) — capped
   * so a chatty pull can't bloat that table; a dedicated log-viewer surface is still F12/W7-02
   * territory, out of this ticket's scope, but the lines are no longer silently dropped either way.
   */
  @SubscribeMessage('logs:chunk')
  async onLogsChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: LogsChunkBody,
  ): Promise<void> {
    this.logger.debug(
      `log chunk ${body.seq}${body.done ? ' (final)' : ''} for command ${body.commandId}: ${body.lines.length} line(s)`,
    );
    const acc = this.pendingLogChunks.get(body.commandId) ?? [];
    acc.push(...body.lines);
    this.pendingLogChunks.set(body.commandId, acc);
    if (!body.done) return;

    this.pendingLogChunks.delete(body.commandId);
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;

    const kept = acc.slice(-BridgeGateway.MAX_PERSISTED_LOG_LINES);
    await withSystemContext(this.pool, (client) =>
      this.deviceRegistry.insertDeviceEvent(client, {
        nodeId,
        locationId,
        type: 'command_result',
        detail: {
          commandId: body.commandId,
          kind: 'log_pull',
          lineCount: acc.length,
          truncated: acc.length > kept.length,
          lines: kept,
        },
      }),
    );
  }

  /** node -> cloud, `network_config_ack` (W3-10) — the apply-then-confirm outcome for a `config_updated`
   *  push (`sendNetworkConfig` below). Persisted both onto `branch_nodes` (what `GET /api/nodes/:id`
   *  reads back as `networkConfigStatus`) and as a `device_events` row (`network_config_result`) for
   *  history. Never contains a secret — the node's own ack (`bridge-types.ts`'s `NetworkConfigAck`)
   *  carries only per-field `applied`/`reason`, never a passphrase value. */
  @SubscribeMessage('network_config_ack')
  async onNetworkConfigAck(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: NetworkConfigAckBody,
  ): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;
    this.logger.debug(`network_config_ack ${body.configId} on node ${nodeId}: ${body.status}`);

    await withSystemContext(this.pool, async (client) => {
      await this.nodes.recordNetworkConfigResult(client, nodeId, {
        configId: body.configId,
        status: body.status,
        result: { fields: body.fields, detail: body.detail },
      });
      await this.deviceRegistry.insertDeviceEvent(client, {
        nodeId,
        locationId,
        type: 'network_config_result',
        detail: {
          configId: body.configId,
          status: body.status,
          fields: body.fields,
          detail: body.detail,
        },
      });
    });
  }

  // ── cloud -> node pushes (CONTRACTS §1.12 branch_nodes pull ops) ──────

  isConnected(nodeId: UUID): boolean {
    return this.nodeSockets.has(nodeId);
  }

  sendCommand(
    nodeId: UUID,
    command: { commandId: UUID; type: string; params?: Record<string, unknown> },
  ): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('command', command);
    return true;
  }

  sendCertRotated(
    nodeId: UUID,
    lanCert: { dnsName: string; pem: string; keyPem: string; expiresAt: string },
  ): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('cert_rotated', { lanCert });
    return true;
  }

  sendConfigUpdated(nodeId: UUID, config: Record<string, unknown>): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('config_updated', { config });
    return true;
  }

  /**
   * `PUT /api/nodes/:id/network-config` (W3-10) — pushes the DECRYPTED full config (including a
   * plaintext WiFi passphrase, if one was set) over this exact node's own authenticated `/bridge`
   * socket. Callers (`NodesController.setNetworkConfig`) must check `isConnected(nodeId)` themselves
   * BEFORE encrypting/persisting anything — this method's own `false` return only covers the narrow
   * race where the node disconnected between that check and this call.
   */
  sendNetworkConfig(
    nodeId: UUID,
    payload: { configId: UUID; config: Record<string, unknown> },
  ): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('config_updated', payload);
    return true;
  }

  /** Kill switch (CONTRACTS §1.12 `branch_nodes.revoked`): the node must stop pushing and drop its credential the moment this arrives, mirroring what `revoked` means for a device. */
  sendRevoked(nodeId: UUID): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('revoked');
    this.nodeSockets.delete(nodeId);
    return true;
  }
}
