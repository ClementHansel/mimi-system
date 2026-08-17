/**
 * Shared UUID minting helper for every production call site that needs a
 * client-generated id (POS `clientId`s, offline `clientId`/idempotency keys
 * across driver/outlet/me/pos, attachment ids — SYNC-PROTOCOL §2.2 rule 3,
 * §4.7).
 *
 * `crypto.randomUUID()` only exists in a *secure context* (HTTPS, or
 * `localhost`). This app is deployed plain HTTP on a bare IP
 * (`http://150.109.15.108:8080`), so `crypto.randomUUID` is `undefined`
 * there — every call site that used it directly crashed the whole page with
 * "crypto.randomUUID is not a function" on `/pos` and `/admin`. Every dev
 * machine hid this because `localhost` IS a secure context.
 *
 * `crypto.getRandomValues()` has no such restriction — it's available on any
 * origin — so the fallback below uses it to build a proper RFC-4122 v4 UUID
 * (correct version nibble, correct variant bits) rather than reaching for
 * `Math.random()`. These ids become `clientId`s and idempotency keys in an
 * append-only sync protocol: `Math.random()` is not a CSPRNG, is not
 * guaranteed collision-resistant across devices, and a malformed/colliding
 * id here is silent data corruption, not a cosmetic bug.
 */
export function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('newUuid: no CSPRNG available — crypto.getRandomValues is required');
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4 (random)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx (RFC 4122)

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
