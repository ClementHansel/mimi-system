/**
 * The `/bridge` wire contract between a branch node and the cloud
 * `node-gateway` (M22) — CONTRACTS.md §4.22, transcribed. This namespace is
 * SEPARATE from `/sync` (M23, `sync-client.ts`/`lan-server.ts`): `/bridge`
 * carries node-specific control-plane traffic (registration, the node's OWN
 * aggregated heartbeat, LAN-discovery reports, remote commands, log pulls);
 * `/sync` carries the append-only event stream (SYNC-PROTOCOL §4), which a
 * node also relays but which is a distinct channel with its own message set.
 *
 * M22 is being built concurrently by another Wave-3 agent (W3-10) who has
 * not seen this file — this IS the contract they must implement. Kept as a
 * plain types module (no I/O) so both `bridge-client.ts` (this app) and any
 * fake-cloud test harness import the exact same shapes.
 */
import type { ISODateTime, UUID } from '@mimi/shared';

// ── POST /api/nodes/register (CONTRACTS §4.22) ────────────────────────────

export interface NodeRegisterRequest {
  token: string; // single-use pairing token (targetType: 'node')
  hostname: string;
  version: string;
  osInfo?: Record<string, unknown>;
}

export interface LanCertWire {
  dnsName: string;
  pem: string;
  keyPem: string;
  expiresAt: ISODateTime;
}

export interface NodeRegisterResponse {
  nodeId: UUID;
  nodeToken: string;
  /**
   * SYNC-PROTOCOL §1.3 — per-node DNS name + DNS-01 cert. Likely `null` at
   * registration time (DNS-01 challenges take real seconds-to-minutes, not
   * something a synchronous HTTP response should block on) and delivered
   * later over the paired `/bridge` socket as `cert_rotated`
   * (`bridge-client.ts`'s `onCertRotated` handler). The node's LAN listener
   * runs plain HTTP until a cert arrives (`lan-server.ts`).
   */
  lanCert: LanCertWire | null;
  config: Record<string, unknown>;
  /** Not in the CONTRACTS.md sketch verbatim but required for the node to know its own scope (SYNC-PROTOCOL §1.5 — device-born events must carry the paired location); the fake-cloud test harness and any real M22 implementation must supply it. */
  location: { id: UUID; code: string; name: string };
}

// ── Socket namespace `/bridge` (node <-> cloud only) ──────────────────────

/** CONTRACTS §7.2 `NodeHeartbeat` — every 30s (BUILD-PLAN D-13). */
export interface NodeHeartbeat {
  nodeId: UUID;
  at: ISODateTime;
  version: string;
  uptimeSec: number;
  /** Device events accepted by this node but not yet cloud-confirmed (the relay outbox, two-level ack §4.3). */
  relayQueueDepth: number;
  /** LAN devices currently connected to this node's `/sync` listener. */
  deviceCount: number;
  deviceSummaries: { deviceId: UUID; lastSeenAt: ISODateTime; queueDepth: number }[];
  discoveryLastRunAt: ISODateTime | null;
  db: { ok: boolean; sizeMb: number };
  system: { cpuPct: number; memPct: number; diskFreePct: number };
  clockOffsetMs: number;
}

/** `discovery:report` — one `discovered_devices` row, node -> cloud (F push, CONTRACTS block 115). */
export interface DiscoveryReportItem {
  ipAddress: string;
  macAddress: string | null;
  source: 'mdns' | 'ssdp' | 'tcp_probe';
  vendor: string | null;
  model: string | null;
  suggestedCategory: string | null;
  suggestedName: string | null;
}

export interface DiscoveryReport {
  nodeId: UUID;
  scannedAt: ISODateTime;
  devices: DiscoveryReportItem[];
}

/** `POST /api/nodes/:id/command` types the cloud may push over the socket. */
export type NodeCommandType = 'restart' | 'update' | 'log_pull' | 'discovery_scan';

export interface NodeCommand {
  commandId: UUID;
  type: NodeCommandType;
  params?: Record<string, unknown>;
}

export interface CommandAck {
  commandId: UUID;
  status: 'accepted' | 'done' | 'failed';
  detail?: string;
}

export interface LogsChunk {
  nodeId: UUID;
  commandId: UUID;
  seq: number;
  done: boolean;
  lines: string[];
}

/** Cloud -> node pushes carried on `/bridge` in addition to `command` (CONTRACTS §1.12 `branch_nodes` pull ops: `cert_rotated`, `config_updated`, `revoked`). */
export interface CertRotated {
  lanCert: LanCertWire;
}

export interface ConfigUpdated {
  config: Record<string, unknown>;
}
