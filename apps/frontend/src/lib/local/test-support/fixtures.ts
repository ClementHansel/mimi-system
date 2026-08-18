/**
 * Shared test fixtures for `lib/local`'s own test suite (SYNC-PROTOCOL §9
 * device-side scenarios). Not imported by any production code path.
 */
import { createMemoryDatabase } from '../store/memory-database';
import type { LocalDatabase } from '../store/local-database';
import { STORE_KEY_PATH } from '../types';
import { ensureDeviceIdentity, type RandomSource } from '../identity';
import type { DeviceIdentity } from '../types';

export function createTestDatabase(): LocalDatabase {
  return createMemoryDatabase(STORE_KEY_PATH);
}

/** Deterministic UUIDv7 source: monotonically increasing fake clock + a counter folded into the random bytes, so ids are stable and readable in test failures without ever colliding. */
export function createSeededRandom(seedStart = 1): RandomSource {
  let n = seedStart;
  let clock = 1_700_000_000_000;
  return {
    bytes(len: number) {
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = (n + i) & 0xff;
      n += 1;
      return arr;
    },
    now() {
      clock += 1;
      return clock;
    },
  };
}

export async function setupIdentity(
  db: LocalDatabase,
  overrides: Partial<DeviceIdentity> = {},
  random?: RandomSource,
): Promise<DeviceIdentity> {
  const identity = await ensureDeviceIdentity(db, random);
  const merged: DeviceIdentity = {
    ...identity,
    locationId: 'loc-1',
    cloudUrl: 'https://cloud.mimi.test',
    ...overrides,
  };
  await db.store<DeviceIdentity>('device_identity').put(merged);
  return merged;
}

export const ACTOR = { actorUserId: 'user-1', actorRole: 'kasir', appVersion: '1.0.0-test' };
