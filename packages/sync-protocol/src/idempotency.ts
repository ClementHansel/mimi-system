/**
 * The idempotency-key derivation (SYNC-PROTOCOL §2.2, §1.5).
 *
 * The key IS the event's `eventId`: a UUIDv7 minted once, atomically, before
 * the event is transmissible. This module owns two pure pieces of that rule:
 *  1. `formatUuidV7` — deterministic given `(timestampMs, randomBytes)`, so it
 *     is testable and reproducible without any real clock/RNG dependency
 *     (the device runtime supplies both at the call site — that I/O boundary
 *     belongs to `apps/frontend`/`apps/branch-node`, not this package).
 *  2. `outboxDedupeKey` — the SECOND uniqueness axis (§2.2 rule 4):
 *     `UNIQUE(origin_device_id, client_seq)`, the outbox-corruption detector.
 *     An arrival whose `eventId` is new but whose `(origin, client_seq)` is
 *     already taken indicates a cloned/corrupted local store.
 */
import type { UUID } from '@mimi/shared';

const HEX = '0123456789abcdef';

function toHex(byte: number): string {
  return HEX[(byte >> 4) & 0xf]! + HEX[byte & 0xf]!;
}

/**
 * UUIDv7: 48-bit big-endian ms timestamp, version nibble `7`, variant bits,
 * then 62 bits of randomness (RFC 9562). `randomBytes` must supply at least
 * 10 bytes; only the low-order bits needed for the random field are used, and
 * they are masked to leave the version/variant nibbles correct regardless of
 * what the caller passes.
 */
export function formatUuidV7(timestampMs: number, randomBytes: Uint8Array): UUID {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError(`timestampMs must be a non-negative integer, got ${timestampMs}`);
  }
  if (randomBytes.length < 10) {
    throw new RangeError(`randomBytes must supply at least 10 bytes, got ${randomBytes.length}`);
  }

  const ts = BigInt(Math.floor(timestampMs));
  const tsHex = ts.toString(16).padStart(12, '0').slice(-12); // 48 bits = 12 hex chars

  const rand = randomBytes.slice(0, 10);
  // Byte 6 (of the UUID): high nibble = version (7), low nibble = random.
  const byte6 = 0x70 | (rand[0]! & 0x0f);
  // Byte 8: high two bits = variant (10), remaining 6 bits = random.
  const byte8 = 0x80 | (rand[1]! & 0x3f);

  const timeHigh = tsHex.slice(0, 8);
  const timeLow = tsHex.slice(8, 12);
  const part3 = toHex(byte6) + toHex(rand[2]!);
  const part4 = toHex(byte8) + toHex(rand[3]!);
  const part5 = [rand[4]!, rand[5]!, rand[6]!, rand[7]!, rand[8]!, rand[9]!].map(toHex).join('');

  return `${timeHigh}-${timeLow}-${part3}-${part4}-${part5}`;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(id: string): boolean {
  return UUID_V7_RE.test(id);
}

/** The 48-bit millisecond timestamp encoded in a UUIDv7's first two groups. */
export function extractUuidV7Timestamp(id: UUID): number {
  if (!isUuidV7(id)) throw new RangeError(`Not a UUIDv7: ${JSON.stringify(id)}`);
  const hex = id.slice(0, 8) + id.slice(9, 13);
  return Number(BigInt(`0x${hex}`));
}

/**
 * The outbox-corruption detector's key (§2.2 rule 4): `UNIQUE(origin_device_id,
 * client_seq)`. Two events sharing this key but carrying different `eventId`s
 * means the same local store produced the same sequence number twice —
 * `seq_conflict`, a permanent reject that freezes the origin (§4.4).
 */
export function outboxDedupeKey(originDeviceId: UUID, clientSeq: bigint): string {
  return `${originDeviceId}:${clientSeq.toString()}`;
}
