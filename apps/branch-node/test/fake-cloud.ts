/**
 * A stub cloud implementing SYNC-PROTOCOL §4's wire shapes (`/sync`) and
 * CONTRACTS.md §4.22 (`/bridge`), for testing `branch-node` end-to-end
 * without W2-D's/W3-10's real implementations, which are concurrent Wave-2/3
 * work this agent has not seen (BUILD-PLAN W2-F brief: "stub the cloud side
 * ... you must interoperate at G2 without having seen its code").
 *
 * Runs a REAL `http.Server` for `POST /api/nodes/register` (the branch-node's
 * `registerNode()` uses the real global `fetch`, so this needs to be a real
 * listener) and hands out `FakeSocket` pairs for `/bridge` and `/sync` via
 * `socketFactory()`, which `RelayEngine` is constructed with in tests. No
 * `socket.io` server dependency anywhere — see `fake-socket-pair.ts`.
 *
 * Cloud-side semantics implemented for real (not mocked): idempotent event
 * storage, per-origin gapless ordering via the SAME `processOriginBatch`
 * every tier uses, and `acceptedThrough === confirmedThrough` always
 * (SYNC-PROTOCOL §4.3: "the levels coincide" at the cloud, since it IS the
 * confirmation authority).
 *
 * Wire casing: camelCase throughout, matching `@mimi/sync-protocol`'s types
 * (coordinator ruling, G2 interop — `clientSeq` is the one field
 * bigint/string-converted; see `../src/wire.ts`).
 *
 * KNOWN DIVERGENCE FROM THE REAL W2-D CLOUD TODAY (by design, not a bug
 * here): this stub accepts a `sync:push` batch spanning MULTIPLE origins in
 * one call, because that is what a real node legitimately sends (SYNC-
 * PROTOCOL §4.3) and what `RelayEngine.flushOutbox` actually does. W2-D's
 * real engine currently accepts single-origin batches only and would
 * reject that same call — recorded as a Wave-3 gate item for M22
 * (`node-gateway`) to close, not something to weaken in this stub.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  groupByOrigin,
  processOriginBatch,
  sortByClientSeq,
  type SyncEventEnvelope,
} from '@mimi/sync-protocol';
import type { UUID } from '@mimi/shared';
import { createSocketPair, type FakeSocket } from './fake-socket-pair';
import {
  eventFromWire,
  eventToWire,
  helloAckToWire,
  helloFromWire,
  pullResultToWire,
  pushAckToWire,
  pushBatchFromWire,
} from '../src/wire';
import type { SocketFactory } from '../src/socket-like';
import type { NodeRegisterRequest, NodeRegisterResponse } from '../src/bridge-types';

export interface FakeLocation {
  id: UUID;
  code: string;
  name: string;
}

interface StoredCloudEvent extends SyncEventEnvelope {
  serverSeq: number;
}

export class FakeCloud {
  private httpServer?: http.Server;
  private nextTokenId = 1;
  private pendingPairingTokens = new Set<string>();
  private nodesByToken = new Map<string, { nodeId: UUID; locationId: UUID }>();

  private events: StoredCloudEvent[] = [];
  private eventsById = new Map<UUID, StoredCloudEvent>();
  private highWater = new Map<UUID, bigint>();
  private eventIdAtSeq = new Map<string, UUID>();
  private nextServerSeq = 1;

  private bridgeSockets = new Map<UUID, FakeSocket>();
  private syncSockets = new Map<UUID, FakeSocket>();
  private cursors = new Map<UUID, number>();

  public heartbeatsReceived: { nodeId: UUID; payload: unknown }[] = [];
  public discoveryReportsReceived: { nodeId: UUID; payload: unknown }[] = [];
  public commandAcksReceived: unknown[] = [];

  constructor(private location: FakeLocation) {}

  /** Mints a pairing token a test can hand to the node as `BRANCH_NODE_PAIRING_TOKEN`. */
  mintPairingToken(): string {
    const token = `pair-${this.nextTokenId++}-${randomUUID()}`;
    this.pendingPairingTokens.add(token);
    return token;
  }

  async listenHttp(port = 0): Promise<number> {
    this.httpServer = http.createServer((req, res) => void this.routeHttp(req, res));
    await new Promise<void>((resolve) => this.httpServer!.listen(port, resolve));
    const address = this.httpServer.address();
    return typeof address === 'object' && address ? address.port : port;
  }

  async closeHttp(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.httpServer ? this.httpServer.close(() => resolve()) : resolve(),
    );
  }

  private async routeHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'POST' && req.url === '/api/nodes/register') {
      const body = (await readJson(req)) as NodeRegisterRequest;
      if (!this.pendingPairingTokens.has(body.token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_or_expired_token' }));
        return;
      }
      this.pendingPairingTokens.delete(body.token);
      const nodeId = randomUUID() as UUID;
      const nodeToken = `node-token-${randomUUID()}`;
      this.nodesByToken.set(nodeToken, { nodeId, locationId: this.location.id });

      // DNS-01 issuance is async in reality (SYNC-PROTOCOL §1.3) — registration
      // returns null here; a real cloud would deliver it later as `cert_rotated`
      // over `/bridge`. The node's LAN listener runs plain HTTP until then.
      const response: NodeRegisterResponse = {
        nodeId,
        nodeToken,
        lanCert: null,
        config: {},
        location: this.location,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /** The `SocketFactory` to inject into `BridgeClient`/`CloudSyncClient` under test. */
  socketFactory: SocketFactory = (url, opts) => {
    const { client, server } = createSocketPair();
    const nodeEntry = this.nodesByToken.get(opts.auth.token);
    if (!nodeEntry) throw new Error(`FakeCloud: unknown node token presented to ${url}`);

    if (url.endsWith('/bridge')) {
      this.bridgeSockets.set(nodeEntry.nodeId, server);
      this.wireBridgeServer(server, nodeEntry.nodeId);
    } else if (url.endsWith('/sync')) {
      this.syncSockets.set(nodeEntry.nodeId, server);
      this.wireSyncServer(server, nodeEntry.nodeId, nodeEntry.locationId);
    } else {
      throw new Error(`FakeCloud: unexpected namespace ${url}`);
    }
    return client;
  };

  private wireBridgeServer(server: FakeSocket, nodeId: UUID): void {
    server.on('node:heartbeat', (...args) =>
      this.heartbeatsReceived.push({ nodeId, payload: args[0] }),
    );
    server.on('discovery:report', (...args) =>
      this.discoveryReportsReceived.push({ nodeId, payload: args[0] }),
    );
    server.on('command:ack', (...args) => this.commandAcksReceived.push(args[0]));
    server.on('logs:chunk', () => {});
  }

  /** Cloud -> node: push a remote command over `/bridge` (mirrors `POST /api/nodes/:id/command`). */
  sendCommand(nodeId: UUID, command: unknown): void {
    this.bridgeSockets.get(nodeId)?.emit('command', command);
  }

  private wireSyncServer(server: FakeSocket, nodeId: UUID, locationId: UUID): void {
    server.on('sync:hello', (...args) => {
      const req = helloFromWire(args[0] as Record<string, unknown>);
      this.cursors.set(nodeId, req.pullCursor);
      const confirmedThrough: Record<string, number> = {};
      for (const [origin, hw] of this.highWater) confirmedThrough[origin] = Number(hw);
      server.emit(
        'sync:hello:ack',
        helloAckToWire({
          ok: true,
          protocolV: 1,
          serverTime: new Date().toISOString(),
          resumeCursor: req.pullCursor,
          confirmedThrough,
          scope: {
            globalMaster: true,
            locationIds: [locationId],
            projectionRole: 'node',
            excludeOrigin: req.subscriberId,
          },
        }),
      );
    });

    server.on('sync:push', (...args) => {
      const batch = pushBatchFromWire(args[0] as Record<string, unknown>);
      const rejected: { eventId: UUID; code: string; detail: string }[] = [];
      const acceptedThrough: Record<string, number> = {};

      const groups = groupByOrigin(batch.events);
      for (const [originId, list] of groups) {
        const sorted = sortByClientSeq(list);
        const currentHighWater = this.highWater.get(originId) ?? 0n;
        const result = processOriginBatch(sorted, currentHighWater, (seq) =>
          this.eventIdAtSeq.get(`${originId}:${seq}`),
        );
        for (const conflict of result.seqConflicts) {
          rejected.push({
            eventId: conflict.incoming.eventId,
            code: 'seq_conflict',
            detail: 'origin frozen',
          });
        }
        for (const event of result.applied) {
          const stored: StoredCloudEvent = { ...event, serverSeq: this.nextServerSeq++ };
          this.events.push(stored);
          this.eventsById.set(stored.eventId, stored);
          this.eventIdAtSeq.set(`${originId}:${stored.clientSeq}`, stored.eventId);
        }
        if (result.applied.length > 0) this.highWater.set(originId, result.newHighWater);
        acceptedThrough[originId] = Number(this.highWater.get(originId) ?? 0n);
      }

      // Cloud IS the confirmation authority — accepted == confirmed here (§4.3).
      server.emit(
        'sync:push:ack',
        pushAckToWire({
          batchId: batch.batchId,
          acceptedThrough,
          confirmedThrough: acceptedThrough,
          rejected,
        }),
      );
    });

    server.on('sync:pull', (...args) => {
      const { cursor, limit } = args[0] as { cursor: number; limit: number };
      const rest = this.events.filter((e) => e.serverSeq > cursor);
      const page = rest.slice(0, limit);
      const nextCursor = page.length > 0 ? page[page.length - 1]!.serverSeq : cursor;
      server.emit(
        'sync:pull:result',
        pullResultToWire({ events: page, nextCursor, hasMore: rest.length > page.length }),
      );
    });

    server.on('sync:heartbeat', () => {
      /* fire-and-forget, no ack required by the protocol */
    });
  }

  /** Cloud -> node: simulate a live delivery (e.g. a master-data edit) over `/sync`. */
  deliverToNode(nodeId: UUID, events: SyncEventEnvelope[]): void {
    const socket = this.syncSockets.get(nodeId);
    if (!socket) throw new Error(`FakeCloud: no /sync connection for node ${nodeId}`);
    const stored = events.map((e) => ({ ...e, serverSeq: this.nextServerSeq++ }));
    for (const e of stored) {
      this.events.push(e);
      this.eventsById.set(e.eventId, e);
    }
    const nextCursor = stored[stored.length - 1]!.serverSeq;
    socket.emit('sync:deliver', { events: stored.map(eventToWire), nextCursor });
  }

  /** For assertions: the cloud's own canonical event log, decoded to domain shape. */
  getStoredEvents(): SyncEventEnvelope[] {
    return this.events.map((e) => eventFromWire(eventToWire(e)));
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}
