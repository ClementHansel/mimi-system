/**
 * The transport seam — SYNC-PROTOCOL §4.1: "HTTP fallback (same base path,
 * same JSON bodies as the socket messages)". This runtime implements ONLY
 * the HTTP-fallback shape (`http-transport.ts`) against a real upstream, plus
 * an in-memory fake (`fake-cloud.ts`) that speaks the identical interface for
 * every test in this package (W2-D is being built concurrently — see the
 * package report's "what we assumed about W2-D" section).
 *
 * A future socket.io transport (nice-to-have for live push vs. poll-until-
 * has_more) implements this SAME interface — nothing above this seam needs
 * to change to add it.
 */
import type {
  SyncHelloAck,
  SyncHelloRequest,
  SyncPullResult,
  SyncPushAck,
  SyncPushBatch,
} from '@mimi/sync-protocol';

export interface SyncHealth {
  ok: boolean;
  protocolV: number;
  serverTime: string;
  tier: 'cloud' | 'node';
}

export interface HeartbeatPayload {
  deviceId: string;
  at: string;
  appVersion: string;
  queueDepth: number;
  quarantineDepth: number;
  pullLag: number;
  lastSyncAt: string | null;
  /**
   * D-08 — OPTIONAL, so "unknown" is expressible. It used to be required, and
   * the engine satisfied it with a `{usedMb: 0, quotaMb: 0}` stub. The cloud
   * derives `storage_free_mb = quotaMb - usedMb`, so every device in the fleet
   * reported **0 MB free** — indistinguishable from a full disk, and the exact
   * opposite of no data. Omit the field when the platform cannot answer.
   */
  storage?: { usedMb: number; quotaMb: number };
  clockOffsetMs: number;
  batteryPct?: number;
  networkType?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  activeUserId?: string | null;
  shiftOpen?: boolean;
  /**
   * ASSUMPTION (flagged in the package report): CONTRACTS.md's
   * `DeviceHeartbeat` interface (§7.2) does not list a balance-checksum
   * field, but SYNC-PROTOCOL §5.5 R2 says devices "emit `sync.balance_checksum
   * {area_hashes}` telemetry once per day-close." Per §2.3's additive-only
   * rule this rides as an optional extra field on the same heartbeat call
   * rather than a new endpoint neither CONTRACTS.md nor this runtime can
   * invent unilaterally (BUILD-PLAN §6 rule 7: contract changes go through
   * the architect). W2-D should ignore it if unrecognized, per the same rule.
   */
  balanceChecksums?: Record<string, string>;
}

export interface HeartbeatAck {
  ok: true;
  serverTime: string;
  confirmedThrough?: Record<string, number>;
}

export interface SyncTransport {
  health(baseUrl: string): Promise<SyncHealth>;
  hello(baseUrl: string, req: SyncHelloRequest): Promise<SyncHelloAck>;
  push(baseUrl: string, batch: SyncPushBatch): Promise<SyncPushAck>;
  pull(baseUrl: string, cursor: number, limit: number): Promise<SyncPullResult>;
  heartbeat(baseUrl: string, payload: HeartbeatPayload): Promise<HeartbeatAck>;
}
