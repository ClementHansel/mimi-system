import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../../common/jwt/token.service';

/**
 * Realtime push for in-app notifications (D-03) — a UX nicety on top of the
 * `notifications` table (`GET /api/notifications` remains the source of
 * truth; a client that never connects, or misses an event, still sees
 * everything on next fetch/poll).
 *
 * ROOM MODEL: one room per `userId` (`user:<uuid>`), joined by the client
 * after connecting by presenting its access token as the `auth.token`
 * handshake field (falling back to a Bearer header) — verified with the
 * SAME `TokenService` (`common/jwt`) `JwtAuthGuard` uses for REST, so there
 * is exactly one access-token verification path in this codebase, not two.
 * An unauthenticated or invalid/expired token disconnects the socket
 * immediately rather than leaving it connected-but-silent.
 */
@Injectable()
@WebSocketGateway({ namespace: '/notifications', cors: { origin: true, credentials: true } })
export class NotificationGateway implements OnGatewayConnection {
  private readonly logger = new Logger(NotificationGateway.name);

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
      void client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  private extractBearer(client: Socket): string | undefined {
    const header = client.handshake.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    return header.slice('Bearer '.length);
  }

  /** Push a notification payload to every socket the user currently has open. Never throws — a disconnected user simply misses the push (they'll see it on next `GET /api/notifications`). */
  pushToUser(userId: string, payload: unknown): void {
    try {
      this.server?.to(`user:${userId}`).emit('notification:new', payload);
    } catch (err) {
      this.logger.warn(`Failed to push notification to user ${userId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
