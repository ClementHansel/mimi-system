/**
 * Wire (de)serialization for `client_seq` — the ONE field on
 * `SyncEventEnvelope` that native JSON cannot carry as-is.
 *
 * `@mimi/sync-protocol`'s `SyncEventEnvelope.clientSeq` is typed `bigint`
 * (§2.1: "gapless, monotonic per origin... modeled as bigint — real values
 * never approach Number.MAX_SAFE_INTEGER, but BIGINT is BIGINT"). Native
 * `JSON.stringify`/`JSON.parse` have no bigint representation at all —
 * `JSON.stringify({n: 1n})` THROWS `TypeError: Do not know how to
 * serialize a BigInt`, which would crash every `/sync/v1/pull` and
 * `/sync/v1/bootstrap` response and every `sync:deliver`/`sync:pull:result`
 * socket emission the moment a real event crossed the wire.
 *
 * RESOLUTION (confirmed against W2-F's branch node, which already assumed
 * this): `client_seq` rides the wire as a DECIMAL STRING, matching this
 * codebase's own Money/Qty/Temp convention (`@mimi/shared`'s `./types`:
 * "travel as decimal STRINGS on the wire... never a JS number") — bigint
 * is exactly that same class of value (too large/precise to risk a JS
 * `number`), so the same wire convention applies. Internally, every
 * `kernel/sync` service still works in `bigint` (`@mimi/sync-protocol`'s
 * frozen type) — these functions are the ONLY place the conversion happens,
 * at the two transport boundaries (`sync-http.controller.ts`,
 * `sync.gateway.ts`).
 */
import type { SyncEventEnvelope, SyncPullResult, SyncPushBatch } from '@mimi/sync-protocol';

/** A wire-shape event: identical to `SyncEventEnvelope` except `clientSeq` is a decimal string. */
export type WireSyncEvent = Omit<SyncEventEnvelope, 'clientSeq'> & { clientSeq: string };

export function decodeWireEvent(e: WireSyncEvent): SyncEventEnvelope {
  return { ...e, clientSeq: BigInt(e.clientSeq) };
}

export function encodeWireEvent(e: SyncEventEnvelope): WireSyncEvent {
  return { ...e, clientSeq: e.clientSeq.toString() };
}

export interface WireSyncPushBatch extends Omit<SyncPushBatch, 'events'> {
  events: WireSyncEvent[];
}

/** Decodes an incoming `sync:push` / `POST /sync/v1/push` body before handing it to `SyncIngestService`. */
export function decodeWireBatch(batch: WireSyncPushBatch): SyncPushBatch {
  return { ...batch, events: batch.events.map(decodeWireEvent) };
}

export interface WireSyncPullResult extends Omit<SyncPullResult, 'events'> {
  events: WireSyncEvent[];
}

/** Encodes an outgoing `sync:pull:result` / `sync:deliver` / pull-endpoint response. */
export function encodePullResult(result: SyncPullResult): WireSyncPullResult {
  return { ...result, events: result.events.map(encodeWireEvent) };
}
