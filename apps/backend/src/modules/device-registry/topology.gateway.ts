/**
 * Realtime push for F12 (CONTRACTS.md §7.5): `topology:update` on every
 * device/node/outlet status transition, `topology:sync` (throttled 1/10s
 * per location) for queue-depth/last-sync ticks. `GET /api/topology`
 * remains the source of truth for a client that never connects or misses an
 * event — this socket is a UX nicety on top of it, exactly like
 * `kernel/notification/notification.gateway.ts`'s own pattern (reused here:
 * one access-token verification path, `TokenService`, not two).
 *
 * Permission-gated at connect time (`topology.read` — Owner/Manager only,
 * CONTRACTS §3): this is defense in depth on top of the REST endpoint's
 * `@RequirePermission`, not a replacement for it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { can, type RoleKey } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { TokenService } from '../../common/jwt/token.service';

export interface TopologyUpdatePayload {
  locationId: UUID;
  deviceId?: UUID;
  nodeId?: UUID;
  status: 'online' | 'stale' | 'offline';
}

export interface TopologySyncPayload {
  locationId: UUID;
  queueDepth: number;
  lastSyncAt: string | null;
}

const ROOM = 'topology';

@Injectable()
@WebSocketGateway({ namespace: '/topology', cors: { origin: true, credentials: true } })
export class TopologyGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TopologyGateway.name);
  private readonly lastSyncEmitAt = new Map<UUID, number>();

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly tokens: TokenService) {}

  handleConnection(client: Socket): void {
    const token = (client.handshake.auth?.token as string | undefined) ?? this.extractBearer(client);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.tokens.verifyAccessToken(token);
      if (!can(payload.roleKey as RoleKey, 'topology.read')) {
        client.disconnect(true);
        return;
      }
      void client.join(ROOM);
    } catch {
      client.disconnect(true);
    }
  }

  private extractBearer(client: Socket): string | undefined {
    const header = client.handshake.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    return header.slice('Bearer '.length);
  }

  emitUpdate(payload: TopologyUpdatePayload): void {
    try {
      this.server?.to(ROOM).emit('topology:update', payload);
    } catch (err) {
      this.logger.warn(`Failed to broadcast topology:update: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Throttled to at most 1/10s per location (§7.5) — a fast heartbeat/sweep loop must not flood F12. */
  emitSync(payload: TopologySyncPayload): void {
    const now = Date.now();
    const last = this.lastSyncEmitAt.get(payload.locationId) ?? 0;
    if (now - last < 10_000) return;
    this.lastSyncEmitAt.set(payload.locationId, now);
    try {
      this.server?.to(ROOM).emit('topology:sync', payload);
    } catch (err) {
      this.logger.warn(`Failed to broadcast topology:sync: ${err instanceof Error ? err.message : err}`);
    }
  }
}
