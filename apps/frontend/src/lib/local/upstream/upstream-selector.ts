/**
 * Upstream selection — SYNC-PROTOCOL §1.3. This is the ONLY place that
 * implements the algorithm; `connectivity-store.ts` (W1-E) just displays
 * whatever tier this decides (its own header says as much: "the real
 * upstream-selection algorithm... is W2-E's, which calls setTier,
 * setQueueDepth, setLastSyncAt").
 *
 * Rules honored, verbatim:
 *  - Candidates in preference order: paired node (if any), then cloud.
 *  - Healthy = `GET <base>/sync/v1/health` answers within 3s with a
 *    protocol-compatible `{ok:true}`.
 *  - "Fail away from the current upstream only after 3 consecutive failures
 *    spanning >= 10s (a single dropped request must not cause a switch)."
 *  - "Fail back to the higher-preference candidate only after it has been
 *    continuously healthy for 60s (hysteresis; prevents flapping)."
 *  - Exactly one upstream at a time.
 *  - The node is optional (RISK-P5): with no paired node cached, the
 *    candidate list is just `[cloud]` and this degrades to plain
 *    online/isolated with no LAN state ever reachable — no path here
 *    assumes a node exists.
 */
import type { SyncHealth } from '../transport/types';
import {
  FAIL_AWAY_CONSECUTIVE_FAILURES,
  FAIL_AWAY_MIN_SPAN_MS,
  FAIL_BACK_HEALTHY_MS,
} from '../constants';

export type UpstreamCandidateKind = 'node' | 'cloud';

export interface UpstreamCandidate {
  kind: UpstreamCandidateKind;
  baseUrl: string;
}

export type ConnectivityTier = 'online' | 'lan' | 'isolated';

export interface UpstreamState {
  current: UpstreamCandidate | null;
  tier: ConnectivityTier;
}

interface CandidateTracking {
  consecutiveFailures: number;
  firstFailureAt: number | null;
  continuousHealthySince: number | null;
}

function tierOf(kind: UpstreamCandidateKind | null): ConnectivityTier {
  if (kind === 'cloud') return 'online';
  if (kind === 'node') return 'lan';
  return 'isolated';
}

export interface ProbeFn {
  (baseUrl: string): Promise<SyncHealth>;
}

export class UpstreamSelector {
  private candidates: UpstreamCandidate[];
  private tracking = new Map<string, CandidateTracking>();
  private current: UpstreamCandidate | null = null;
  private readonly probe: ProbeFn;
  private readonly now: () => number;
  private listeners: Array<(state: UpstreamState) => void> = [];

  constructor(candidates: UpstreamCandidate[], probe: ProbeFn, now: () => number = Date.now) {
    this.candidates = candidates;
    this.probe = probe;
    this.now = now;
    for (const c of candidates)
      this.tracking.set(this.key(c), {
        consecutiveFailures: 0,
        firstFailureAt: null,
        continuousHealthySince: null,
      });
  }

  private key(c: UpstreamCandidate): string {
    return `${c.kind}:${c.baseUrl}`;
  }

  /** Replaces the candidate set (e.g. a node gets paired/unpaired at runtime). Preserves tracking for candidates that persist. */
  setCandidates(candidates: UpstreamCandidate[]): void {
    this.candidates = candidates;
    for (const c of candidates) {
      if (!this.tracking.has(this.key(c))) {
        this.tracking.set(this.key(c), {
          consecutiveFailures: 0,
          firstFailureAt: null,
          continuousHealthySince: null,
        });
      }
    }
    if (this.current && !candidates.some((c) => this.key(c) === this.key(this.current!))) {
      this.current = null;
    }
  }

  getState(): UpstreamState {
    return { current: this.current, tier: tierOf(this.current?.kind ?? null) };
  }

  onChange(listener: (state: UpstreamState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private setCurrent(next: UpstreamCandidate | null): void {
    const changed = this.key0(this.current) !== this.key0(next);
    this.current = next;
    if (changed) {
      const state = this.getState();
      for (const l of this.listeners) l(state);
    }
  }

  private key0(c: UpstreamCandidate | null): string {
    return c ? this.key(c) : '∅';
  }

  private async probeHealthy(c: UpstreamCandidate): Promise<boolean> {
    try {
      const health = await this.probe(c.baseUrl);
      return health.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * One probe cycle: probes every candidate, applies fail-away/fail-back
   * hysteresis, and updates `current` at most once per call. Callers drive
   * this on startup, on connectivity-change events, and on a timer
   * (`UPSTREAM_PROBE_INTERVAL_MS`).
   */
  async tick(): Promise<UpstreamState> {
    const now = this.now();
    const healthy = new Map<string, boolean>();
    for (const c of this.candidates) {
      healthy.set(this.key(c), await this.probeHealthy(c));
    }

    if (this.current === null) {
      const first = this.candidates.find((c) => healthy.get(this.key(c)));
      if (first) this.setCurrent(first);
      return this.getState();
    }

    const currentKey = this.key(this.current);
    const currentHealthy = healthy.get(currentKey) ?? false;
    const track = this.tracking.get(currentKey)!;

    let failedAway = false;

    if (!currentHealthy) {
      track.consecutiveFailures += 1;
      if (track.firstFailureAt === null) track.firstFailureAt = now;
      const span = now - track.firstFailureAt;
      if (
        track.consecutiveFailures >= FAIL_AWAY_CONSECUTIVE_FAILURES &&
        span >= FAIL_AWAY_MIN_SPAN_MS
      ) {
        const alternative = this.candidates.find(
          (c) => this.key(c) !== currentKey && healthy.get(this.key(c)),
        );
        track.consecutiveFailures = 0;
        track.firstFailureAt = null;
        this.setCurrent(alternative ?? null);
        failedAway = true;
      }
    } else {
      track.consecutiveFailures = 0;
      track.firstFailureAt = null;
    }

    if (!failedAway) {
      const currentIndex = this.candidates.findIndex((c) => this.key(c) === currentKey);
      for (let i = 0; i < currentIndex; i++) {
        const candidate = this.candidates[i]!;
        const cKey = this.key(candidate);
        const cTrack = this.tracking.get(cKey)!;
        if (healthy.get(cKey)) {
          if (cTrack.continuousHealthySince === null) cTrack.continuousHealthySince = now;
          if (now - cTrack.continuousHealthySince >= FAIL_BACK_HEALTHY_MS) {
            cTrack.continuousHealthySince = null;
            this.setCurrent(candidate);
            break;
          }
        } else {
          cTrack.continuousHealthySince = null;
        }
      }
    }

    return this.getState();
  }
}
