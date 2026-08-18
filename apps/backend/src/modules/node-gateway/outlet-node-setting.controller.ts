/**
 * `/api/nodes/outlet-setting/*` — BUILD-PLAN D-26 (owner-decided, new since
 * CONTRACTS.md was last touched; not yet transcribed there — see this
 * ticket's W3-10 report for the contract-change request).
 *
 * The branch node becomes a per-outlet, Owner-only setting:
 *   - ON  -> that outlet runs a branch node (a PC on site); turning it on is
 *            just the config flag flipping — the actual pairing happens
 *            through the wizard-support endpoints below, same as any other
 *            node pairing (§4.22/§7.1). Default OFF (RISK-P5).
 *   - OFF -> drain-before-off (D-26's core guarantee): refuses while the
 *            node's relay outbox is non-empty, or while it can't be proven
 *            empty (node unreachable) — see `drainStatusFor` below. Draining
 *            successfully unpairs the node exactly like `NodesController
 *            .unpair()` (kill switch + devices fall back to cloud-direct).
 *
 * Lives in `node-gateway` (not `device-registry` or `location`) because the
 * entire feature is about whether a *node* runs for an outlet — `location`
 * (M03) owns `locations` CRUD but has no stake in node lifecycle, and this
 * module already reads/writes `locations` rows directly for pairing (see
 * `NodesController.register`'s own `SELECT id, code, name FROM locations`).
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  ERR_FORBIDDEN,
  ERR_NODE_QUEUE_PENDING,
  ERR_NODE_UNREACHABLE,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
} from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from '../device-registry/device-registry.repository';
import { BranchNodesRepository, type BranchNodeRow } from './branch-nodes.repository';
import { BridgeGateway } from './bridge.gateway';
import {
  OutletNodeSettingRepository,
  type OutletNodeSettingRow,
} from './outlet-node-setting.repository';
import { withWrite } from './db-tx';

/** §7.3's own node "stale after" threshold: a `relayQueueDepth` reading older than this cannot be
 *  trusted as "the queue right now" — the node may have accepted more LAN-device events since. */
const FRESH_QUEUE_READING_MS = 90_000;

interface DrainStatus {
  /** Reachable AND the last fresh reading was exactly zero — the only condition D-26 allows OFF on. */
  ready: boolean;
  /** Live `/bridge` socket AND a reading no older than `FRESH_QUEUE_READING_MS`. */
  reachable: boolean;
  pendingCount: number | null;
  lastReportedAt: string | null;
}

function drainStatusFor(node: BranchNodeRow, connected: boolean): DrainStatus {
  const settings = (node.settings ?? {}) as {
    relayQueueDepth?: number;
    relayQueueDepthAt?: string;
  };
  const pendingCount =
    typeof settings.relayQueueDepth === 'number' ? settings.relayQueueDepth : null;
  const lastReportedAt = settings.relayQueueDepthAt ?? null;
  const fresh =
    lastReportedAt !== null &&
    Date.now() - new Date(lastReportedAt).getTime() <= FRESH_QUEUE_READING_MS;
  const reachable = connected && fresh;
  return { ready: reachable && pendingCount === 0, reachable, pendingCount, lastReportedAt };
}

function toStateDto(
  loc: OutletNodeSettingRow,
  node: BranchNodeRow | undefined | null,
  extra?: { isConnected?: boolean },
) {
  return {
    locationId: loc.id,
    locationCode: loc.code,
    locationName: loc.name,
    nodeEnabled: loc.node_enabled,
    node: node
      ? {
          id: node.id,
          status: node.status,
          version: node.version,
          lastSeenAt: node.last_seen_at,
          pairedAt: node.paired_at,
          isConnected: extra?.isConnected ?? false,
        }
      : null,
  };
}

@Controller('nodes/outlet-setting')
export class OutletNodeSettingController {
  constructor(
    private readonly outletSetting: OutletNodeSettingRepository,
    private readonly branchNodes: BranchNodesRepository,
    private readonly deviceRegistry: DeviceRegistryRepository,
    private readonly bridge: BridgeGateway,
    private readonly syncEmit: SyncEmitService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /** Current setting + node summary — what the topology/settings UI reads to render the toggle. */
  @RequirePermission('node.read')
  @Get(':locationId')
  async get(@Req() req: RequestWithDbContext, @Param('locationId') locationId: UUID) {
    const client = req.dbClient ?? this.pool;
    const loc = await this.outletSetting.find(client, locationId);
    if (!loc) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Location not found' });
    const node = await this.branchNodes.findByLocationId(client, locationId);
    return toStateDto(loc, node, { isConnected: node ? this.bridge.isConnected(node.id) : false });
  }

  /**
   * Setup-wizard polling endpoint (build item 3: "report pairing state, verify the node reported in,
   * confirm the outlet is ready"). One shape covers all three — the wizard UI polls this after minting
   * a pairing token (`POST /api/nodes/pairing-tokens`, gated below on `nodeEnabled=true`) until
   * `ready` flips true.
   */
  @RequirePermission('node.read')
  @Get(':locationId/pairing-status')
  async pairingStatus(@Req() req: RequestWithDbContext, @Param('locationId') locationId: UUID) {
    const client = req.dbClient ?? this.pool;
    const loc = await this.outletSetting.find(client, locationId);
    if (!loc) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Location not found' });

    const node = await this.branchNodes.findByLocationId(client, locationId);
    const pendingRes = await client.query<{ id: UUID; display_code: string; expires_at: string }>(
      `SELECT id, display_code, expires_at FROM pairing_tokens
        WHERE location_id = $1 AND target_type = 'node' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [locationId],
    );
    const pendingToken = pendingRes.rows[0];
    const isConnected = node ? this.bridge.isConnected(node.id) : false;
    const ready = !!node && node.status !== 'unpaired' && node.status !== 'retired' && isConnected;

    return {
      ...toStateDto(loc, node, { isConnected }),
      pendingPairingToken: pendingToken
        ? {
            tokenId: pendingToken.id,
            displayCode: pendingToken.display_code,
            expiresAt: pendingToken.expires_at,
          }
        : null,
      ready,
    };
  }

  /**
   * The toggle itself (build item 1 + 2). Owner-only (D-26 says so explicitly; `node.manage` in the
   * RBAC matrix is owner+manager — see CONTRACTS.md §3/`packages/shared/rbac.ts` — so this endpoint
   * layers an EXPLICIT role check on top rather than widening/forking the shared permission key for
   * one stricter business rule. A dedicated `node.outlet_setting.manage` permission scoped to Owner
   * alone would be the cleaner long-term shape but needs an RBAC-matrix seed edit — flagged for the
   * architect, not done here per this ticket's "never write to database/ yourself.")
   */
  @RequirePermission('node.manage')
  @Audited({ entityType: 'locations', action: 'node.manage' })
  @Put(':locationId')
  async setEnabled(
    @Req() req: RequestWithDbContext,
    @Param('locationId') locationId: UUID,
    @Body() body: { nodeEnabled: boolean },
  ) {
    if (req.user!.roleKey !== 'owner') {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: `Role '${req.user!.roleKey}' may not change the branch-node setting — Owner only (BUILD-PLAN D-26)`,
      });
    }
    if (typeof body?.nodeEnabled !== 'boolean') {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'nodeEnabled (boolean) is required',
      });
    }

    const client = (req.dbClient ?? this.pool) as PoolClient;
    const loc = await this.outletSetting.find(client, locationId);
    if (!loc) throw new BadRequestException({ code: ERR_NOT_FOUND, message: 'Location not found' });

    // BE-TXN-ROLLBACK: both branches below are real writes on `req.dbClient` — without `withWrite`,
    // `RlsCleanupInterceptor`'s unconditional post-request ROLLBACK silently discarded them (the
    // toggle appeared to succeed in the response, but reverted immediately after). The drain-check
    // throws below happen BEFORE any write in this transaction, so rolling back on them is a no-op.
    return withWrite(client, async () => {
      if (body.nodeEnabled) {
        // ON is just the flag — the setup wizard (a separate ticket's UI) drives actual pairing through
        // the existing `POST /api/nodes/pairing-tokens` -> node `POST /api/nodes/register` flow, now
        // unlocked by `NodesController.mintPairingToken`'s own `nodeEnabled` gate.
        const updated = await this.outletSetting.setEnabled(client, locationId, true);
        const node = await this.branchNodes.findByLocationId(client, locationId);
        return toStateDto(updated!, node, {
          isConnected: node ? this.bridge.isConnected(node.id) : false,
        });
      }

      // OFF — drain-before-off (D-26's core guarantee).
      const node = await this.branchNodes.findByLocationId(client, locationId);
      const nodeIsLive = !!node && node.status !== 'unpaired' && node.status !== 'retired';

      if (nodeIsLive) {
        const drain = drainStatusFor(node!, this.bridge.isConnected(node!.id));

        if (!drain.reachable) {
          throw new BadRequestException({
            code: ERR_NODE_UNREACHABLE,
            message:
              drain.pendingCount === null
                ? 'This node has not reported a queue depth yet — cannot confirm it has drained. Wait for its next heartbeat and try again.'
                : `This node is unreachable right now, so its drain cannot be re-confirmed. Last known: ${drain.pendingCount} event(s) pending as of ${drain.lastReportedAt}. An unreachable node with a possible backlog is never switched off silently — reconnect it first.`,
            details: {
              pendingCount: drain.pendingCount,
              lastReportedAt: drain.lastReportedAt,
              reachable: false,
            },
          });
        }
        if (!drain.ready) {
          throw new BadRequestException({
            code: ERR_NODE_QUEUE_PENDING,
            message: `${drain.pendingCount} event(s) are still queued on this node and have not reached the cloud yet. Turning the node off is refused until it drains to zero.`,
            details: {
              pendingCount: drain.pendingCount,
              lastReportedAt: drain.lastReportedAt,
              reachable: true,
            },
          });
        }

        // Drained and reachable — safe to unpair. Mirrors NodesController.unpair()'s own sequence
        // exactly (same kill-switch, same device fallback to cloud-direct, same audit trail shape).
        await this.branchNodes.unpair(client, node!.id);
        await this.deviceRegistry.insertDeviceEvent(client, {
          nodeId: node!.id,
          locationId,
          type: 'unpaired',
          detail: { reason: 'node_disabled_by_owner' },
        });
        await this.syncEmit.emit(client, {
          entity: 'branch_nodes',
          op: 'revoked',
          entityId: node!.id,
          locationId,
          actorUserId: req.user!.sub,
          data: { reason: 'node_disabled_by_owner' },
        });
        this.bridge.sendRevoked(node!.id);
      }

      const updated = await this.outletSetting.setEnabled(client, locationId, false);
      return toStateDto(updated!, null);
    });
  }
}
