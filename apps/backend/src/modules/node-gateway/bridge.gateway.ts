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
  devices: { ipAddress: string; macAddress: string | null; source: string; vendor: string | null; model: string | null; suggestedCategory: string | null; suggestedName: string | null }[];
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

@Injectable()
@WebSocketGateway({ namespace: '/bridge', transports: ['polling', 'websocket'] })
export class BridgeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BridgeGateway.name);

  @WebSocketServer()
  server!: Server;

  /** nodeId -> connected socket id. In-process only (same scaling caveat `kernel/sync/sync.gateway.ts` already documents for its own fan-out — no Redis adapter wired yet). */
  private readonly nodeSockets = new Map<UUID, string>();
  private readonly lastKnownVersion = new Map<UUID, string>();

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
    const node = await withSystemContext(this.pool, (client) => this.nodes.findByTokenHash(client, hashDeviceToken(token)));
    if (!node || node.status === 'retired' || node.status === 'unpaired') {
      socket.disconnect(true);
      return;
    }
    (socket.data as { nodeId?: UUID }).nodeId = node.id;
    (socket.data as { locationId?: UUID }).locationId = node.location_id;
    this.nodeSockets.set(node.id, socket.id);
    this.lastKnownVersion.set(node.id, node.version ?? '');

    await withSystemContext(this.pool, (client) =>
      this.deviceRegistry.insertDeviceEvent(client, { nodeId: node.id, locationId: node.location_id, type: 'online' }),
    );
  }

  handleDisconnect(socket: Socket): void {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    if (nodeId) this.nodeSockets.delete(nodeId);
  }

  /** §7.2/§7.3 — every 30s. Updates `branch_nodes` bookkeeping and raises `version_changed`/`clock_skew` device_events exactly as CONTRACTS.md's heartbeat-ingest paragraph specifies; the staleness SWEEP (device-registry) is what actually flips `online/stale/offline`, this handler only proves liveness `last_seen_at`. */
  @SubscribeMessage('node:heartbeat')
  async onHeartbeat(@ConnectedSocket() socket: Socket, @MessageBody() body: NodeHeartbeatBody): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;

    await withSystemContext(this.pool, async (client) => {
      // §7.3 "any -> online recovery": captured here, before `recordHeartbeat` overwrites
      // `status` — the sweep (device-registry) only ever moves a row TOWARD stale/offline, so a
      // node coming back only ever transitions the instant its heartbeat arrives.
      const before = await this.nodes.findById(client, nodeId);
      const wasDown = before && before.status !== 'online';

      await this.nodes.recordHeartbeat(client, nodeId, { version: body.version, relayQueueDepth: body.relayQueueDepth });

      if (wasDown && before) {
        await this.deviceRegistry.insertDeviceEvent(client, { nodeId, locationId, type: 'online' });
        await this.syncEmit
          .emit(client, { entity: 'device_events', op: 'went_online', entityId: nodeId, locationId, actorUserId: CLOUD_ORIGIN_ACTOR, data: {} })
          .catch(() => undefined);
        this.topologyGateway.emitUpdate({ locationId, nodeId, status: 'online' });
      }

      const previousVersion = this.lastKnownVersion.get(nodeId);
      if (previousVersion !== undefined && previousVersion !== '' && previousVersion !== body.version) {
        await this.deviceRegistry.insertDeviceEvent(client, { nodeId, locationId, type: 'version_changed', detail: { from: previousVersion, to: body.version } });
      }
      this.lastKnownVersion.set(nodeId, body.version);

      if (Math.abs(body.clockOffsetMs ?? 0) > CLOCK_SKEW_THRESHOLD_MS) {
        await this.deviceRegistry.insertDeviceEvent(client, { nodeId, locationId, type: 'clock_skew', detail: { offsetMs: body.clockOffsetMs } });
      }
      if ((body.relayQueueDepth ?? 0) > QUEUE_ALERT_THRESHOLD) {
        await this.deviceRegistry.insertDeviceEvent(client, { nodeId, locationId, type: 'queue_alert', detail: { queueDepth: body.relayQueueDepth } });
      }
    });
  }

  /** §4.22 discovery ingest (D-13) — one upsert per reported device; `discovered_devices` never applies through the generic sync pipeline (no projector exists for it, and CONTRACTS' own `GET/.../discovered-devices` endpoints are plain queryable rows) — see the registry.ts schema-resolution note in the W3-10 report for why. */
  @SubscribeMessage('discovery:report')
  async onDiscoveryReport(@ConnectedSocket() socket: Socket, @MessageBody() body: DiscoveryReportBody): Promise<void> {
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

  /** `POST /api/nodes/:id/command`'s ack — recorded as a `device_events` row against the node for F12 visibility/history (W5-07 turns these into real remote actions; this skeleton — matching `apps/branch-node/src/relay.ts`'s own "no-op ack" stance — only needs to observe the acknowledgement). */
  @SubscribeMessage('command:ack')
  async onCommandAck(@ConnectedSocket() socket: Socket, @MessageBody() body: CommandAckBody): Promise<void> {
    const nodeId = (socket.data as { nodeId?: UUID }).nodeId;
    const locationId = (socket.data as { locationId?: UUID }).locationId;
    if (!nodeId || !locationId) return;
    this.logger.debug(`command ${body.commandId} on node ${nodeId}: ${body.status}${body.detail ? ` (${body.detail})` : ''}`);
  }

  /** `POST /api/nodes/:id/command {type:'log_pull'}`'s response stream — accepted and logged; a durable store for retrieved logs is W7-02/W5-07 territory (a log VIEWER surface is out of this ticket's scope), not silently dropped either way. */
  @SubscribeMessage('logs:chunk')
  onLogsChunk(@MessageBody() body: LogsChunkBody): void {
    this.logger.debug(`log chunk ${body.seq}${body.done ? ' (final)' : ''} for command ${body.commandId}: ${body.lines.length} line(s)`);
  }

  // ── cloud -> node pushes (CONTRACTS §1.12 branch_nodes pull ops) ──────

  isConnected(nodeId: UUID): boolean {
    return this.nodeSockets.has(nodeId);
  }

  sendCommand(nodeId: UUID, command: { commandId: UUID; type: string; params?: Record<string, unknown> }): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('command', command);
    return true;
  }

  sendCertRotated(nodeId: UUID, lanCert: { dnsName: string; pem: string; keyPem: string; expiresAt: string }): boolean {
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

  /** Kill switch (CONTRACTS §1.12 `branch_nodes.revoked`): the node must stop pushing and drop its credential the moment this arrives, mirroring what `revoked` means for a device. */
  sendRevoked(nodeId: UUID): boolean {
    const socketId = this.nodeSockets.get(nodeId);
    if (!socketId) return false;
    this.server.to(socketId).emit('revoked');
    this.nodeSockets.delete(nodeId);
    return true;
  }
}
