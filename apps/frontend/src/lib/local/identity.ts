/**
 * Device identity + the durable `client_seq` counter (SYNC-PROTOCOL §1.5, §2.1).
 *
 * "`origin_device_id` identifies one durable local store (one installation)."
 * A wiped/reinstalled PWA is a NEW device id whose `client_seq` restarts at 1
 * — this module never reuses an id, and its counter lives in the same
 * database as everything keyed off it.
 */
import type { LocalDatabase } from './store/local-database';
import type { ClientSeqCounter, DeviceIdentity } from './types';
import { formatUuidV7 } from '@mimi/sync-protocol';
import type { UUID } from '@mimi/shared';

export interface RandomSource {
  /** 16+ random bytes, fresh each call. */
  bytes(n: number): Uint8Array;
  now(): number;
}

/** `crypto.getRandomValues`-backed source for real use; tests inject a seeded fake. */
export const cryptoRandomSource: RandomSource = {
  bytes(n) {
    const arr = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  },
  now: () => Date.now(),
};

export function mintEventId(random: RandomSource = cryptoRandomSource): UUID {
  return formatUuidV7(random.now(), random.bytes(16));
}

const IDENTITY_STORE = 'device_identity';
const SEQ_STORE = 'client_seq_counter';

export async function loadDeviceIdentity(db: LocalDatabase): Promise<DeviceIdentity | undefined> {
  return db.store<DeviceIdentity>(IDENTITY_STORE).get('self');
}

/**
 * First-run bootstrap: mint a stable local `fingerprint` (survives until the
 * app/storage is wiped, at which point re-registration is correctly treated
 * as a NEW device per §1.5) and seed the counter at 0 so the first commit
 * assigns `client_seq = 1`.
 */
export async function ensureDeviceIdentity(
  db: LocalDatabase,
  random: RandomSource = cryptoRandomSource,
): Promise<DeviceIdentity> {
  const existing = await loadDeviceIdentity(db);
  if (existing) return existing;

  const fingerprint = mintEventId(random); // any UUIDv7 is a fine stable local install id
  const identity: DeviceIdentity = {
    id: 'self',
    originDeviceId: fingerprint, // replaced with the server-assigned deviceId once /api/devices/register completes
    deviceToken: null,
    fingerprint,
    locationId: null,
    locationCode: null,
    locationName: null,
    nodeLanUrl: null,
    cloudUrl: '',
    protocolV: 1,
    registeredAt: null,
  };
  await db.store<DeviceIdentity>(IDENTITY_STORE).put(identity);
  await db.store<ClientSeqCounter>(SEQ_STORE).put({ id: 'self', value: '0' });
  return identity;
}

/**
 * Applies the `/api/devices/register` response (CONTRACTS.md §4.21): the
 * cloud-assigned `deviceId` REPLACES the local fingerprint as
 * `originDeviceId` going forward (the fingerprint's only job was letting the
 * device identify itself across a reinstall via `replacesDeviceId`, which is
 * the registry's concern, not sync's — §1.5's origin id is whatever the
 * device durably uses to seq its own outbox, and that must be stable from
 * the FIRST committed event, so this must run before any commit whenever
 * possible; if events were already committed under the fingerprint before
 * registration completed — e.g. captured fully offline before ever reaching
 * the cloud once — those events keep the fingerprint as their origin and the
 * registry's `replacesDeviceId` linkage is what reconciles the two for
 * display, per §1.5's own text: "links successive installations... for
 * display; the sync layer never reuses an origin id").
 */
export async function applyRegistration(
  db: LocalDatabase,
  reg: {
    deviceId: UUID;
    deviceToken: string;
    location: { id: UUID; code: string; name: string };
    nodeLanUrl: string | null;
    syncConfig: { cloudUrl: string; protocolV: number };
  },
): Promise<DeviceIdentity> {
  const current = await ensureDeviceIdentity(db);
  const updated: DeviceIdentity = {
    ...current,
    originDeviceId: current.registeredAt ? current.originDeviceId : reg.deviceId,
    deviceToken: reg.deviceToken,
    locationId: reg.location.id,
    locationCode: reg.location.code,
    locationName: reg.location.name,
    nodeLanUrl: reg.nodeLanUrl,
    cloudUrl: reg.syncConfig.cloudUrl,
    protocolV: reg.syncConfig.protocolV,
    registeredAt: new Date().toISOString(),
  };
  await db.store<DeviceIdentity>(IDENTITY_STORE).put(updated);
  return updated;
}

export async function peekNextClientSeq(db: LocalDatabase): Promise<bigint> {
  const row = await db.store<ClientSeqCounter>(SEQ_STORE).get('self');
  return BigInt(row?.value ?? '0') + 1n;
}
