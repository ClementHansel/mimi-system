/**
 * Clock discipline — SYNC-PROTOCOL §6. Ordering is NEVER by wall clock
 * (that's `client_seq`'s job, §6.1); this module only owns:
 *  1. measuring + smoothing the offset vs. whichever upstream answered last
 *     (§6.2's "NTP-lite", EWMA over last 5 samples),
 *  2. stamping `occurred_at`/`meta.clockOffsetMs`/`meta.rawDeviceTime` on a
 *     freshly-committed event,
 *  3. the skew POLICY (§6.3 banner/suspect thresholds) as pure predicates,
 *  4. `defensible_at` (§6.4) — the clamp that bounds what an adversarial
 *     clock can buy an attacker on attendance/shift-close/credential expiry.
 *
 * Zero I/O — callers own persistence of `ClockState` via `store/local-database`.
 */
import type { ISODateTime } from '@mimi/shared';
import {
  CLOCK_OFFSET_EWMA_SAMPLES,
  CLOCK_SUSPECT_BANNER_MS,
  CLOCK_SUSPECT_TAG_MS,
  DEFAULT_MAX_OFFLINE_WINDOW_MS,
  OCCURRED_AT_FUTURE_GRACE_MS,
} from '../constants';
import type { ClockState } from '../types';

export function initialClockState(): ClockState {
  return { id: 'self', offsetMs: 0, samples: [], lastMeasuredAt: null };
}

/**
 * `offset = server_time − device_now − rtt/2` (§6.2). Folds the new sample
 * into the last-5 window and returns the EWMA-updated state (simple
 * arithmetic mean over the window — "smoothed" per spec; a true exponential
 * weighting isn't specified, and a bounded moving average is the honest
 * reading of "over last 5 samples").
 */
export function recordOffsetSample(
  state: ClockState,
  serverTimeIso: ISODateTime,
  deviceNowMs: number,
  rttMs: number,
  measuredAtIso: ISODateTime,
): ClockState {
  const offset = new Date(serverTimeIso).getTime() - deviceNowMs - rttMs / 2;
  const samples = [...state.samples, offset].slice(-CLOCK_OFFSET_EWMA_SAMPLES);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { id: 'self', offsetMs: Math.round(avg), samples, lastMeasuredAt: measuredAtIso };
}

export interface StampedTime {
  occurredAt: ISODateTime;
  rawDeviceTime: ISODateTime;
  clockOffsetMs: number;
}

/** §6.2: "the device applies its last-known offset... records both the corrected value and raw_device_time + clock_offset_ms". */
export function stampNow(state: ClockState, deviceNowMs: number = Date.now()): StampedTime {
  const rawDeviceTime = new Date(deviceNowMs).toISOString();
  const occurredAt = new Date(deviceNowMs + state.offsetMs).toISOString();
  return { occurredAt, rawDeviceTime, clockOffsetMs: state.offsetMs };
}

// ── §6.3 skewed-device policy ──────────────────────────────────────────────────

export function needsSkewBanner(offsetMs: number): boolean {
  return Math.abs(offsetMs) > CLOCK_SUSPECT_BANNER_MS;
}

/**
 * §6.3's second rule is two-part: either the raw offset is extreme (> 24h),
 * OR the stamped `occurredAt` sits in the future relative to the first
 * server-grade sighting of the event beyond a 5-minute grace. This function
 * covers the offset-only half; `isTimeSuspectAtApply` (below) covers the
 * full rule once a `relayReceivedAt` exists (i.e. at apply time, mirroring
 * what the cloud/node does — a device can pre-flag its OWN events the same
 * way once it has learned its own offset, which is a UX nicety, not the
 * authoritative determination that only apply-time knows for sure).
 */
export function isOffsetSuspect(offsetMs: number): boolean {
  return Math.abs(offsetMs) > CLOCK_SUSPECT_TAG_MS;
}

/**
 * The full §6.3 `time_suspect` predicate, evaluable once a server-grade
 * timestamp (`relayReceivedAt`, falling back to cloud `receivedAt`) is known
 * for the event — i.e., authoritatively at apply time, but also usable
 * device-side once the device has synced (for local display/UX only; the
 * device is never the authority on this flag).
 */
export function isTimeSuspectAtApply(occurredAtIso: ISODateTime, relayReceivedAtIso: ISODateTime, offsetMs: number): boolean {
  if (isOffsetSuspect(offsetMs)) return true;
  const occurredAt = new Date(occurredAtIso).getTime();
  const relayReceivedAt = new Date(relayReceivedAtIso).getTime();
  return occurredAt > relayReceivedAt + OCCURRED_AT_FUTURE_GRACE_MS;
}

// ── §6.4 defensible time ───────────────────────────────────────────────────────

/**
 * `defensible_at` = `occurred_at` clamped to `[relay_received_at −
 * max_offline_window, relay_received_at]`. `relayReceivedAtIso` falls back to
 * cloud `received_at` when no node relayed (per spec); callers pass whichever
 * they have. `maxOfflineWindowMs` defaults to `settings.max_offline_window`'s
 * 24h default (`DEFAULT_MAX_OFFLINE_WINDOW_MS`) — Wave 4 surfaces reading a
 * live `settings` value should pass it explicitly.
 */
export function computeDefensibleAt(
  occurredAtIso: ISODateTime,
  relayReceivedAtIso: ISODateTime,
  maxOfflineWindowMs: number = DEFAULT_MAX_OFFLINE_WINDOW_MS,
): ISODateTime {
  const occurredAt = new Date(occurredAtIso).getTime();
  const relayReceivedAt = new Date(relayReceivedAtIso).getTime();
  const lowerBound = relayReceivedAt - maxOfflineWindowMs;
  const clamped = Math.min(Math.max(occurredAt, lowerBound), relayReceivedAt);
  return new Date(clamped).toISOString();
}

/**
 * §6.4's three-way credential-expiry provability call, reusable by the local
 * offline-credential gate (`credentials/offline-credentials.ts`) for
 * consistent UX with what the cloud will conclude at apply time — the
 * device's read is advisory (only the cloud's R6/§7.4 pass is authoritative),
 * but showing the same verdict early avoids a false "this worked" moment.
 */
export type ExpiryProvability = 'provable_valid' | 'unprovable' | 'expired';

export function evaluateExpiryProvability(
  occurredAtIso: ISODateTime,
  relayReceivedAtIso: ISODateTime | null,
  expiresAtIso: ISODateTime,
): ExpiryProvability {
  const exp = new Date(expiresAtIso).getTime();
  if (relayReceivedAtIso !== null && new Date(relayReceivedAtIso).getTime() <= exp) return 'provable_valid';
  if (new Date(occurredAtIso).getTime() <= exp) return 'unprovable';
  return 'expired';
}
