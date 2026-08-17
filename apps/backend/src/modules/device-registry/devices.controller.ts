/**
 * M21 `device-registry` — CONTRACTS.md §4.21's `/api/devices/*` rows (D-13,
 * SYNC-PROTOCOL §1.5/§7.1). Registration/heartbeat are device-token or
 * public (never a user JWT); everything else is the normal
 * `JwtAuthGuard -> RlsContextGuard -> PermissionsGuard` chain, RLS-scoped by
 * `devices_loc`'s `app_has_location(location_id)` (migration 116) — a
 * Supervisor sees only their own outlet's devices, Owner/Manager (central
 * roles) see everything, automatically, with zero extra code here.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Inject } from '@nestjs/common';
import { DeviceCategory, PairingTargetType, ERR_NOT_FOUND, ERR_VALIDATION, ERR_AUTH_TOKEN_INVALID } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository, type DeviceWithLocation } from './device-registry.repository';
import { PairingTokensService } from './pairing-tokens.service';
import { DeviceTokenGuard, type RequestWithDeviceIdentity } from './device-token.guard';
import { TopologyGateway } from './topology.gateway';
import { withWrite } from './db-tx';

const CLOUD_ORIGIN_ACTOR = '00000000-0000-0000-0000-0000000000c1' as UUID;

const PROTOCOL_V = 1;

function toDeviceDto(row: DeviceWithLocation) {
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: row.location_name,
    nodeId: row.node_id,
    category: row.category,
    name: row.name,
    status: row.status,
    appVersion: row.app_version,
    queueDepth: row.queue_depth,
    lastSeenAt: row.last_seen_at,
    lastSyncAt: row.last_sync_at,
    replacesDeviceId: row.replaces_device_id,
    ipAddress: row.ip_address,
    vendor: row.vendor,
    model: row.model,
    pairedAt: row.paired_at,
  };
}

interface DeviceHeartbeatBody {
  deviceId: UUID;
  at: string;
  appVersion: string;
  queueDepth: number;
  quarantineDepth?: number;
  pullLag?: number;
  lastSyncAt?: string | null;
  storage?: { usedMb: number; quotaMb: number };
  clockOffsetMs?: number;
  batteryPct?: number;
  networkType?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  activeUserId?: UUID | null;
  shiftOpen?: boolean;
}

@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DeviceRegistryRepository,
    private readonly pairingTokens: PairingTokensService,
    private readonly syncEmit: SyncEmitService,
    private readonly config: ConfigService,
    private readonly topologyGateway: TopologyGateway,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  // ── §4.21 pairing + registration ──────────────────────────────────────

  @RequirePermission('device.pair')
  @Audited({ entityType: 'pairing_token', action: 'device.pair' })
  @Post('pairing-tokens')
  async mintPairingToken(
    @Req() req: RequestWithDbContext,
    @Body() body: { locationId: UUID; targetType?: 'device'; suggestedCategory?: string },
  ) {
    if (!body?.locationId) throw new BadRequestException({ code: ERR_VALIDATION, message: 'locationId is required' });
    const client = (req.dbClient ?? this.pool) as PoolClient;
    // BE-TXN-ROLLBACK: this mint is a real write on `req.dbClient` — without `withWrite`,
    // `RlsCleanupInterceptor`'s unconditional post-request ROLLBACK silently discarded it.
    return withWrite(client, () =>
      this.pairingTokens.mint(client, {
        targetType: PairingTargetType.DEVICE,
        locationId: body.locationId,
        createdBy: req.user!.sub,
        suggestedCategory: body.suggestedCategory,
      }),
    );
  }

  /**
   * Public + pairing-token-authenticated (CONTRACTS §4.21) — no user JWT,
   * no RLS session exists yet. Runs under `withSystemContext` (the same
   * central-role bypass a real Owner/Manager already gets, scoped to one
   * transaction) because `mimi_app` has no direct grants of its own
   * (D-21/D-22: privileges live on `app_user`, membership is `NOINHERIT`).
   */
  @Public()
  @Post('register')
  async register(
    @Body()
    body: {
      token: string;
      fingerprint: string;
      name?: string;
      category: string;
      appVersion: string;
      osInfo?: Record<string, unknown>;
      replacesDeviceId?: UUID;
    },
  ) {
    if (!body?.token || !body?.fingerprint || !body?.category || !body?.appVersion) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'token, fingerprint, category and appVersion are required' });
    }
    if (!Object.values(DeviceCategory).includes(body.category as DeviceCategory)) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `unknown category '${body.category}'` });
    }

    const deviceToken = randomBytes(32).toString('hex');
    const deviceTokenHash = hashDeviceToken(deviceToken);

    const result = await withSystemContext(this.pool, async (client) => {
      const redeemed = await this.pairingTokens.redeem(client, body.token, PairingTargetType.DEVICE);
      if (!redeemed) return undefined;

      const nodeRes = await client.query<{ id: UUID; settings: Record<string, unknown> }>(
        `SELECT id, settings FROM branch_nodes WHERE location_id = $1 AND status <> 'retired'`,
        [redeemed.locationId],
      );
      const node = nodeRes.rows[0];

      const created = await this.devices.create(client, {
        locationId: redeemed.locationId,
        nodeId: node?.id ?? null,
        category: body.category,
        name: body.name ?? `${body.category} (${body.fingerprint.slice(0, 8)})`,
        fingerprint: body.fingerprint,
        appVersion: body.appVersion,
        osInfo: body.osInfo ?? {},
        replacesDeviceId: body.replacesDeviceId ?? null,
        deviceTokenHash,
        pairedBy: redeemed.createdBy,
      });
      await this.pairingTokens.recordUsedBy(client, redeemed.id, created.id);

      const locRes = await client.query<{ id: UUID; code: string; name: string }>(
        `SELECT id, code, name FROM locations WHERE id = $1`,
        [redeemed.locationId],
      );
      const location = locRes.rows[0]!;

      await this.syncEmit.emit(client, {
        entity: 'devices',
        op: 'registered',
        entityId: created.id,
        locationId: created.location_id,
        actorUserId: redeemed.createdBy,
        data: { fingerprint: created.fingerprint, category: created.category, locationId: created.location_id, replacesDeviceId: created.replaces_device_id ?? undefined },
      });
      await this.syncEmit.emit(client, {
        entity: 'devices',
        op: 'paired',
        entityId: created.id,
        locationId: created.location_id,
        actorUserId: redeemed.createdBy,
        data: { locationId: created.location_id, nodeLanUrl: (node?.settings?.lanUrl as string | undefined) ?? null },
      });

      return { created, location, nodeLanUrl: (node?.settings?.lanUrl as string | undefined) ?? null };
    });

    if (!result) throw new UnauthorizedException({ code: ERR_AUTH_TOKEN_INVALID, message: 'Invalid or expired pairing token' });

    return {
      deviceId: result.created.id,
      deviceToken,
      location: result.location,
      nodeLanUrl: result.nodeLanUrl,
      syncConfig: {
        cloudUrl: this.config.get<string>('BACKEND_ORIGIN', 'http://localhost:4000'),
        protocolV: PROTOCOL_V,
      },
    };
  }

  /** Device-token authenticated (CONTRACTS §4.21/§7.3) — updates `devices` bookkeeping and appends `device_heartbeats`; also accepted over `/sync`'s `sync:heartbeat` (SYNC-PROTOCOL §4.6) for the lower-level connection-liveness signal, but THIS is the D-13 topology heartbeat that drives the staleness sweep. */
  @Public()
  @UseGuards(DeviceTokenGuard)
  @Post('heartbeat')
  async heartbeat(@Req() req: RequestWithDeviceIdentity, @Body() body: DeviceHeartbeatBody) {
    const device = req.device!;
    if (!body?.appVersion || typeof body.queueDepth !== 'number') {
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'appVersion and queueDepth are required' });
    }

    await withSystemContext(this.pool, async (client) => {
      // §7.3: "any -> online recovery" is an edge the sweep (which only runs every 30s and only
      // ever moves a row TOWARD stale/offline) cannot detect — a heartbeat's own arrival IS the
      // recovery instant, so the transition is captured here, before `recordHeartbeat` overwrites
      // `status`.
      const before = await this.devices.findById(client, device.id);
      const wasDown = before && before.status !== 'online';

      await this.devices.recordHeartbeat(client, device.id, {
        appVersion: body.appVersion,
        queueDepth: body.queueDepth,
        clientTime: body.at ?? new Date().toISOString(),
        batteryPct: body.batteryPct,
        storageFreeMb: body.storage ? Math.max(0, body.storage.quotaMb - body.storage.usedMb) : undefined,
        networkType: body.networkType,
        payload: body as unknown as Record<string, unknown>,
      });

      if (wasDown && before) {
        await this.devices.insertDeviceEvent(client, { deviceId: device.id, locationId: device.locationId, type: 'online' });
        await this.syncEmit
          .emit(client, { entity: 'device_events', op: 'went_online', entityId: device.id, locationId: device.locationId, actorUserId: CLOUD_ORIGIN_ACTOR, data: {} })
          .catch(() => undefined); // best-effort telemetry — never fail the heartbeat ack over it
        this.topologyGateway.emitUpdate({ locationId: device.locationId, deviceId: device.id, status: 'online' });
      }
    });

    return { ok: true, serverTime: new Date().toISOString() };
  }

  // ── §4.21 admin/read surface (user JWT + RBAC + RLS) ─────────────────

  @RequirePermission('device.read')
  @Get()
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    const client = req.dbClient ?? this.pool;
    const { rows, total } = await this.devices.list(client, {
      locationId: locationId as UUID | undefined,
      locationIds: locationId ? undefined : req.locationScope,
      category,
      status,
      page: Number(page),
      pageSize: Number(pageSize),
    });
    return { rows: rows.map(toDeviceDto), total, page: Number(page), pageSize: Number(pageSize) };
  }

  @RequirePermission('device.read')
  @Get(':id')
  async detail(@Req() req: RequestWithDbContext, @Param('id') id: UUID) {
    const client = req.dbClient ?? this.pool;
    const device = await this.devices.findById(client, id);
    if (!device) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Device not found' });
    const [recentHeartbeats, events] = await Promise.all([
      this.devices.recentHeartbeats(client, id),
      this.devices.recentEvents(client, id),
    ]);
    return {
      ...toDeviceDto(device),
      recentHeartbeats: recentHeartbeats.map((h) => ({ at: h.at, queueDepth: h.queue_depth, appVersion: h.app_version, batteryPct: h.battery_pct })),
      events: events.map((e) => ({ type: e.type, detail: e.detail, createdAt: e.created_at })),
    };
  }

  @RequirePermission('device.manage')
  @Audited({ entityType: 'devices', action: 'device.manage' })
  @Patch(':id')
  async update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() body: { name?: string; category?: string; locationId?: UUID },
  ) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const before = await this.devices.findById(client, id);
    if (!before) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Device not found' });
    if (body.category && !Object.values(DeviceCategory).includes(body.category as DeviceCategory)) {
      throw new BadRequestException({ code: ERR_VALIDATION, message: `unknown category '${body.category}'` });
    }

    // BE-TXN-ROLLBACK: validation reads stay outside; once committed to writing, the entire
    // rest of this method's writes + response-building runs inside one `withWrite` call.
    return withWrite(client, async () => {
      const updated = await this.devices.update(client, id, body);
      if (!updated) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Device not found' });

      await this.syncEmit.emit(client, {
        entity: 'devices',
        op: 'profile_updated',
        entityId: id,
        locationId: updated.location_id,
        actorUserId: req.user!.sub,
        data: { name: body.name, category: body.category, locationId: body.locationId },
      });

      const withLocation = await this.devices.findById(client, id);
      return toDeviceDto(withLocation!);
    });
  }

  @RequirePermission('device.manage')
  @Audited({ entityType: 'devices', action: 'device.manage' })
  @Post(':id/unpair')
  async unpair(@Req() req: RequestWithDbContext, @Param('id') id: UUID, @Body() body: { reason?: string }) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const existing = await this.devices.findById(client, id);
    if (!existing) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Device not found' });

    return withWrite(client, async () => {
      await this.devices.unpair(client, id);
      await this.devices.insertDeviceEvent(client, { deviceId: id, locationId: existing.location_id, type: 'unpaired', detail: { reason: body?.reason } });
      // SYNC-PROTOCOL §3.3 group 12: unpairing is the KILL SWITCH described for `revoked` — "must
      // stop pushing and wipe credentials" — the AUTHORITY op vocabulary has no separate `unpaired` op.
      await this.syncEmit.emit(client, {
        entity: 'devices',
        op: 'revoked',
        entityId: id,
        locationId: existing.location_id,
        actorUserId: req.user!.sub,
        data: { reason: body?.reason },
      });

      return toDeviceDto((await this.devices.findById(client, id))!);
    });
  }

  @RequirePermission('device.manage')
  @Audited({ entityType: 'devices', action: 'device.manage' })
  @Post(':id/retire')
  async retire(@Req() req: RequestWithDbContext, @Param('id') id: UUID, @Body() body: { replacedByDeviceId?: UUID }) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const existing = await this.devices.findById(client, id);
    if (!existing) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Device not found' });

    return withWrite(client, async () => {
      await this.devices.retire(client, id);
      await this.devices.insertDeviceEvent(client, { deviceId: id, locationId: existing.location_id, type: 'unpaired', detail: { retired: true, replacedByDeviceId: body?.replacedByDeviceId } });
      await this.syncEmit.emit(client, {
        entity: 'devices',
        op: 'retired',
        entityId: id,
        locationId: existing.location_id,
        actorUserId: req.user!.sub,
        data: { replacedByDeviceId: body?.replacedByDeviceId },
      });

      return toDeviceDto((await this.devices.findById(client, id))!);
    });
  }
}
