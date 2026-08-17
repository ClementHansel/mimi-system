/**
 * An in-process socket pair satisfying `MinimalSocket` on both ends —
 * `cloud-sync-client.ts` / `bridge-client.ts` accept a `SocketFactory`
 * precisely so tests can inject this instead of a real `socket.io-client`
 * connection. No real network, no `socket.io` server dependency (which
 * isn't in this app's approved manifest — see the report), and it drives
 * the REAL production code paths (wire encode/decode, request/ack
 * sequencing) end-to-end.
 *
 * `.emit(event, ...args)` on one side asynchronously (via `queueMicrotask`,
 * so ordering matches real network latency semantics — never synchronous
 * re-entrancy) delivers to the OTHER side's `.on`/`.once` listeners.
 */
import { EventEmitter } from 'node:events';
import type { MinimalSocket } from '../src/socket-like';

export class FakeSocket implements MinimalSocket {
  connected = false;
  peer!: FakeSocket;
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(event, listener);
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.once(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.off(event, listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  /** Production code calling `socket.emit(...)` means "send this to the other side". */
  emit(event: string, ...args: unknown[]): void {
    queueMicrotask(() => this.peer.receive(event, args));
  }

  /** Internal: deliver an event as if it just arrived from the peer. */
  receive(event: string, args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.receive('disconnect', ['io client disconnect']);
    queueMicrotask(() => {
      if (this.peer.connected) {
        this.peer.connected = false;
        this.peer.receive('disconnect', ['io server disconnect']);
      }
    });
  }
}

export function createSocketPair(): { client: FakeSocket; server: FakeSocket } {
  const client = new FakeSocket();
  const server = new FakeSocket();
  client.peer = server;
  server.peer = client;
  queueMicrotask(() => {
    client.connected = true;
    server.connected = true;
    client.receive('connect', []);
    server.receive('connect', []);
  });
  return { client, server };
}
