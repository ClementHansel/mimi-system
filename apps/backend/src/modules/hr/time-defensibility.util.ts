import type { ISODateTime } from '@mimi/shared';

/**
 * SYNC-PROTOCOL §6.3/§6.4 — clock-skew handling for attendance (FR-HR-01).
 *
 * This module's `check-in`/`check-out` REST endpoints are the ONLINE-direct
 * path (SYNC-PROTOCOL §1.3: "ordinary REST API calls always target the
 * cloud"); there is no branch node relaying this particular request, so
 * `relayReceivedAt` collapses to the cloud's own receipt instant — exactly
 * the fallback §2.1's field definition names ("falls back to cloud
 * `receivedAt` when no node relayed"). A device that queues this same fact
 * in its local outbox while genuinely offline and later replays it through
 * `/sync/push` (kernel/sync, W2-D) gets a REAL node/device relay bound
 * instead; both paths converge on the same `attendance.client_id` /
 * `check_out_client_id` UNIQUE constraint, so whichever arrives first wins
 * and the other is an idempotent no-op — see `attendance.service.ts`.
 *
 * `occurredAt` here is the CLIENT'S claimed capture instant (`dto.at`,
 * optional — defaults to `receivedAt` when the caller omits it, i.e. an
 * online capture with no separate claim to distrust).
 */
export interface TimeDefensibility {
  /** The instant business logic (lateness/overtime) should trust. */
  defensibleAt: ISODateTime;
  /** §6.3: skew > 24h, or the claim is in the future relative to receipt (+5 min grace). */
  timeSuspect: boolean;
  /** §6.4: the claim precedes the server's first sighting by more than the offline window — degrade to review, never auto-penalize. */
  timeDisputed: boolean;
}

const FUTURE_GRACE_MS = 5 * 60_000;

export function resolveDefensibility(
  occurredAt: ISODateTime,
  receivedAt: ISODateTime,
  maxOfflineWindowHours: number,
): TimeDefensibility {
  const occurredMs = new Date(occurredAt).getTime();
  const receivedMs = new Date(receivedAt).getTime();
  const maxOfflineWindowMs = maxOfflineWindowHours * 60 * 60_000;

  const aheadOfServerMs = occurredMs - receivedMs;
  const behindServerMs = receivedMs - occurredMs;

  // §6.3: a claim in the future beyond the grace window, or more than 24h of
  // raw skew in either direction, is untrustworthy on its face.
  const timeSuspect =
    aheadOfServerMs > FUTURE_GRACE_MS || Math.abs(aheadOfServerMs) > 24 * 60 * 60_000;

  // §6.4: even a claim that isn't flagged `time_suspect` is only "defensible" if it falls inside
  // the offline window bounded by this server sighting — a claim from 3 days ago with an honest
  // clock still can't be trusted further back than the configured offline ceiling.
  const withinOfflineWindow = behindServerMs <= maxOfflineWindowMs;

  const timeDisputed = timeSuspect || !withinOfflineWindow;

  const clampedMs = Math.min(Math.max(occurredMs, receivedMs - maxOfflineWindowMs), receivedMs);
  const defensibleAt = timeDisputed ? new Date(clampedMs).toISOString() : occurredAt;

  return { defensibleAt, timeSuspect, timeDisputed };
}
