/**
 * Wire <-> domain conversion for the `/sync` protocol (SYNC-PROTOCOL §2.1,
 * §4.2-4.6).
 *
 * **Coordinator ruling (G2 interop, superseding this file's original
 * snake_case design):** the wire is camelCase, matching `@mimi/sync-protocol`'s
 * frozen types exactly — those types are the actual frozen contract, W1-B's
 * payload schema registry already declares camelCase field names throughout
 * (`orderRef`, `closingCashCounted`), and a snake_case envelope wrapping
 * camelCase payloads would have been incoherent. SYNC-PROTOCOL.md's prose
 * examples (which were snake_case) are being corrected to match.
 *
 * That leaves exactly ONE conversion boundary in the whole system:
 * `clientSeq` is `BIGINT` domain-side, serialized as a decimal STRING on the
 * wire (never a JS `number`, to avoid silent precision loss) and parsed back
 * to `bigint` on receipt. Every other field is a straight pass-through —
 * this module still exists (rather than sending domain objects directly) so
 * that boundary has one obvious place to live, and so a future field that
 * genuinely needs wire-shape translation has an established seam to join.
 */
import type { SyncEventEnvelope, SyncHelloAck, SyncHelloRequest, SyncPullResult, SyncPushAck, SyncPushBatch } from '@mimi/sync-protocol';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `BigInt(...)` throws on `undefined`/non-numeric input — parsing an
 * attacker- or bug-malformed wire body must never crash the request handler
 * outright (a node's job is to reject cleanly as `malformed`, §4.4, not
 * 500). `0n` is a safe sentinel: legitimate `clientSeq` is always `>= 1`
 * (§2.1), so a genuinely missing/broken value is caught by `relay.ts`'s
 * `isWellFormedEnvelope` structural check afterward.
 */
function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
    return 0n;
  } catch {
    return 0n;
  }
}

export function eventToWire(e: SyncEventEnvelope): Record<string, unknown> {
  return { ...e, clientSeq: e.clientSeq.toString() };
}

export function eventFromWire(w: Record<string, any>): SyncEventEnvelope {
  return { ...w, clientSeq: safeBigInt(w.clientSeq) } as SyncEventEnvelope;
}

export function helloToWire(h: SyncHelloRequest): Record<string, unknown> {
  return { ...h };
}

export function helloFromWire(w: Record<string, any>): SyncHelloRequest {
  return { ...w } as SyncHelloRequest;
}

export function helloAckToWire(a: SyncHelloAck): Record<string, unknown> {
  return { ...a };
}

export function helloAckFromWire(w: Record<string, any>): SyncHelloAck {
  return { ...w } as SyncHelloAck;
}

export function pushBatchToWire(b: SyncPushBatch): Record<string, unknown> {
  return { ...b, events: b.events.map(eventToWire) };
}

export function pushBatchFromWire(w: Record<string, any>): SyncPushBatch {
  return { ...w, events: (w.events ?? []).map(eventFromWire) } as SyncPushBatch;
}

export function pushAckToWire(a: SyncPushAck): Record<string, unknown> {
  return { ...a };
}

export function pushAckFromWire(w: Record<string, any>): SyncPushAck {
  return { ...w, rejected: w.rejected ?? [] } as SyncPushAck;
}

export function pullResultToWire(p: SyncPullResult): Record<string, unknown> {
  return { ...p, events: p.events.map(eventToWire) };
}

export function pullResultFromWire(w: Record<string, any>): SyncPullResult {
  return { ...w, events: (w.events ?? []).map(eventFromWire) } as SyncPullResult;
}
