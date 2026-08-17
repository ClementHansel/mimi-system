/**
 * The relay engine — wires together everything else in this app per D-12
 * ("one protocol, any adjacent tier pair") and SYNC-PROTOCOL §1.4 (store,
 * forward, and selectively apply). The node plays BOTH roles at once:
 *
 *  - DOWNSTREAM toward the cloud (`CloudSyncClient`, `BridgeClient`): sends
 *    `sync:hello`, drains its relay outbox via `sync:push`, catches up via
 *    `sync:pull`, and applies whatever the cloud delivers.
 *  - UPSTREAM toward its LAN devices (`LanServer`'s HTTP handlers): accepts
 *    their pushes (enforcing §3.4's "1-lite + 3" — envelope well-formed and
 *    location match, nothing more — everything else is the cloud's), serves
 *    their pulls from this node's own log, and reports discovery + heartbeat.
 *
 * Two-level ack (§4.3): `getHighWater`/`setHighWater` is this node's own
 * "accepted" watermark (what it tells ITS downstreams); the separate
 * `getCloudConfirmedHighWater`/`setCloudConfirmedHighWater` is what the
 * CLOUD has confirmed, learned only from the cloud's own push acks — the
 * node relays that number onward on every subsequent ack/hello, exactly as
 * §4.3 requires.
 *
 * **MULTI-ORIGIN PUSH — a real gap on the cloud side today (G2 interop
 * finding, recorded as a Wave-3 gate item for M22 `node-gateway`, not fixed
 * here).** `flushOutbox` below (see `sortForRelay`) deliberately batches
 * events from EVERY origin this node has accepted — its own discovery/
 * telemetry events (`originTier: 'node'`) plus every LAN device's events
 * (`originTier: 'device'`, one `originDeviceId` per physical device) — into
 * one `sync:push`/`POST /sync/v1/push` call, because relaying on behalf of
 * many devices under one connection is D-12/D-13's entire reason for a
 * node to exist (SYNC-PROTOCOL §4.3: "A batch may carry events from
 * multiple origins (a node relays all its devices)"). W2-D's cloud engine
 * currently accepts single-origin batches only (rejects any event whose
 * `originDeviceId` isn't the authenticated connection's own device) — so
 * real multi-device outlet traffic relayed through a node is rejected
 * today. **W3-10 building M22 needs to authenticate the CONNECTION as the
 * node (via its `nodeToken`) while authorizing each EVENT independently by
 * its own `originDeviceId` + `locationId`** (verified against the
 * `devices` registry, same as if that device had pushed directly) —
 * distinct from a device connection, where connection identity and event
 * origin are the same thing and can be checked together.
 *
 * **R2 checksum telemetry (`sync:checksum`, W2-D's naming)** is NOT
 * implemented by this node — no `sync.balance_checksum`/`sync:checksum`
 * emission exists here yet (out of this skeleton's Wave-2 scope). Whoever
 * adds it should use the socket message name `sync:checksum` to match
 * W2-D's cloud engine, not SYNC-PROTOCOL.md's prose spelling
 * (`sync.balance_checksum`) — same naming-reconciliation lesson as the
 * wire-casing fix above.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import {
  AUTHORITY,
  groupByOrigin,
  processOriginBatch,
  assembleBatches,
  sortByClientSeq,
  formatUuidV7,
  type SyncEventEnvelope,
  type SyncHelloAck,
  type SyncPushBatch,
} from '@mimi/sync-protocol';
import type { UUID } from '@mimi/shared';
import type { NodeConfig } from './config';
import type { Store, StoredSyncEvent } from './store/types';
import { BridgeClient, registerNode } from './bridge-client';
import { CloudSyncClient } from './cloud-sync-client';
import { LanServer, type HandlerResult, type LanServerHandlers } from './lan-server';
import { applyWhitelistedEvent } from './projector';
import { runScan } from './discovery/scanner';
import type { NodeHeartbeat, NodeCommand, DiscoveryReport } from './bridge-types';
import type { SocketFactory } from './socket-like';
import { helloAckToWire, helloFromWire, pullResultToWire, pushAckToWire, pushBatchFromWire } from './wire';

const MAX_PULL_PAGE = 500;

interface ReadyIdentity {
  nodeId: UUID;
  nodeToken: string;
  locationId: UUID;
}

export class RelayEngine {
  private bridge?: BridgeClient;
  private cloudSync?: CloudSyncClient;
  private lanServer?: LanServer;
  private heartbeatTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;
  private pushTimer?: NodeJS.Timeout;
  private pushing = false;
  private startedAt = Date.now();
  private discoveryLastRunAt: string | null = null;
  private identity?: ReadyIdentity;

  constructor(
    private config: NodeConfig,
    private store: Store,
    private socketFactory?: SocketFactory,
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────
  async start(): Promise<void> {
    this.identity = await this.ensureRegistered();

    this.bridge = new BridgeClient(
      this.config.cloudUrl,
      this.identity.nodeToken,
      {
        onCommand: (cmd) => this.handleCommand(cmd),
        onCertRotated: async (payload) => {
          const current = await this.store.getIdentity();
          await this.store.saveIdentity({ ...current, lanCert: payload.lanCert });
          if (this.lanServer) await this.lanServer.rotateCert(payload.lanCert, this.config.healthPort);
        },
        onRevoked: () => console.warn('[relay] node revoked by cloud — stop pushing (M22 kill switch)'),
      },
      this.socketFactory,
    );

    this.cloudSync = new CloudSyncClient({
      cloudUrl: this.config.cloudUrl,
      nodeToken: this.identity.nodeToken,
      onDeliver: (events, nextCursor) => this.applyDeliveredEvents(events, nextCursor),
      socketFactory: this.socketFactory,
    });

    await this.cloudSync.waitUntilConnected();
    await this.helloAndCatchUp(this.identity);

    const identitySnapshot = await this.store.getIdentity();
    this.lanServer = new LanServer(this.buildLanHandlers(this.identity), identitySnapshot.lanCert);
    await this.lanServer.listen(this.config.healthPort);

    this.startHeartbeatLoop(this.identity);
    this.startPushLoop();
    this.startDiscoveryLoop(this.identity);
  }

  /** The LAN listener's actual bound port (useful when `config.healthPort === 0` let the OS pick one — tests). */
  getLanServerPort(): number | undefined {
    return this.lanServer?.address()?.port ?? undefined;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    await this.lanServer?.close();
    this.cloudSync?.disconnect();
    this.bridge?.disconnect();
    await this.store.close();
  }

  // ── registration (CONTRACTS §4.22) ───────────────────────────────────
  private async ensureRegistered(): Promise<ReadyIdentity> {
    const existing = await this.store.getIdentity();
    if (existing.nodeId && existing.nodeToken && existing.locationId) {
      return { nodeId: existing.nodeId, nodeToken: existing.nodeToken, locationId: existing.locationId };
    }

    const response = await registerNode(this.config.cloudUrl, {
      token: this.config.pairingToken,
      hostname: this.config.hostname,
      version: this.config.version,
    });

    await this.store.saveIdentity({
      nodeId: response.nodeId,
      nodeToken: response.nodeToken,
      locationId: response.location.id,
      locationCode: response.location.code,
      locationName: response.location.name,
      lanCert: response.lanCert ?? null,
    });

    return { nodeId: response.nodeId, nodeToken: response.nodeToken, locationId: response.location.id };
  }

  // ── downstream toward cloud: hello + catch-up pull ───────────────────
  private async helloAndCatchUp(identity: ReadyIdentity): Promise<void> {
    const outboxDepth = (await this.store.getUnconfirmedByCloud(100_000)).length;
    const cursor = await this.store.getCursor(identity.nodeId, 'cloud');

    const ack: SyncHelloAck = await this.cloudSync!.hello({
      protocolV: 1,
      subscriberId: identity.nodeId,
      subscriberTier: 'node',
      locationIds: [identity.locationId],
      pullCursor: cursor,
      outboxDepth,
      appVersion: this.config.version,
      deviceTime: new Date().toISOString(),
    });

    for (const [originId, seq] of Object.entries(ack.confirmedThrough)) {
      await this.store.setCloudConfirmedHighWater(originId as UUID, BigInt(seq));
    }

    let nextCursor = ack.resumeCursor;
    await this.store.setCursor(identity.nodeId, nextCursor, 'cloud');

    let hasMore = true;
    while (hasMore) {
      const page = await this.cloudSync!.pullPage(nextCursor, MAX_PULL_PAGE);
      await this.applyDeliveredEvents(page.events, page.nextCursor);
      nextCursor = page.nextCursor;
      hasMore = page.hasMore;
    }
  }

  private async applyDeliveredEvents(events: SyncEventEnvelope[], nextCursor: number): Promise<void> {
    for (const event of events) {
      const relayReceivedAt = event.relayReceivedAt ?? event.receivedAt ?? event.occurredAt;
      const stored = await this.store.appendEvent({ ...event, relayReceivedAt });
      await applyWhitelistedEvent(this.store, stored);
    }
    if (this.identity) await this.store.setCursor(this.identity.nodeId, nextCursor, 'cloud');
  }

  // ── downstream toward cloud: push loop (the relay outbox) ────────────
  private startPushLoop(): void {
    const tick = () => void this.flushOutbox();
    tick();
    this.pushTimer = setInterval(tick, 2000);
  }

  /** Exposed for tests that want to force-drain the outbox without waiting on the interval. */
  async flushOutbox(): Promise<void> {
    if (this.pushing || !this.cloudSync?.isConnected()) return;
    this.pushing = true;
    try {
      for (;;) {
        const pending = await this.store.getUnconfirmedByCloud(200);
        if (pending.length === 0) return;

        const sorted = sortForRelay(pending);
        // `assembleBatches`'s default size estimator does a plain `JSON.stringify`, which throws on
        // our envelope's `clientSeq: bigint` — supply a BigInt-safe estimator instead.
        for (const batchEvents of assembleBatches(sorted, estimateEnvelopeBytes)) {
          const batch: SyncPushBatch = {
            batchId: formatUuidV7(Date.now(), randomBytes(10)),
            sentAt: new Date().toISOString(),
            events: batchEvents,
          };
          try {
            const ack = await this.cloudSync!.push(batch);
            for (const [originId, seq] of Object.entries(ack.confirmedThrough)) {
              await this.store.setCloudConfirmedHighWater(originId as UUID, BigInt(seq));
            }
            for (const rejected of ack.rejected) {
              const original = batchEvents.find((e) => e.eventId === rejected.eventId);
              if (original) {
                // §4.4: "Rejected != lost" — a permanent reject still advances confirmed_through (it's dead, not missing).
                await this.store.setCloudConfirmedHighWater(original.originDeviceId, original.clientSeq);
              }
              console.warn(`[relay] event ${rejected.eventId} permanently rejected by cloud: ${rejected.code} ${rejected.detail ?? ''}`);
            }
            if (ack.resendFrom) {
              // Diagnostic only: `confirmedThrough` already governs `getUnconfirmedByCloud`'s next
              // read, so the origin's un-relayed events resend automatically on the next loop
              // iteration without needing to branch on this — logged purely for operator visibility.
              console.warn('[relay] cloud reports a sequence gap (self-healing on next cycle):', ack.resendFrom);
            }
          } catch (err) {
            console.error('[relay] push to cloud failed, retrying next cycle:', (err as Error).message);
            return;
          }
        }
      }
    } finally {
      this.pushing = false;
    }
  }

  // ── upstream toward LAN devices ───────────────────────────────────────
  private buildLanHandlers(identity: ReadyIdentity): LanServerHandlers {
    return {
      nodeHealth: () => this.handleNodeHealth(identity),
      syncHealth: () => ({ status: 200, body: { ok: true, protocolV: 1, serverTime: new Date().toISOString(), tier: 'node' } }),
      hello: (body) => this.handleDeviceHello(body, identity),
      push: (body) => this.handleDevicePush(body, identity),
      pull: (cursor, limit) => this.handleDevicePull(cursor, limit),
      bootstrap: (body) => this.handleDeviceBootstrap(body, identity),
    };
  }

  private async handleNodeHealth(identity: ReadyIdentity): Promise<HandlerResult> {
    const lanDevices = await this.store.listLanDevices();
    return {
      status: 200,
      body: {
        status: this.cloudSync?.isConnected() ? 'ok' : 'degraded',
        service: 'branch-node',
        simulate: this.config.simulate,
        nodeId: identity.nodeId,
        locationId: identity.locationId,
        cloudConnected: this.cloudSync?.isConnected() ?? false,
        lanDeviceCount: lanDevices.length,
        discoveryLastRunAt: this.discoveryLastRunAt,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      },
    };
  }

  private async handleDeviceHello(body: unknown, identity: ReadyIdentity): Promise<HandlerResult> {
    const req = helloFromWire(body as Record<string, unknown>);

    // §3.4 rule 3 (the only authority check a node makes — "1-lite + location match").
    if (!req.locationIds.includes(identity.locationId)) {
      return { status: 200, body: { ok: false, error: 'authority_violation', detail: 'location_ids does not include this node\'s paired location' } };
    }

    const confirmedThrough: Record<string, number> = {
      [req.subscriberId]: Number(await this.store.getCloudConfirmedHighWater(req.subscriberId)),
    };
    const maxServerSeq = await this.store.getMaxServerSeq();
    const ack: SyncHelloAck = {
      ok: true,
      protocolV: 1,
      serverTime: new Date().toISOString(),
      // The device's own claimed cursor is authoritative UNLESS it claims to be ahead of what this node
      // actually has (a fresh/rebuilt node, or a device that previously synced against a different node) —
      // in that case fall back to 0, which forces the device through a fresh bootstrap.
      resumeCursor: req.pullCursor <= maxServerSeq ? req.pullCursor : 0,
      confirmedThrough,
      scope: {
        globalMaster: true,
        locationIds: [identity.locationId],
        projectionRole: req.subscriberTier === 'node' ? 'node' : 'pos_device',
        excludeOrigin: req.subscriberId,
      },
    };
    return { status: 200, body: helloAckToWire(ack) };
  }

  private async handleDevicePush(body: unknown, identity: ReadyIdentity): Promise<HandlerResult> {
    const batch = pushBatchFromWire(body as Record<string, unknown>);
    const rejected: { eventId: UUID; code: string; detail: string }[] = [];
    const validEvents: SyncEventEnvelope[] = [];

    for (const event of batch.events) {
      // §3.4's own summary is deliberately narrow: "Nodes enforce only 1-lite (envelope well-formed)
      // and 3 (location match) — everything else is cloud's, so a compromised node can never widen
      // authority." That excludes rule 2 (canOriginate/direction legality) and the AUTHORITY-matrix
      // entity/op vocabulary check on purpose: this node's `@mimi/sync-protocol` copy can legitimately
      // lag the cloud's (fleet update lag is an acknowledged scenario, D-13/W5-07), and a node that
      // rejected on those grounds could wrongly block a newly-authorized (entity, op) locally before
      // the cloud — the only party guaranteed up to date — ever saw it. Only structural envelope
      // validity (rule "1-lite") and location match (rule 3) are checked here.
      if (!isWellFormedEnvelope(event)) {
        rejected.push({ eventId: event.eventId, code: 'malformed', detail: 'envelope missing or malformed required field(s)' });
        continue;
      }
      if (event.locationId !== identity.locationId) {
        rejected.push({ eventId: event.eventId, code: 'authority_violation', detail: "location_id does not match this node's paired location" });
        continue;
      }
      validEvents.push(event);
    }

    const acceptedThrough: Record<string, number> = {};
    const confirmedThrough: Record<string, number> = {};
    const resendFrom: Record<string, number> = {};
    const groups = groupByOrigin(validEvents);

    for (const [originId, list] of groups) {
      const sorted = sortByClientSeq(list);
      const currentHighWater = await this.store.getHighWater(originId);

      const knownAtSeq = new Map<string, UUID>();
      for (const e of sorted) {
        if (e.clientSeq <= currentHighWater) {
          const known = await this.store.eventIdAtOriginSeq(originId, e.clientSeq);
          if (known) knownAtSeq.set(e.clientSeq.toString(), known);
        }
      }

      const result = processOriginBatch(sorted, currentHighWater, (seq) => knownAtSeq.get(seq.toString()));

      for (const conflict of result.seqConflicts) {
        rejected.push({
          eventId: conflict.incoming.eventId,
          code: 'seq_conflict',
          detail: `client_seq ${conflict.conflictsWithSeq} already used by a different event for this origin`,
        });
      }

      const now = new Date().toISOString();
      for (const event of result.applied) {
        const stored = await this.store.appendEvent({ ...event, relayReceivedAt: now });
        await applyWhitelistedEvent(this.store, stored);
      }
      if (result.applied.length > 0) await this.store.setHighWater(originId, result.newHighWater);
      if (result.gapAt !== undefined) resendFrom[originId] = Number(result.gapAt);

      acceptedThrough[originId] = Number(await this.store.getHighWater(originId));
      confirmedThrough[originId] = Number(await this.store.getCloudConfirmedHighWater(originId));
    }

    // New events landed — relay them onward without waiting for the next timer tick.
    if (groups.size > 0) void this.flushOutbox();

    return {
      status: 200,
      body: pushAckToWire({
        batchId: batch.batchId,
        acceptedThrough,
        confirmedThrough,
        rejected,
        resendFrom: Object.keys(resendFrom).length > 0 ? resendFrom : undefined,
      }),
    };
  }

  private async handleDevicePull(cursor: number, limit: number): Promise<HandlerResult> {
    const page = await this.store.getEventsSince(cursor, Math.min(limit, MAX_PULL_PAGE));
    return {
      status: 200,
      body: pullResultToWire({ events: page.events, nextCursor: page.nextCursor, hasMore: page.hasMore }),
    };
  }

  /**
   * Simplified single-page bootstrap (§4.6): a snapshot of this node's
   * master-data cache + whitelisted projections for the requester's scope,
   * plus the `startingCursor` to resume incremental pulls from. The full
   * spec allows CHUNKED, resumable pages for large snapshots; this skeleton
   * returns one page always (`done: true`) — fine at Wave-2 data volumes,
   * flagged as a follow-up for W2-E interop testing at real device-fleet scale.
   */
  private async handleDeviceBootstrap(_body: unknown, identity: ReadyIdentity): Promise<HandlerResult> {
    const masterEntities = Object.entries(AUTHORITY)
      .filter(([, meta]) => meta.class === 'M')
      .map(([name]) => name);
    const masterData: Record<string, unknown[]> = {};
    for (const entity of masterEntities) {
      masterData[entity] = (await this.store.listMasterData(entity)).map((r) => r.payload);
    }

    const projectionEntities = ['sales', 'pos_shifts', 'void_refunds', 'online_orders', 'sj_drops', 'goods_receipts', 'waste_records', 'stock_opname', 'stock_adjustments', 'replenishment_requests', 'attendance', 'returns'];
    const projections: Record<string, unknown[]> = {};
    for (const entity of projectionEntities) {
      projections[entity] = (await this.store.listProjections(entity, identity.locationId)).map((r) => r.payload);
    }

    return {
      status: 200,
      body: {
        startingCursor: await this.store.getMaxServerSeq(),
        done: true,
        snapshot: { masterData, projections },
      },
    };
  }

  // ── heartbeat (§7.3: 30s cadence) ─────────────────────────────────────
  private startHeartbeatLoop(identity: ReadyIdentity): void {
    const send = async () => {
      const lanDevices = await this.store.listLanDevices();
      const relayQueueDepth = (await this.store.getUnconfirmedByCloud(100_000)).length;
      const cpuCount = os.cpus().length || 1;
      const loadAvg = os.loadavg()[0] ?? 0;
      const freeMem = os.freemem();
      const totalMem = os.totalmem();

      const nodeHeartbeat: NodeHeartbeat = {
        nodeId: identity.nodeId,
        at: new Date().toISOString(),
        version: this.config.version,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        relayQueueDepth,
        deviceCount: lanDevices.length,
        deviceSummaries: lanDevices.map((d) => ({ deviceId: d.deviceId, lastSeenAt: d.lastSeenAt ?? new Date(0).toISOString(), queueDepth: d.queueDepth })),
        discoveryLastRunAt: this.discoveryLastRunAt,
        db: { ok: true, sizeMb: 0 }, // real size query is a W5-07 hardening item (needs pg_database_size against the real embedded PG, not meaningful for MemoryStore)
        system: {
          cpuPct: Math.min(100, Math.round((loadAvg / cpuCount) * 100)),
          memPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
          diskFreePct: 100, // no disk-free API without a new dependency (flagged in the report)
        },
        clockOffsetMs: 0,
      };
      this.bridge?.sendHeartbeat(nodeHeartbeat);
      // Same camelCase convention as `/sync`'s event/hello/push/pull wire (coordinator ruling, G2 interop).
      this.cloudSync?.sendHeartbeat({
        ts: nodeHeartbeat.at,
        outboxDepth: relayQueueDepth,
        quarantineDepth: 0,
        pullLag: 0,
        storage: { used: 0, quota: 0 },
        clockOffsetMs: 0,
        appVersion: this.config.version,
      });
    };
    void send();
    this.heartbeatTimer = setInterval(() => void send(), this.config.heartbeatIntervalMs);
  }

  // ── LAN discovery (D-13) ──────────────────────────────────────────────
  private startDiscoveryLoop(identity: ReadyIdentity): void {
    const run = async () => {
      const outcome = await runScan({ simulate: this.config.simulate, subnet: this.config.scanSubnet });
      const stillPresentIds: UUID[] = [];
      for (const d of outcome.devices) {
        const row = await this.store.upsertDiscoveredDevice({
          source: d.source,
          ipAddress: d.ipAddress,
          macAddress: d.macAddress,
          vendor: d.vendor,
          model: d.model,
          suggestedCategory: d.deviceType === 'unknown' ? null : d.deviceType,
          suggestedName: d.model ?? d.deviceType,
          raw: d.connectionParams,
        });
        stillPresentIds.push(row.id);
      }
      await this.store.markMissingAsDisappeared(stillPresentIds);
      this.discoveryLastRunAt = new Date().toISOString();

      const report: DiscoveryReport = {
        nodeId: identity.nodeId,
        scannedAt: this.discoveryLastRunAt,
        devices: outcome.devices.map((d) => ({
          ipAddress: d.ipAddress,
          macAddress: d.macAddress,
          source: d.source,
          vendor: d.vendor,
          model: d.model,
          suggestedCategory: d.deviceType === 'unknown' ? null : d.deviceType,
          suggestedName: d.model ?? d.deviceType,
        })),
      };
      this.bridge?.sendDiscoveryReport(report);
    };
    void run();
    this.discoveryTimer = setInterval(() => void run(), this.config.discoveryIntervalMs);
  }

  private async handleCommand(cmd: NodeCommand): Promise<void> {
    // Fleet remote-command channel (D-13, W5-07 "hardening" territory — restart/update/log_pull/discovery_scan).
    // This skeleton acks every command as 'done' immediately without doing anything destructive (no self-restart,
    // no self-update, no log tailing yet); W5-07 owns turning these into real actions.
    if (cmd.type === 'discovery_scan') {
      // The one command type safe + meaningful to actually honor right now: run discovery early.
      const outcome = await runScan({ simulate: this.config.simulate, subnet: this.config.scanSubnet });
      this.discoveryLastRunAt = new Date().toISOString();
      this.bridge?.ackCommand({ commandId: cmd.commandId, status: 'done', detail: `${outcome.devices.length} device(s) found` });
      return;
    }
    this.bridge?.ackCommand({ commandId: cmd.commandId, status: 'done', detail: `${cmd.type} acknowledged (no-op in this skeleton — see W5-07)` });
  }
}

/** Rule "1-lite" (§3.4): purely structural — every field the ordering/idempotency machinery (§2.1/§2.2) needs must be present and of the right basic shape. Says nothing about whether the (entity, op) is a legitimate business fact — that is the cloud's call alone. */
function isWellFormedEnvelope(event: SyncEventEnvelope): boolean {
  return (
    typeof event.eventId === 'string' &&
    event.eventId.length > 0 &&
    (event.originTier === 'device' || event.originTier === 'node' || event.originTier === 'cloud') &&
    typeof event.originDeviceId === 'string' &&
    event.originDeviceId.length > 0 &&
    typeof event.entity === 'string' &&
    event.entity.length > 0 &&
    typeof event.entityId === 'string' &&
    event.entityId.length > 0 &&
    typeof event.op === 'string' &&
    event.op.length > 0 &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    typeof event.clientSeq === 'bigint' &&
    event.clientSeq > 0n &&
    typeof event.occurredAt === 'string' &&
    typeof event.actorUserId === 'string' &&
    event.actorUserId.length > 0
  );
}

/** BigInt-safe stand-in for `assembleBatches`'s default `JSON.stringify`-based size estimator (the envelope's `clientSeq` is a `bigint`, which the native serializer rejects). */
function estimateEnvelopeBytes(event: SyncEventEnvelope): number {
  return JSON.stringify(event, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)).length;
}

/** Groups events by origin then concatenates each origin's own ascending run — a valid ordering per §4.3 ("each origin's events in ascending client_seq"); cross-origin interleaving within/between batches is unconstrained. */
function sortForRelay(events: readonly StoredSyncEvent[]): SyncEventEnvelope[] {
  const groups = groupByOrigin(events);
  const out: SyncEventEnvelope[] = [];
  for (const [, list] of groups) out.push(...sortByClientSeq(list));
  return out;
}
