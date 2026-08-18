/**
 * Device-token authentication for `/sync/v1/*` (SYNC-PROTOCOL §1.5/§4.1:
 * "Transport auth is the device credential... sent as `auth.token` (socket)
 * / `Authorization: Bearer` (HTTP)").
 *
 * SCOPE NOTE (coordination, not a contract change): the CANONICAL
 * device-token guard is M21 `device-registry`'s to build (Wave 3, W3-10 —
 * see that module's stub comment: "this module provides its own
 * device-token guard rather than relying on the global JwtAuthGuard"),
 * since it also serves `/api/devices/register` and `/api/devices/heartbeat`.
 * M21 does not exist yet. This guard is a MINIMAL, LOCALLY-SCOPED
 * implementation covering only what `kernel/sync`'s own routes need
 * (resolve `Authorization: Bearer <token>` -> a `devices` row) — it is NOT
 * registered globally (`APP_GUARD`), only on `sync-http.controller.ts`'s own
 * routes via `@UseGuards`, so it cannot collide with whatever M21 builds.
 * When M21 lands, either it re-exports something this file can delegate to,
 * or this file is deleted in favor of it — flagged in the W2-D report.
 *
 * Every `/sync/v1/*` route is marked `@Public()` (bypasses the global
 * `JwtAuthGuard`/`RlsContextGuard`, which expect a USER access token) and
 * relies on THIS guard instead.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { RegistryRepository } from './registry.repository';
import type { DeviceRow } from './db-rows';

export interface RequestWithDevice extends Request {
  device?: { id: string; locationId: string; nodeId: string | null; status: DeviceRow['status'] };
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly registry: RegistryRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithDevice>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'ERR_UNAUTHORIZED',
        message: 'Missing device credential',
      });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token)
      throw new UnauthorizedException({
        code: 'ERR_UNAUTHORIZED',
        message: 'Empty device credential',
      });

    const device = await this.registry.findDeviceByTokenHash(hashDeviceToken(token));
    if (!device)
      throw new UnauthorizedException({
        code: 'ERR_UNAUTHORIZED',
        message: 'Unknown device credential',
      });
    if (device.status === 'retired' || device.status === 'unpaired') {
      throw new UnauthorizedException({
        code: 'ERR_UNAUTHORIZED',
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
