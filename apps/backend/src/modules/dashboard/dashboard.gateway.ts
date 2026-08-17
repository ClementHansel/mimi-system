import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { Pool } from 'pg';
import { TokenService } from '../../common/jwt/token.service';
import { ScopeService } from '../../common/scope/scope.service';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { withSystemContext, SYSTEM_CENTRAL_ROLE } from '../../common/database/system-context';

/**
 * Realtime dashboard tiles (CONTRACTS.md §4.18: "realtime tiles push over
 * socket.io channel dashboard:<scope>"), modeled EXACTLY on
 * `kernel/notification/notification.gateway.ts` — same JWT-over-handshake
 * auth via `TokenService`, same `OnGatewayConnection` shape, same
 * never-throws `pushUpdate()`.
 *
 * ROOM MODEL: `dashboard:all` for a central-role connection (Owner/Manager/
 * Finance/HR Admin — unrestricted `locationScope`), else one
 * `dashboard:<locationId>` room per location in the caller's own
 * `locationScope` (a Supervisor with two assigned outlets joins both). Scope
 * is resolved the SAME way `RlsContextGuard` resolves it for HTTP — via
 * `ScopeService.resolveLocationIds`, on a short-lived system-context
 * transaction opened just for this socket's connection (a socket handshake
 * has no `request.dbClient` of its own to borrow; `withSystemContext` is the
 * documented shape for exactly this "no existing RLS transaction" case —
 * see `common/database/system-context.ts`'s header). The socket's OWN
 * identity is real (JWT `sub`/`roleKey`), not a central-role impersonation —
 * only the transaction used to look up `user_locations` runs under the
 * system bypass, matching `assignedLocationIds`'s own narrow, self-scoped
 * queries.
 */
@Injectable()
@WebSocketGateway({ namespace: '/dashboard', cors: { origin: true, credentials: true } })
export class DashboardGateway implements OnGatewayConnection {
  private readonly logger = new Logger(DashboardGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly scope: ScopeService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = (client.handshake.auth?.token as string | undefined) ?? this.extractBearer(client);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.tokens.verifyAccessToken(token);
      const locationScope = await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, (systemClient) =>
        this.scope.resolveLocationIds(systemClient, { sub: payload.sub, roleKey: payload.roleKey }),
      );

      if (locationScope === null) {
        void client.join('dashboard:all');
      } else {
        for (const locationId of locationScope) {
          void client.join(`dashboard:${locationId}`);
        }
      }
    } catch {
      client.disconnect(true);
    }
  }

  private extractBearer(client: Socket): string | undefined {
    const header = client.handshake.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    return header.slice('Bearer '.length);
  }

  /**
   * Pushed after each matview refresh (or an ops-status-relevant change) —
   * best-effort, NEVER throws, matching `NotificationGateway.pushToUser`'s
   * own pattern. `scope` is `'all'` for a company-wide tile refresh, or a
   * specific `locationId` for a scoped update.
   */
  pushUpdate(scope: 'all' | string, payload: unknown): void {
    try {
      this.server?.to(scope === 'all' ? 'dashboard:all' : `dashboard:${scope}`).emit('dashboard:update', payload);
    } catch (err) {
      this.logger.warn(`Failed to push dashboard update for scope ${scope}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
