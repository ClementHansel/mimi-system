/**
 * Typed REST calls for device management (CONTRACTS §4.21 `/api/devices/*`,
 * `devices.controller.ts`) — the write side of F12 `topology` that `lib/
 * topology-api.ts` deliberately does not carry (that file's own doc comment:
 * "no writes here beyond dismissing a conflict"). Split into its own file
 * rather than added there so a reviewer scanning `topology-api.ts` for "does
 * this monitoring surface write anything" still gets the right answer.
 *
 * Owner (2026-08-27): "In topologi perangkat, there is no way to add devices
 * and settings network etc." The backend already had all of this — only the
 * UI was missing:
 *  - `mintDevicePairingToken` — the intended way to ADD a device: mint a
 *    short-lived (15 min, §7.2/§4.21) single-use token here, then someone at
 *    the outlet redeems it from the tablet/node via `POST /devices/register`
 *    (that redemption call itself is out of this app's scope — it runs on
 *    the paired device, not this dashboard).
 *  - `updateDevice` / `unpairDevice` / `retireDevice` / `getDevice` — the
 *    management actions (rename, recategorise, move location, unpair,
 *    retire) surfaced from `DeviceDetailDrawer`.
 *
 * `mintDevicePairingToken` only ever mints `targetType: 'device'` tokens —
 * that is all `POST /devices/pairing-tokens` accepts (it hardcodes
 * `PairingTargetType.DEVICE` server-side regardless of what the body sends).
 * Node pairing is a DIFFERENT endpoint (`POST /nodes/pairing-tokens`, in
 * `node-gateway`, not `device-registry`) with no UI in this ticket's scope —
 * see the report note on "network settings".
 */
import { api } from '@/lib/api';
import type { UUID, ISODateTime } from '@/lib/shared-types';
import type { TopologyDevice } from './types';

export interface MintedPairingToken {
  tokenId: UUID;
  /** Not shown — the raw single-use bearer secret. Only `displayCode`/`qrPayload` are for humans. */
  token: string;
  /** The human-readable code (12 chars, no ambiguous 0/O/1/I/L) — read this one aloud. */
  displayCode: string;
  qrPayload: string;
  expiresAt: ISODateTime;
}

export function mintDevicePairingToken(params: { locationId: UUID; suggestedCategory?: string }) {
  return api.post<MintedPairingToken>('/devices/pairing-tokens', {
    locationId: params.locationId,
    suggestedCategory: params.suggestedCategory,
  });
}

export interface DeviceDetail extends TopologyDevice {
  locationId: UUID;
  locationName: string;
  nodeId: UUID | null;
  lastSyncAt: ISODateTime | null;
  replacesDeviceId: UUID | null;
  vendor: string | null;
  model: string | null;
  pairedAt: ISODateTime | null;
  recentHeartbeats: {
    at: ISODateTime;
    queueDepth: number;
    appVersion: string | null;
    batteryPct: number | null;
  }[];
  events: { type: string; detail: Record<string, unknown> | null; createdAt: ISODateTime }[];
}

export function getDevice(id: UUID) {
  return api.get<DeviceDetail>(`/devices/${id}`);
}

export interface UpdateDeviceBody {
  name?: string;
  category?: string;
  locationId?: UUID;
}

export function updateDevice(id: UUID, body: UpdateDeviceBody) {
  return api.patch<TopologyDevice & { locationId: UUID; locationName: string }>(
    `/devices/${id}`,
    body,
  );
}

export function unpairDevice(id: UUID, reason?: string) {
  return api.post<TopologyDevice>(`/devices/${id}/unpair`, { reason });
}

export function retireDevice(id: UUID, replacedByDeviceId?: UUID) {
  return api.post<TopologyDevice>(`/devices/${id}/retire`, { replacedByDeviceId });
}
