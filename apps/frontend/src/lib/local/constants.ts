/**
 * Tier-1 local runtime constants (SYNC-PROTOCOL §1.3, §4.3-4.6, §7).
 * Values mirror the protocol document's own numbers so a spec citation is
 * always one grep away from its code.
 */

// ── §1.3 upstream selection (hysteresis) ──────────────────────────────────────
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;
/** "Fail away from the current upstream only after 3 consecutive failures spanning >= 10s." */
export const FAIL_AWAY_CONSECUTIVE_FAILURES = 3;
export const FAIL_AWAY_MIN_SPAN_MS = 10_000;
/** "Fail back to the higher-preference candidate only after it has been continuously healthy for 60s." */
export const FAIL_BACK_HEALTHY_MS = 60_000;
/** How often the upstream selector re-probes candidates while idle. */
export const UPSTREAM_PROBE_INTERVAL_MS = 5_000;

// ── §4.3 push ──────────────────────────────────────────────────────────────────
export const MAX_EVENTS_PER_PUSH_BATCH = 200;
export const MAX_PUSH_BATCH_BYTES = 1_000_000;
export const MAX_IN_FLIGHT_BATCHES_PER_UPSTREAM = 1;

// ── §4.5 pull ──────────────────────────────────────────────────────────────────
export const PULL_PAGE_LIMIT = 500;
/** Device prunes applied operational events beyond this window (§4.5). */
export const APPLIED_EVENT_RETENTION_DAYS = 14;

// ── §4.6 heartbeat ─────────────────────────────────────────────────────────────
export const HEARTBEAT_INTERVAL_MS = 60_000;

// ── §4.7 attachment side-channel ──────────────────────────────────────────────
export const ATTACHMENT_CAP_BYTES = 200 * 1024 * 1024;
export const ATTACHMENT_CAP_COUNT = 500;
export const ATTACHMENT_EVIDENCE_SLA_HOURS = 24;

// ── §6 clock discipline ────────────────────────────────────────────────────────
export const CLOCK_OFFSET_EWMA_SAMPLES = 5;
export const CLOCK_SUSPECT_BANNER_MS = 2 * 60 * 1000; // §6.3 |offset| > 2 min
export const CLOCK_SUSPECT_TAG_MS = 24 * 60 * 60 * 1000; // §6.3 |offset| > 24 h
export const OCCURRED_AT_FUTURE_GRACE_MS = 5 * 60 * 1000; // §6.3 "+5 min grace"
export const DEFAULT_MAX_OFFLINE_WINDOW_MS = 24 * 60 * 60 * 1000; // §6.4 settings.max_offline_window default

// ── §7.3 offline authorization ────────────────────────────────────────────────
export const PIN_MAX_ATTEMPTS = 5;

/**
 * B-17 — the offline PIN backoff ladder, in milliseconds, indexed by failure
 * count. Deliberately the SAME shape and the same numbers as the server-side
 * ladder in `kernel/auth-lockout/auth-lockout.service.ts` (B-15 Q5): a
 * supervisor should not have to learn two different rules depending on whether
 * the outlet happens to have internet at that moment.
 *
 * Counts below the first entry are free. At `PIN_MAX_ATTEMPTS` the credential
 * goes terminally `lockedOut` instead, which no cooldown clears.
 */
export const PIN_BACKOFF_MS_BY_FAILURE_COUNT: Readonly<Record<number, number>> = {
  3: 30_000,
  4: 120_000,
};

// ── payload envelope cap (§2.1) ────────────────────────────────────────────────
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export const SCHEMA_VERSION = 1;
