/**
 * The `/sync` socket.io namespace (SYNC-PROTOCOL §4.1/§4.2/§4.3/§4.5/§4.6).
 * Message bodies are IDENTICAL to the HTTP fallback
 * (`sync-http.controller.ts`) — both delegate to the same
 * `SyncIngestService`/`SyncPullService` so there is exactly one engine
 * behind two transports, per §4.1.
 *
 * LIVE DELIVERY (this V1's scope note): once a subscriber is caught up
 * (`sync:pull` returns `has_more: false`), newly-applied events matching its
 * scope are pushed proactively via `sync:deliver`, per §4.5 "Live mode."
 * This implementation fans out in-process (a `Map` of connected sockets) —
 * correct for a single backend instance, but does NOT use a socket.io Redis
 * adapter, so it will miss subscribers connected to a DIFFERENT instance
 * once the backend scales horizontally. `ioredis` is already a dependency
 * for other purposes; wiring `@socket.io/redis-adapter` is a follow-up
 * flagged in the W2-D report, not done here (no new dependency without
 * going through W1-A per BUILD-PLAN §6 rule 2).
 *
 * `sync:checksum` (R2) is this engine's own named extension of §4.6's
 * "devices emit `sync.balance_checksum {area_hashes}` telemetry" — the
 * protocol text names the payload but not a wire message; this gateway
 * picks `sync:checksum` as that message so W2-E/W2-F have something concrete
 * to target. Flagged as an ambiguity resolution in the W2-D report.
 *
 * MULTI-ORIGIN RELAY (BUILD-PLAN §1 carried item, closed by W3-10
 * `node-gateway`): a branch node connects to THIS namespace exactly like a
 * device does (SYNC-PROTOCOL §1.2 — "a branch node plays both roles
 * simultaneously... the message set is identical in both pairings"), but
 * authenticates with its own `nodeToken` (`branch_nodes.node_token_hash`,
 * minted at `POST /api/nodes/register`) rather than a device token, and its
 * push batches legitimately span EVERY device it relays (§4.3: "a node
 * relays all its devices"). `handleConnection` below now tries a device
 * lookup first, then a node lookup, and remembers which on the socket;
 * `onPush` branches accordingly: a device connection still authorizes only
 * its own origin (unchanged, connection identity == event origin for a
 * device), while a node connection authorizes EACH event independently by
 * its own `originDeviceId`, resolved against the `devices` registry
 * (`RegistryRepository.findDeviceLocationForNode` — confirms the device is
 * actually registered to THIS node before trusting its claimed
 * `locationId`), never by trusting the node's own location for someone
 * else's device. `SyncIngestService.ingestBatch` itself needed no change —
 * it already groups by origin and calls a per-origin `resolveLocation`; the
 * single-origin restriction lived entirely in this gateway's (and the HTTP
 * fallback's) connection-level shortcut.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import type { SyncHelloRequest, SyncScope } from '@mimi/sync-protocol';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { hashDeviceToken } from './device-auth.guard';
import { RegistryRepository } from './registry.repository';
import { SyncEventsRepository } from './sync-events.repository';
import { SyncIngestService } from './sync-ingest.service';
import { SyncPullService } from './sync-pull.service';
import { ReconciliationService } from './reconciliation.service';
import { MAX_PULL_LIMIT } from './constants';
import { withSystemContext } from './system-rls-context';
import { decodeWireBatch, encodePullResult, type WireSyncPushBatch } from './wire-codec';

interface ConnectedSubscriber {
  deviceId: string;
  locationId: string;
  scope: SyncScope;
  cursor: number;
  tier: 'device' | 'node';
}

@Injectable()
@WebSocketGateway({ namespace: '/sync', transports: ['polling', 'websocket'] })
export class SyncGateway {
  @WebSocketServer()
  server!: Server;

  private readonly subscribers = new Map<string, ConnectedSubscriber>();

  constructor(
    private readonly registry: RegistryRepository,
    private readonly events: SyncEventsRepository,
    private readonly ingest: SyncIngestService,
    private readonly pull: SyncPullService,
    private readonly reconciliation: ReconciliationService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (!token) {
      socket.emit('sync:hello:ack', { ok: false, error: 'missing device credential' });
      socket.disconnect(true);
      return;
    }
    const tokenHash = hashDeviceToken(token);

    const device = await this.registry.findDeviceByTokenHash(tokenHash);
    if (device) {
      if (device.status === 'retired' || device.status === 'unpaired') {
        socket.emit('sync:hello:ack', { ok: false, error: 'unknown or inactive device credential' });
        socket.disconnect(true);
        return;
      }
      (socket.data as { deviceId?: string; locationId?: string; tier?: 'device' | 'node' }).deviceId = device.id;
      (socket.data as { locationId?: string }).locationId = device.location_id;
      (socket.data as { tier?: 'device' | 'node' }).tier = 'device';
      return;
    }

    // Not a device token — try a node token (SYNC-PROTOCOL §1.2: a node is also a legal `/sync`
    // subscriber, distinct from its `/bridge` control-plane connection, M22's `node-gateway`).
    const node = await this.registry.findNodeByTokenHash(tokenHash);
    if (!node || node.status === 'retired' || node.status === 'unpaired') {
      socket.emit('sync:hello:ack', { ok: false, error: 'unknown or inactive device credential' });
      socket.disconnect(true);
      return;
    }
    (socket.data as { deviceId?: string; locationId?: string; tier?: 'device' | 'node' }).deviceId = node.id;
    (socket.data as { locationId?: string }).locationId = node.locationId;
    (socket.data as { tier?: 'device' | 'node' }).tier = 'node';
  }

  handleDisconnect(socket: Socket): void {
    this.subscribers.delete(socket.id);
  }

  @SubscribeMessage('sync:hello')
  async onHello(@ConnectedSocket() socket: Socket, @MessageBody() body: SyncHelloRequest) {
    const deviceId = (socket.data as { deviceId?: string }).deviceId;
    const locationId = (socket.data as { locationId?: string }).locationId;
    const tier = (socket.data as { tier?: 'device' | 'node' }).tier ?? 'device';
    if (!deviceId || !locationId) return { ok: false, error: 'not authenticated' };

    const ack = await this.pull.hello(
      {
        subscriberId: deviceId,
        subscriberTier: tier,
        locationIds: [locationId],
        projectionRole: tier === 'node' ? 'node' : 'pos_device',
      },
      body.pullCursor ?? 0,
      body.outboxDepth ?? 0,
    );

    this.subscribers.set(socket.id, {
      deviceId,
      locationId,
      scope: ack.scope,
      cursor: ack.resumeCursor,
      tier,
    });

    socket.emit('sync:hello:ack', ack);
    return ack;
  }

  @SubscribeMessage('sync:push')
  async onPush(@ConnectedSocket() socket: Socket, @MessageBody() wireBody: WireSyncPushBatch) {
    const deviceId = (socket.data as { deviceId?: string }).deviceId;
    const locationId = (socket.data as { locationId?: string }).locationId;
    const tier = (socket.data as { tier?: 'device' | 'node' }).tier ?? 'device';
    if (!deviceId || !locationId) return { batchId: wireBody.batchId, acceptedThrough: {}, confirmedThrough: {}, rejected: [] };

    const body = decodeWireBatch(wireBody); // client_seq: wire decimal string -> internal bigint (wire-codec.ts)

    if (tier === 'device') {
      // Unchanged: a device connection's identity IS the event origin — anything else is rejected
      // outright, exactly as before the multi-origin fix (single-origin batches were never the bug).
      const foreign = body.events.find((e) => e.originDeviceId !== deviceId);
      if (foreign) {
        const ack = {
          batchId: body.batchId,
          acceptedThrough: {},
          confirmedThrough: {},
          rejected: body.events.map((e) => ({ eventId: e.eventId, code: 'malformed', detail: 'foreign origin_device_id in a device-direct batch' })),
        };
        socket.emit('sync:push:ack', ack);
        return ack;
      }
      const ack = await this.ingest.ingestBatch(body, async (originDeviceId) => (originDeviceId === deviceId ? locationId : undefined));
      socket.emit('sync:push:ack', ack);
      this.fanOutNewEvents(socket.id);
      return ack;
    }

    // Node connection: multi-origin by definition (§4.3 — "a node relays all its devices"). The
    // CONNECTION is authenticated as the node; each EVENT is authorized independently by its own
    // `originDeviceId`, resolved against the `devices` registry and confirmed to actually belong to
    // THIS node — never by trusting the node's own `locationId` for a device it doesn't relay for.
    const nodeId = deviceId;
    const ack = await this.ingest.ingestBatch(body, (originDeviceId) => this.registry.findDeviceLocationForNode(originDeviceId, nodeId));
    socket.emit('sync:push:ack', ack);
    this.fanOutNewEvents(socket.id);
    return ack;
  }

  @SubscribeMessage('sync:pull')
  async onPull(@ConnectedSocket() socket: Socket, @MessageBody() body: { cursor: number; limit?: number }) {
    const sub = this.subscribers.get(socket.id);
    if (!sub) return { events: [], nextCursor: body.cursor, hasMore: false };
    const result = await this.pull.pull(sub.scope, body.cursor, Math.min(body.limit ?? MAX_PULL_LIMIT, MAX_PULL_LIMIT));
    sub.cursor = result.nextCursor;
    await this.pull.advanceCursor('device', sub.deviceId, result.nextCursor);
    const wireResult = encodePullResult(result); // client_seq: internal bigint -> wire decimal string (wire-codec.ts)
    socket.emit('sync:pull:result', wireResult);
    return wireResult;
  }

  @SubscribeMessage('sync:heartbeat')
  async onHeartbeat(@ConnectedSocket() socket: Socket, @MessageBody() body: { outboxDepth?: number }) {
    const sub = this.subscribers.get(socket.id);
    if (!sub) return { ok: true, serverTime: new Date().toISOString() };
    const highWater = await withSystemContext(this.pool, async (client) => {
      await this.registry.touchDeviceSync(client, sub.deviceId, body.outboxDepth ?? 0);
      return this.events.getHighWater(client, sub.deviceId);
    });
    const confirmedThrough = { [sub.deviceId]: Number(highWater) };
    return { ok: true, serverTime: new Date().toISOString(), confirmedThrough };
  }

  /** R2 (§5.5) — this engine's own wire extension of §4.6's `sync.balance_checksum` telemetry, see file header. */
  @SubscribeMessage('sync:checksum')
  async onChecksum(@ConnectedSocket() socket: Socket, @MessageBody() body: { areaHashes: Record<string, string> }) {
    const sub = this.subscribers.get(socket.id);
    if (!sub) return { ok: false };
    const result = await this.reconciliation.runR2(sub.locationId, sub.deviceId, body.areaHashes);
    return { ok: true, divergentAreas: result.divergentAreas };
  }

  /** Best-effort live fan-out to every OTHER connected socket whose scope overlaps this push's location (in-process only — see file header). */
  private fanOutNewEvents(pusherSocketId: string): void {
    for (const [socketId, sub] of this.subscribers) {
      if (socketId === pusherSocketId) continue;
      void this.pull.pull(sub.scope, sub.cursor, MAX_PULL_LIMIT).then((page) => {
        if (page.events.length === 0) return;
        sub.cursor = page.nextCursor;
        const wirePage = encodePullResult(page); // client_seq: internal bigint -> wire decimal string (wire-codec.ts)
        this.server.to(socketId).emit('sync:deliver', { events: wirePage.events, nextCursor: wirePage.nextCursor });
      });
    }
  }

}
