/**
 * D-26's per-outlet node-enabled setting/pairing flow, PLUS (W3-10) the real
 * remote write path for a branch node's own network settings and remote
 * commands — the two gaps a previous agent correctly found missing and
 * declined to build UI for (see that ticket's report note, preserved below
 * for context).
 *
 * ORIGINAL NOTE (still true for the fields it names): WiFi SSID/passphrase
 * and static-IP/subnet/gateway/DNS are accepted and validated by
 * `PUT /nodes/:id/network-config` and stored server-side, but this Node.js
 * build has no host-level network-management capability to actually apply
 * them (see `apps/branch-node/src/network/applier.ts`'s doc comment) — the
 * node's own ack reports those fields `applied: false`. Per the same "don't
 * build a UI that lies about what it does" instruction, THIS module exposes
 * them (a future OS-integration build has real data to work with the moment
 * it exists) but `NodeSettingModal.tsx` only surfaces controls for the two
 * fields that are genuinely, verifiably applied today: `healthPort` and
 * `scanSubnet`.
 */
import { api } from '@/lib/api';
import type { UUID, ISODateTime } from '@/lib/shared-types';
import type { MintedPairingToken } from './device-api';

export interface NodeNetworkConfig {
  healthPort?: number;
  scanSubnet?: string | null;
  wifiSsid?: string;
  wifiPassphraseSet?: boolean;
  staticIp?: string;
  subnetMask?: string;
  gateway?: string;
  dns?: string[];
}

export interface NodeNetworkConfigFieldResult {
  field: string;
  applied: boolean;
  reason: string;
}

export type NodeNetworkConfigStatus = 'none' | 'pending' | 'applied' | 'reverted' | 'failed';

export interface NodeDetail {
  id: UUID;
  locationId: UUID;
  locationName: string;
  name: string;
  status: string;
  version: string | null;
  ipAddress: string | null;
  lastSeenAt: ISODateTime | null;
  deviceCount: number;
  relayQueueDepth: number;
  networkConfig: NodeNetworkConfig;
  networkConfigStatus: NodeNetworkConfigStatus;
  networkConfigResult: { fields?: NodeNetworkConfigFieldResult[]; detail?: string };
  discoveredNewCount: number;
  isConnected: boolean;
  events: { type: string; detail: unknown; created_at: ISODateTime }[];
}

/** `GET /nodes/:id` — fetched fresh whenever the settings modal opens rather than relying on the
 *  topology tree's cached `location.node` summary, since network-config status changes live
 *  (apply-then-confirm) on a timescale the tree's own poll cadence won't reliably catch. */
export function getNodeDetail(nodeId: UUID) {
  return api.get<NodeDetail>(`/nodes/${nodeId}`);
}

/**
 * `PUT /nodes/:id/network-config` (W3-10). ONLY `healthPort`/`scanSubnet` are wired up in the UI —
 * see this file's own doc comment for why the rest are typed here but not exposed as a form field.
 * Server-side validates BEFORE anything reaches the node (`ERR_VALIDATION`) and refuses against a
 * disconnected node (`ERR_NODE_UNREACHABLE`) — both rendered as-is via `ApiError.message`, same
 * "let the server be the authority" stance `setOutletNodeEnabled` already takes.
 */
export function setNodeNetworkConfig(
  nodeId: UUID,
  patch: { healthPort?: number; scanSubnet?: string | null },
) {
  return api.put<{ configId: UUID; networkConfig: NodeNetworkConfig; networkConfigStatus: string }>(
    `/nodes/${nodeId}/network-config`,
    patch,
  );
}

export type NodeCommandType = 'restart' | 'log_pull' | 'discovery_scan' | 'update';

/**
 * `POST /nodes/:id/command`. `restart` is destructive to a live outlet — the backend refuses it
 * (400, `ERR_NODE_SHIFT_OPEN`) while the outlet has an open POS shift unless `params.override: true`
 * is passed; the caller here is `NodeSettingModal`'s confirm-then-override flow, not this function.
 * `update` is intentionally not called from any UI control today — see this file's doc comment;
 * the type stays exported so a future caller (or a test) has it available honestly rather than
 * needing to hand-roll the literal string.
 */
export function sendNodeCommand(
  nodeId: UUID,
  type: NodeCommandType,
  params?: { override?: boolean; lines?: number },
) {
  return api.post<{ commandId: UUID; status: 'sent' }>(`/nodes/${nodeId}/command`, {
    type,
    params,
  });
}

export interface OutletNodeSettingState {
  locationId: UUID;
  locationCode: string;
  locationName: string;
  nodeEnabled: boolean;
  node: {
    id: UUID;
    status: string;
    version: string | null;
    lastSeenAt: ISODateTime | null;
    pairedAt: ISODateTime | null;
    isConnected: boolean;
  } | null;
}

/**
 * Owner-only server-side (`OutletNodeSettingController.setEnabled` checks
 * `req.user.roleKey === 'owner'` on top of the `node.manage` permission
 * decorator — D-26's explicit ruling, not just an RBAC row) — gate the UI
 * trigger on `roleKey === 'owner'`, not merely `can('node.manage')`.
 *
 * Turning OFF a node that is still live is drain-before-off: the backend
 * refuses (400, `ERR_NODE_QUEUE_PENDING` / `ERR_NODE_UNREACHABLE`) with a
 * human-readable `message` explaining exactly why — rendered as-is, not
 * replaced with a generic failure string, since it already says the
 * pending-event count and what to do.
 */
export function setOutletNodeEnabled(locationId: UUID, nodeEnabled: boolean) {
  return api.put<OutletNodeSettingState>(`/nodes/outlet-setting/${locationId}`, { nodeEnabled });
}

/**
 * `POST /nodes/pairing-tokens` — mints a `targetType: 'node'` pairing token,
 * the sibling of `mintDevicePairingToken` for the branch-node PC itself
 * rather than a tablet/terminal. Server-side refuses (400) unless the
 * outlet's `nodeEnabled` is already true and no node is paired yet — this
 * function does not re-check either, the same "let the server be the
 * authority" stance the rest of this module takes.
 */
export function mintNodePairingToken(locationId: UUID) {
  return api.post<MintedPairingToken>('/nodes/pairing-tokens', { locationId });
}
