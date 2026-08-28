/**
 * M22 `node-gateway` — CONTRACTS.md §4.22's `/api/nodes/*` rows (D-12/D-13).
 * Registration is public + pairing-token authenticated (no user session
 * exists yet); everything else is the normal
 * `JwtAuthGuard -> RlsContextGuard -> PermissionsGuard` chain, RLS-scoped by
 * `branch_nodes_loc` (migration 116).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  PairingTargetType,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_AUTH_TOKEN_INVALID,
  ERR_CONFLICT,
  ERR_NODE_UNREACHABLE,
  ERR_NODE_SHIFT_OPEN,
} from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import type { DbClient } from '../../kernel/sync/sync-events.repository';
import { PairingTokensService } from '../device-registry/pairing-tokens.service';
import { BranchNodesRepository, type BranchNodeWithLocation } from './branch-nodes.repository';
import { DiscoveredDevicesRepository } from './discovered-devices.repository';
import { DeviceRegistryRepository } from '../device-registry/device-registry.repository';
import { BridgeGateway } from './bridge.gateway';
import { OutletNodeSettingRepository } from './outlet-node-setting.repository';
import { withWrite } from './db-tx';
import { validateNetworkConfig, type NetworkConfigInput } from './network-config.validation';
import { encryptWifiPassphrase, networkSecretEncKeyFromConfig } from './network-config-crypto';

function toNodeSummary(row: BranchNodeWithLocation, relayQueueDepth = 0, deviceCount = 0) {
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: row.location_name,
    name: row.name,
    status: row.status,
    version: row.version,
    ipAddress: row.ip_address,
    lastSeenAt: row.last_seen_at,
    deviceCount,
    relayQueueDepth,
    // W3-10: the node's own network-config apply-then-confirm state (never the secret — `network_config`
    // itself never contains `wifiPassphrase`, only `wifiPassphraseSet`; see `network-config-crypto.ts`).
    networkConfig: row.network_config ?? {},
    networkConfigStatus: row.network_config_status,
    networkConfigResult: row.network_config_result ?? {},
  };
}

@Controller('nodes')
export class NodesController {
  constructor(
    private readonly branchNodes: BranchNodesRepository,
    private readonly pairingTokens: PairingTokensService,
    private readonly discovered: DiscoveredDevicesRepository,
    private readonly deviceRegistry: DeviceRegistryRepository,
    private readonly bridge: BridgeGateway,
    private readonly syncEmit: SyncEmitService,
    private readonly outletNodeSetting: OutletNodeSettingRepository,
    private readonly configService: ConfigService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /** Wizard-support endpoint (BUILD-PLAN D-26 build item 3): gated on the outlet's `nodeEnabled`
   *  setting — a location the Owner has not switched ON gets no pairing token, so a node can never
   *  end up paired to an outlet whose setting still says OFF. */
  @RequirePermission('node.manage')
  @Audited({ entityType: 'pairing_token', action: 'node.manage' })
  @Post('pairing-tokens')
  async mintPairingToken(@Req() req: RequestWithDbContext, @Body() body: { locationId: UUID }) {
    if (!body?.locationId)
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'locationId is required' });
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const setting = await this.outletNodeSetting.find(client, body.locationId);
    if (!setting)
      throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Location not found' });
    if (!setting.node_enabled) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message:
          "This outlet's branch-node setting is OFF — turn it ON first (PUT /api/nodes/outlet-setting/:locationId) before pairing a node",
      });
    }
    const existing = await this.branchNodes.findByLocationId(client, body.locationId);
    if (existing)
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: 'This location already has a paired branch node (one node per location)',
      });
    // BE-TXN-ROLLBACK: this mint is a real write on `req.dbClient` — without `withWrite`,
    // `RlsCleanupInterceptor`'s unconditional post-request ROLLBACK silently discarded it.
    return withWrite(client, () =>
      this.pairingTokens.mint(client, {
        targetType: PairingTargetType.NODE,
        locationId: body.locationId,
        createdBy: req.user!.sub,
      }),
    );
  }

  /** Public + pairing-token authenticated (CONTRACTS §4.22). `lanCert` is ALWAYS `null` here — DNS-01 issuance is asynchronous (SYNC-PROTOCOL §1.3) and must never block pairing; it arrives later as `cert_rotated` over `/bridge` once a real ACME integration exists (out of this ticket's scope — no new dependency without W1-A, collision rule 2). */
  @Public()
  @Post('register')
  async register(
    @Body()
    body: {
      token: string;
      hostname: string;
      version: string;
      osInfo?: Record<string, unknown>;
    },
  ) {
    if (!body?.token || !body?.hostname || !body?.version) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'token, hostname and version are required',
      });
    }

    const nodeToken = randomBytes(32).toString('hex');
    const nodeTokenHash = hashDeviceToken(nodeToken);

    const result = await withSystemContext(this.pool, async (client) => {
      const redeemed = await this.pairingTokens.redeem(client, body.token, PairingTargetType.NODE);
      if (!redeemed) return undefined;

      const existing = await this.branchNodes.findByLocationId(client, redeemed.locationId);
      if (existing) return { conflict: true as const };

      const created = await this.branchNodes.create(client, {
        locationId: redeemed.locationId,
        name: body.hostname,
        version: body.version,
        hostname: body.hostname,
        osInfo: body.osInfo ?? {},
        nodeTokenHash,
        pairedBy: redeemed.createdBy,
      });
      await this.pairingTokens.recordUsedBy(client, redeemed.id, created.id);

      const locRes = await client.query<{ id: UUID; code: string; name: string }>(
        `SELECT id, code, name FROM locations WHERE id = $1`,
        [redeemed.locationId],
      );
      const location = locRes.rows[0]!;

      await this.syncEmit.emit(client, {
        entity: 'branch_nodes',
        op: 'registered',
        entityId: created.id,
        locationId: created.location_id,
        actorUserId: redeemed.createdBy,
        data: {
          locationId: created.location_id,
          hostname: created.hostname,
          version: created.version,
        },
      });
      await this.syncEmit.emit(client, {
        entity: 'branch_nodes',
        op: 'paired',
        entityId: created.id,
        locationId: created.location_id,
        actorUserId: redeemed.createdBy,
        data: { lanUrl: null },
      });

      return { conflict: false as const, created, location };
    });

    if (!result)
      throw new UnauthorizedException({
        code: ERR_AUTH_TOKEN_INVALID,
        message: 'Invalid or expired pairing token',
      });
    if (result.conflict)
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: 'This location already has a paired branch node',
      });

    return {
      nodeId: result.created.id,
      nodeToken,
      lanCert: null as null,
      config: {},
      location: result.location,
    };
  }

  @RequirePermission('node.read')
  @Get()
  async list(
    @Req() req: RequestWithDbContext,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
  ) {
    const client = req.dbClient ?? this.pool;
    const rows = await this.branchNodes.list(client, {
      locationId: locationId as UUID | undefined,
      locationIds: locationId ? undefined : req.locationScope,
      status,
    });
    const deviceCounts = await this.deviceCountsByNode(
      client,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toNodeSummary(r, 0, deviceCounts.get(r.id) ?? 0));
  }

  @RequirePermission('node.read')
  @Get(':id')
  async detail(@Req() req: RequestWithDbContext, @Param('id') id: UUID) {
    const client = req.dbClient ?? this.pool;
    const node = await this.branchNodes.findById(client, id);
    if (!node) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Node not found' });
    const [deviceCounts, discoveredNew, events] = await Promise.all([
      this.deviceCountsByNode(client, [id]),
      this.discovered.listByNode(client, id, 'new'),
      this.deviceRegistry.recentEvents(client, id), // shares the same table shape; node_id rows come back identically
    ]);
    return {
      ...toNodeSummary(node, 0, deviceCounts.get(id) ?? 0),
      discoveredNewCount: discoveredNew.length,
      isConnected: this.bridge.isConnected(id),
      events,
    };
  }

  @RequirePermission('node.manage')
  @Audited({ entityType: 'branch_nodes', action: 'node.manage' })
  @Patch(':id')
  async update(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() body: { name?: string },
  ) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const existing = await this.branchNodes.findById(client, id);
    if (!existing)
      throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Node not found' });
    return withWrite(client, async () => {
      await this.branchNodes.update(client, id, body);
      return this.branchNodes.findById(client, id);
    });
  }

  /**
   * `discovery_scan` and `log_pull` are real, non-destructive actions the node performs
   * (`apps/branch-node/src/relay.ts`'s `handleCommand`). `restart` is real but destructive to a live
   * outlet — gated below on an open POS shift (W3-10 hardening) unless `params.override === true`.
   * `update` is delivered like any other command, but the node itself now honestly acks `'failed'`
   * for it (no fleet software-distribution mechanism exists on this build, W5-07 follow-up) rather
   * than the blanket 'done' no-op this endpoint used to enable.
   */
  @RequirePermission('node.manage')
  @Audited({ entityType: 'branch_nodes', action: 'node.manage' })
  @Post(':id/command')
  async sendCommand(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body()
    body: {
      type: 'restart' | 'update' | 'log_pull' | 'discovery_scan';
      params?: { override?: boolean; lines?: number };
    },
  ) {
    if (!body?.type)
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'type is required' });
    const client = req.dbClient ?? this.pool;
    const node = await this.branchNodes.findById(client, id);
    if (!node) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Node not found' });

    if ((body.type === 'restart' || body.type === 'update') && body.params?.override !== true) {
      const openShift = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pos_shifts WHERE location_id = $1 AND status = 'open'`,
        [node.location_id],
      );
      if (Number(openShift.rows[0]?.n ?? '0') > 0) {
        throw new BadRequestException({
          code: ERR_NODE_SHIFT_OPEN,
          message: `This outlet has an open POS shift — '${body.type}' would disrupt it. Pass params.override:true to fire anyway.`,
        });
      }
    }

    const commandId = randomUUID() as UUID;
    const delivered = this.bridge.sendCommand(id, {
      commandId,
      type: body.type,
      params: body.params,
    });
    if (!delivered) {
      throw new BadRequestException({
        code: ERR_CONFLICT,
        message: 'Node is not currently connected to /bridge',
      });
    }
    return { commandId, status: 'sent' as const };
  }

  /**
   * The real remote write path a previous agent correctly found missing (W3-10): validates BEFORE
   * anything reaches the outlet (`validateNetworkConfig`), refuses against a disconnected node (a
   * config pushed into the void can never be confirmed or reverted — same "no live channel, no write"
   * stance `OutletNodeSettingController`'s drain-before-off already takes), encrypts the WiFi
   * passphrase at rest, and delivers the DECRYPTED full config to the node's own authenticated
   * `/bridge` socket only — never the sync event, never the REST response.
   *
   * Only `healthPort`/`scanSubnet` are genuinely applied by every node build today; the rest are
   * accepted, validated, and stored (a future OS-network-integration build has real data the moment
   * it exists) but the node's own ack reports them `applied: false` — see
   * `apps/branch-node/src/network/applier.ts`'s doc comment. This endpoint returns the node's
   * eventual ack outcome via `GET /api/nodes/:id`'s `networkConfigStatus`/`networkConfigResult`
   * fields, not synchronously — apply-then-confirm is not instantaneous by design.
   */
  @RequirePermission('node.manage')
  @Audited({ entityType: 'branch_nodes', action: 'node.manage' })
  @Put(':id/network-config')
  async setNetworkConfig(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() body: NetworkConfigInput,
  ) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const node = await this.branchNodes.findById(client, id);
    if (!node) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Node not found' });

    const existingConfig = (node.network_config ?? {}) as { wifiSsid?: string };
    const errors = validateNetworkConfig(body, {
      hasExistingWifiSsid: typeof existingConfig.wifiSsid === 'string',
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: `Invalid network config: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
        details: { errors },
      });
    }

    if (!this.bridge.isConnected(id)) {
      throw new BadRequestException({
        code: ERR_NODE_UNREACHABLE,
        message:
          'Node is not currently connected to /bridge — a network config pushed to an unreachable node could never be confirmed or reverted, so it is refused rather than queued silently.',
      });
    }

    const configId = randomUUID() as UUID;
    // Non-secret projection: everything except `wifiPassphrase`, which never lands in `branch_nodes
    // .network_config`, the `branch_nodes.config_updated` sync event below, an audit-log payload, or
    // this endpoint's own response — only `network_secret_enc` (encrypted) and the one authenticated
    // `/bridge` push to this exact node ever see the plaintext.
    const { wifiPassphrase, ...nonSecretPatch } = body;
    const nonSecretConfig: Record<string, unknown> = { ...nonSecretPatch };
    if (wifiPassphrase !== undefined) nonSecretConfig.wifiPassphraseSet = true;

    const secretEnc = wifiPassphrase
      ? encryptWifiPassphrase(wifiPassphrase, networkSecretEncKeyFromConfig(this.configService))
      : null;

    return withWrite(client, async () => {
      await this.branchNodes.setNetworkConfigPending(client, id, {
        configId,
        config: nonSecretConfig,
        secretEnc,
      });

      await this.syncEmit.emit(client, {
        entity: 'branch_nodes',
        op: 'config_updated',
        entityId: id,
        locationId: node.location_id,
        actorUserId: req.user!.sub,
        data: { configId, config: nonSecretConfig },
      });

      // The DECRYPTED full config (including the plaintext passphrase, if any) rides the node's own
      // authenticated `/bridge` socket ONLY — the same "sensitive material never touches the durable
      // event log" precedent `cert_rotated`'s private key already set.
      const wireConfig: Record<string, unknown> = { ...nonSecretPatch };
      if (wifiPassphrase !== undefined) wireConfig.wifiPassphrase = wifiPassphrase;
      this.bridge.sendNetworkConfig(id, { configId, config: wireConfig });

      const updated = await this.branchNodes.findById(client, id);
      return {
        configId,
        networkConfig: updated!.network_config,
        networkConfigStatus: updated!.network_config_status,
      };
    });
  }

  @RequirePermission('node.manage')
  @Audited({ entityType: 'branch_nodes', action: 'node.manage' })
  @Post(':id/unpair')
  async unpair(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() body: { reason?: string },
  ) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const existing = await this.branchNodes.findById(client, id);
    if (!existing)
      throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Node not found' });

    return withWrite(client, async () => {
      await this.branchNodes.unpair(client, id);
      await this.deviceRegistry.insertDeviceEvent(client, {
        nodeId: id,
        locationId: existing.location_id,
        type: 'unpaired',
        detail: { reason: body?.reason },
      });
      await this.syncEmit.emit(client, {
        entity: 'branch_nodes',
        op: 'revoked',
        entityId: id,
        locationId: existing.location_id,
        actorUserId: req.user!.sub,
        data: { reason: body?.reason },
      });
      this.bridge.sendRevoked(id);

      return this.branchNodes.findById(client, id);
    });
  }

  @RequirePermission('node.read')
  @Get(':id/discovered-devices')
  async listDiscovered(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Query('status') status?: string,
  ) {
    const client = req.dbClient ?? this.pool;
    const rows = await this.discovered.listByNode(client, id, status);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      ipAddress: r.ip_address,
      macAddress: r.mac_address,
      vendor: r.vendor,
      model: r.model,
      suggestedCategory: r.suggested_category,
      suggestedName: r.suggested_name,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      status: r.status,
    }));
  }

  @RequirePermission('device.pair')
  @Audited({ entityType: 'discovered_devices', action: 'device.pair' })
  @Post('discovered/:id/confirm')
  async confirmDiscovered(
    @Req() req: RequestWithDbContext,
    @Param('id') id: UUID,
    @Body() body: { category: string; name: string },
  ) {
    if (!body?.category || !body?.name)
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'category and name are required',
      });
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const discovered = await this.discovered.findById(client, id);
    if (!discovered)
      throw new BadRequestException({
        code: ERR_NOT_FOUND,
        message: 'Discovered device not found',
      });

    const node = await this.branchNodes.findById(client, discovered.node_id);
    if (!node)
      throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Owning node not found' });

    return withWrite(client, async () => {
      const created = await this.deviceRegistry.create(client, {
        locationId: node.location_id,
        nodeId: node.id,
        category: body.category,
        name: body.name,
        fingerprint: `discovered:${discovered.mac_address ?? discovered.ip_address}`,
        appVersion: 'n/a',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: null, // passive LAN gear (printers/routers) never authenticates to /sync itself
        pairedBy: req.user!.sub,
      });
      await this.discovered.markConfirmed(client, id, created.id);
      await this.deviceRegistry.setDeviceStatus(
        client,
        created.id,
        node.status === 'online' ? 'online' : 'offline',
      );

      const withLocation = await this.deviceRegistry.findById(client, created.id);
      return withLocation;
    });
  }

  @RequirePermission('device.pair')
  @Post('discovered/:id/ignore')
  async ignoreDiscovered(@Req() req: RequestWithDbContext, @Param('id') id: UUID) {
    const client = (req.dbClient ?? this.pool) as PoolClient;
    const discovered = await this.discovered.findById(client, id);
    if (!discovered)
      throw new BadRequestException({
        code: ERR_NOT_FOUND,
        message: 'Discovered device not found',
      });
    return withWrite(client, async () => {
      await this.discovered.markIgnored(client, id);
      return { ok: true };
    });
  }

  private async deviceCountsByNode(client: DbClient, nodeIds: UUID[]): Promise<Map<UUID, number>> {
    if (nodeIds.length === 0) return new Map();
    const res = await client.query<{ node_id: UUID; n: string }>(
      `SELECT node_id, COUNT(*)::text AS n FROM devices WHERE node_id = ANY($1::uuid[]) AND status IN ('online','stale') GROUP BY node_id`,
      [nodeIds],
    );
    return new Map(res.rows.map((r) => [r.node_id, Number(r.n)]));
  }
}
