/**
 * Device-token authentication for M21's own REST routes (`POST
 * /api/devices/heartbeat`, and any future device-token route this module
 * adds) — CONTRACTS.md §3 footnote: "Device-token endpoints (register,
 * heartbeat, sync push/pull) authenticate with the device JWT, not user
 * permission keys." This is the CANONICAL device-token guard the
 * `device-registry.module.ts` stub comment promised: `kernel/sync` built its
 * own minimal, locally-scoped copy (`kernel/sync/device-auth.guard.ts`)
 * before M21 existed, explicitly flagged there as provisional pending this
 * file. This guard is NOT registered as a global `APP_GUARD` — it is applied
 * per-route via `@UseGuards()` alongside `@Public()` (which only bypasses
 * the USER-JWT chain: `JwtAuthGuard`/`RlsContextGuard`), exactly like
 * `kernel/sync/sync-http.controller.ts`'s own pattern, so it can never
 * collide with the global guard chain.
 */
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { ERR_AUTH_TOKEN_INVALID } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import type { DeviceStatusRow } from './device-registry.repository';

export interface RequestWithDeviceIdentity extends Request {
  device?: { id: UUID; locationId: UUID; nodeId: UUID | null; status: DeviceStatusRow };
}

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithDeviceIdentity>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: 'Missing device credential',
      });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token)
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: 'Empty device credential',
      });

    const tokenHash = hashDeviceToken(token);
    const device = await withSystemContext(this.pool, async (client) => {
      const res = await client.query<{
        id: UUID;
        location_id: UUID;
        node_id: UUID | null;
        status: DeviceStatusRow;
      }>(`SELECT id, location_id, node_id, status FROM devices WHERE device_token_hash = $1`, [
        tokenHash,
      ]);
      return res.rows[0];
    });

    if (!device)
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: 'Unknown device credential',
      });
    if (device.status === 'retired' || device.status === 'unpaired') {
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: `Device is ${device.status}`,
      });
    }

    request.device = {
      id: device.id,
      locationId: device.location_id,
      nodeId: device.node_id,
      status: device.status,
    };
    return true;
  }
}
