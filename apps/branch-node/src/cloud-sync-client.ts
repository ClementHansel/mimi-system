/**
 * The node's `/sync` link to the cloud sync engine (M23/W2-D) — the node
 * playing the DOWNSTREAM role (SYNC-PROTOCOL §1.2: "downstream: initiates
 * the connection, pushes its origin events, pulls its subscription"). One
 * outbound socket.io connection, `transports: ['polling', 'websocket']`
 * (polling-first per §4.1's "proven AIRE bridge shape" — a branch router's
 * flaky WebSocket upgrade must not cause connect churn).
 *
 * Transport only: this class knows nothing about the relay outbox, the
 * whitelist-apply projector, or LAN fan-out — `relay.ts` owns that. It just
 * turns socket messages into/out of the wire shapes in `./wire`, honouring
 * §4.3's "one outstanding push batch per upstream connection at a time".
 *
 * W2-D (the actual cloud engine) is concurrent and hasn't been seen — this
 * is the client half of the contract W2-D's `/sync` gateway must implement.
 * The message NAMES and wire shapes below are SYNC-PROTOCOL §4 verbatim.
 */
import { io } from 'socket.io-client';
import type { SyncEventEnvelope, SyncHelloAck, SyncHelloRequest, SyncPullResult, SyncPushAck, SyncPushBatch } from '@mimi/sync-protocol';
import type { MinimalSocket, SocketFactory } from './socket-like';
import {
  eventFromWire,
  helloAckFromWire,
  helloToWire,
  pullResultFromWire,
  pushAckFromWire,
  pushBatchToWire,
} from './wire';

export interface CloudSyncClientOptions {
  cloudUrl: string;
  /** This node's own long-lived device credential (SYNC-PROTOCOL §1.5) — the `nodeToken` from registration. */
  nodeToken: string;
  /** Called for every event delivered live (`sync:deliver`) — NOT for pull-page results, which the caller drives explicitly via `pullPage`. */
  onDeliver: (events: SyncEventEnvelope[], nextCursor: number) => void | Promise<void>;
  requestTimeoutMs?: number;
  /** Defaults to the real `socket.io-client` `io()`. Tests inject an in-process fake (`test/fake-socket-pair.ts`) — see `./socket-like`. */
  socketFactory?: SocketFactory;
}

/** Waits for the next occurrence of `event` on `socket`, rejecting after `timeoutMs`. Safe here because §4.3 bounds concurrency to one outstanding request of each kind at a time. */
function waitForEvent<T>(socket: MinimalSocket, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    const handler = (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as T);
    };
    socket.once(event, handler);
  });
}

export class CloudSyncClient {
  private socket: MinimalSocket;
  private requestTimeoutMs: number;

  constructor(private options: CloudSyncClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    const factory = options.socketFactory ?? ((url, opts) => io(url, opts) as unknown as MinimalSocket);
    this.socket = factory(`${options.cloudUrl}/sync`, {
      auth: { token: options.nodeToken },
      reconnection: true,
      transports: ['polling', 'websocket'],
    });
    this.socket.on('sync:deliver', (...args: unknown[]) => {
      const wire = args[0] as { events: unknown[]; nextCursor: number };
      void this.options.onDeliver((wire.events as Record<string, unknown>[]).map(eventFromWire), wire.nextCursor);
    });
  }

  isConnected(): boolean {
    return this.socket.connected;
  }

  async waitUntilConnected(timeoutMs = this.requestTimeoutMs): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out connecting to cloud /sync')), timeoutMs);
      this.socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** §4.2 handshake — must be sent first; nothing else is valid before its ack. */
  async hello(request: SyncHelloRequest): Promise<SyncHelloAck> {
    const ackPromise = waitForEvent<Record<string, unknown>>(this.socket, 'sync:hello:ack', this.requestTimeoutMs);
    this.socket.emit('sync:hello', helloToWire(request));
    return helloAckFromWire(await ackPromise);
  }

  /** §4.3 push — one outstanding batch at a time by construction (the relay loop awaits this before sending the next). */
  async push(batch: SyncPushBatch): Promise<SyncPushAck> {
    const ackPromise = waitForEvent<Record<string, unknown>>(this.socket, 'sync:push:ack', this.requestTimeoutMs);
    this.socket.emit('sync:push', pushBatchToWire(batch));
    return pushAckFromWire(await ackPromise);
  }

  /** §4.5 catch-up pull page. */
  async pullPage(cursor: number, limit: number): Promise<SyncPullResult> {
    const resultPromise = waitForEvent<Record<string, unknown>>(this.socket, 'sync:pull:result', this.requestTimeoutMs);
    this.socket.emit('sync:pull', { cursor, limit });
    return pullResultFromWire(await resultPromise);
  }

  /** §4.6 heartbeat — fire-and-forget, loss-tolerant, not idempotency-tracked. */
  sendHeartbeat(payload: Record<string, unknown>): void {
    this.socket.emit('sync:heartbeat', payload);
  }

  disconnect(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
