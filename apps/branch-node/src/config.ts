/**
 * Runtime configuration for the branch-node agent (Tier 2, D-12/D-13),
 * loaded from env. Env var names match what W1-A already wired in
 * `docker-compose.dev.yml` / `.env.example` — do not rename them.
 */
import os from 'node:os';

export interface NodeConfig {
  /** Cloud backend base URL, e.g. http://backend:4000 or https://app.example.com */
  cloudUrl: string;
  /** Single-use pairing token presented at `/api/nodes/register` (CONTRACTS §4.22). Consumed once; the long-lived node token returned there is what's used afterward. */
  pairingToken: string;
  /** Hardware-free mode: synthetic devices, synthetic heartbeats, in-memory store, no real LAN probing. This is not a demo nicety — CI and every other agent run the node this way (BUILD-PLAN W2-F). */
  simulate: boolean;
  /** Local `/health` + LAN `/sync` HTTP(S) listener port. */
  healthPort: number;
  /**
   * Local Postgres connection string for the node's own embedded DB (SYNC-PROTOCOL
   * §1.1: "Node 22 service + embedded Postgres 16 on the outlet LAN"). When unset
   * (the default in SIMULATE mode and in the current docker-compose — no branch-node
   * Postgres container is wired yet, see report follow-up), the node falls back to
   * an in-memory store with the identical interface. Production installs (W5-07
   * packaging) must supply this.
   */
  databaseUrl: string | undefined;
  /** Explicit LAN subnet to scan, e.g. "192.168.1.0/24"; auto-derived from local interfaces when unset. */
  scanSubnet: string | undefined;
  /** How often the node re-runs LAN discovery (mDNS/SSDP/TCP probe). */
  discoveryIntervalMs: number;
  /** node -> cloud heartbeat cadence. CONTRACTS §7.3: 30s for a branch node. */
  heartbeatIntervalMs: number;
  /** This node software's own version string, reported at register/heartbeat (D-13). */
  version: string;
  hostname: string;
  /**
   * W3-10: how long, after applying a cloud-pushed network-config change, this node waits for proof
   * it can still be reached before automatically reverting to its last-known-good config (the
   * apply-then-confirm safety mechanism — see `relay.ts`'s `handleNetworkConfigUpdate`). Kept
   * configurable (rather than a hardcoded constant) so tests can shrink it to milliseconds instead of
   * waiting out a real 90s window.
   */
  networkConfigConfirmTimeoutMs: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const simulate = parseBool(env.SIMULATE, false);

  return {
    cloudUrl: env.BRANCH_NODE_CLOUD_URL || 'http://localhost:4000',
    pairingToken: env.BRANCH_NODE_PAIRING_TOKEN || (simulate ? 'simulate-token' : ''),
    simulate,
    healthPort: parseIntEnv(env.BRANCH_NODE_HEALTH_PORT, 4010),
    databaseUrl: env.BRANCH_NODE_DATABASE_URL || undefined,
    scanSubnet: env.BRANCH_NODE_SCAN_SUBNET || undefined,
    discoveryIntervalMs: parseIntEnv(env.BRANCH_NODE_DISCOVERY_INTERVAL_MS, 5 * 60 * 1000),
    heartbeatIntervalMs: parseIntEnv(env.BRANCH_NODE_HEARTBEAT_INTERVAL_MS, 30_000),
    version: env.BRANCH_NODE_VERSION || process.env.npm_package_version || '0.1.0',
    hostname: env.BRANCH_NODE_HOSTNAME || os.hostname(),
    networkConfigConfirmTimeoutMs: parseIntEnv(
      env.BRANCH_NODE_NETWORK_CONFIG_CONFIRM_TIMEOUT_MS,
      90_000,
    ),
  };
}
