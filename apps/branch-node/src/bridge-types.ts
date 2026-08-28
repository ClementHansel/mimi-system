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

export interface NodeCommandParams {
  /** `restart`/`update` only (W3-10 hardening): the caller explicitly accepted firing a destructive
   *  command against an outlet with an open POS shift. `NodesController` is the one that actually
   *  enforces the gate — this flag only travels with the command for the node's own log line. */
  override?: boolean;
  /** `log_pull` only: how many of the most recent buffered log lines to send back (capped server-side
   *  by `LOG_RING_BUFFER_SIZE` regardless of what's requested here). */
  lines?: number;
}

export interface NodeCommand {
  commandId: UUID;
  type: NodeCommandType;
  params?: NodeCommandParams;
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

/**
 * `PUT /api/nodes/:id/network-config` (W3-10), delivered over `/bridge` — never REST, never a sync
 * event — the same "sensitive material rides the node's own authenticated socket only" precedent
 * `CertRotated`'s `pem`/`keyPem` already set. `wifiPassphrase` in particular MUST NEVER be logged,
 * echoed back through any REST response, or included in the `branch_nodes.config_updated` sync event
 * this same PUT also emits for audit history (that event's payload is a separate, secret-free
 * projection built by the controller — see `nodes.controller.ts`).
 *
 * Only `healthPort`/`scanSubnet` are genuinely appliable by this node build — see
 * `network/applier.ts`'s doc comment for exactly why the rest (WiFi SSID/passphrase, static IP,
 * subnet mask, gateway, DNS) are accepted, validated, and stored cloud-side but reported back
 * `applied: false` rather than silently no-opped.
 */
export interface NetworkConfigWire {
  healthPort?: number;
  scanSubnet?: string | null;
  wifiSsid?: string;
  wifiPassphrase?: string;
  staticIp?: string;
  subnetMask?: string;
  gateway?: string;
  dns?: string[];
}

export interface ConfigUpdated {
  /** Correlates this push with the `network_config_ack` this node sends back either way. */
  configId: UUID;
  config: NetworkConfigWire;
}

export interface NetworkConfigAckField {
  field: string;
  applied: boolean;
  /** e.g. `'ok'`, `'unsupported_no_os_network_manager'`, `'reverted_unreachable'`, `'bind_failed'`. */
  reason: string;
}

/** node -> cloud, `network_config_ack` (W3-10) — the apply-then-confirm outcome. `status` is
 *  'applied' only when EVERY appliable field bound successfully and the confirm window passed with
 *  the node still reachable; 'reverted' when it rolled back to `lastKnownGood`; 'failed' only for a
 *  request this node could not even attempt (e.g. every field unsupported). */
export interface NetworkConfigAck {
  configId: UUID;
  nodeId: UUID;
  status: 'applied' | 'reverted' | 'failed';
  fields: NetworkConfigAckField[];
  detail?: string;
}
