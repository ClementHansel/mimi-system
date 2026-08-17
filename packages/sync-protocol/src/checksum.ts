/**
 * State checksums (SYNC-PROTOCOL §9 intro, R2). "The deterministic hash of
 * all projected state for a scope" — used by property test T-01/T-17
 * ("final cloud state checksum identical to single-ordered delivery") and by
 * the R2 tier-checksum-probe job: device/node emit `sync:checksum
 * {locationId, asOfCursor, areaHashes}` once per day-close (see `../types`'s
 * `SyncChecksumMessage`); cloud compares at the same fact horizon
 * (`asOfCursor`).
 *
 * Deliberately NOT `node:crypto` — this package runs inside the browser
 * device tier as well as Node (cloud, branch node), and a hash used only for
 * equality comparison (never for security) doesn't need a cryptographic
 * primitive. FNV-1a is a well-known, fast, good-distribution non-crypto hash;
 * pure JS keeps this byte-identical across every runtime.
 *
 * Order independence is the whole point: replaying facts in a different
 * order must produce the SAME checksum (T-01's "any interleaving"), so
 * per-item hashes are combined with XOR — commutative and associative,
 * unlike concatenate-then-hash.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

/** FNV-1a over the UTF-16 code units of `input`, masked to 64 bits. */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

export function fnv1a64Hex(input: string): string {
  return fnv1a64(input).toString(16).padStart(16, '0');
}

/** XOR-combines a set of hex hashes into one — order-independent by construction. */
export function combineChecksums(hashesHex: readonly string[]): string {
  const combined = hashesHex.reduce((acc, h) => acc ^ BigInt(`0x${h}`), 0n);
  return combined.toString(16).padStart(16, '0');
}

/**
 * The checksum of a state = XOR of each row's own hash, where each row is
 * first turned into a canonical string (stable key order) by the caller.
 * `canonicalRowString` exists so callers don't have to remember to sort
 * object keys themselves — pass rows as plain objects and this does it.
 *
 * Rebuilds the row with sorted keys (rather than using `JSON.stringify`'s
 * array-replacer form to filter/order keys) specifically so a REPLACER
 * FUNCTION can run too: a row containing a `bigint` field (e.g. a
 * `client_seq` folded into an R2 canary row) would otherwise throw
 * `TypeError: Do not know how to serialize a BigInt` — a crash here would
 * look like a sync bug (a checksum job failing) rather than what it actually
 * is, a stringification gap. `bigint` values are converted to their decimal
 * string form, matching how `client_seq` travels on the wire (`../types`).
 */
export function canonicalRowString(row: Record<string, unknown>): string {
  const sortedKeys = Object.keys(row).sort();
  const ordered: Record<string, unknown> = {};
  for (const key of sortedKeys) ordered[key] = row[key];
  return JSON.stringify(ordered, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export function computeStateChecksum(rows: readonly Record<string, unknown>[]): string {
  return combineChecksums(rows.map((r) => fnv1a64Hex(canonicalRowString(r))));
}

export interface AreaBalanceRow {
  storageAreaId: string;
  itemId: string;
  qtyOnHand: string;
}

/**
 * R2's `sync:checksum.areaHashes` shape: one order-independent checksum per
 * storage area, so a divergence localizes to a single area rather than the
 * whole outlet.
 */
export function computeAreaBalanceChecksums(rows: readonly AreaBalanceRow[]): Record<string, string> {
  const byArea = new Map<string, AreaBalanceRow[]>();
  for (const row of rows) {
    const list = byArea.get(row.storageAreaId);
    if (list) list.push(row);
    else byArea.set(row.storageAreaId, [row]);
  }
  const result: Record<string, string> = {};
  for (const [areaId, areaRows] of byArea) {
    result[areaId] = computeStateChecksum(areaRows as unknown as Record<string, unknown>[]);
  }
  return result;
}
