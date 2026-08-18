import { describe, expect, it } from 'vitest';
import {
  initialClockState,
  recordOffsetSample,
  stampNow,
  needsSkewBanner,
  isOffsetSuspect,
  isTimeSuspectAtApply,
  computeDefensibleAt,
  evaluateExpiryProvability,
} from './clock';

describe('clock discipline (SYNC-PROTOCOL §6)', () => {
  it('measures offset = server_time - device_now - rtt/2', () => {
    const state = initialClockState();
    const serverTime = new Date(1_000_000_000_000 + 5000).toISOString(); // server is 5s ahead net of RTT
    const updated = recordOffsetSample(
      state,
      serverTime,
      1_000_000_000_000,
      0,
      new Date().toISOString(),
    );
    expect(updated.offsetMs).toBe(5000);
  });

  it('smooths over the last 5 samples (a single wild sample does not fully dominate)', () => {
    let state = initialClockState();
    for (let i = 0; i < 4; i++) {
      state = recordOffsetSample(
        state,
        new Date(1000).toISOString(),
        0,
        0,
        new Date().toISOString(),
      );
    }
    // 4 samples of ~1000ms, then one wild 100000ms sample — average should be pulled toward 1000, not equal to 100000.
    state = recordOffsetSample(
      state,
      new Date(100_000).toISOString(),
      0,
      0,
      new Date().toISOString(),
    );
    expect(state.offsetMs).toBeLessThan(30_000);
    expect(state.offsetMs).toBeGreaterThan(1000);
  });

  it('keeps only the last 5 samples in the window', () => {
    let state = initialClockState();
    for (let i = 1; i <= 7; i++) {
      state = recordOffsetSample(
        state,
        new Date(i * 1000).toISOString(),
        0,
        0,
        new Date().toISOString(),
      );
    }
    expect(state.samples).toHaveLength(5);
    expect(state.samples).toEqual([3000, 4000, 5000, 6000, 7000]);
  });

  it('stampNow applies the last-known offset and records the raw (uncorrected) time separately', () => {
    const state = { id: 'self' as const, offsetMs: -2000, samples: [-2000], lastMeasuredAt: null };
    const stamped = stampNow(state, 1_000_000_000_000);
    expect(new Date(stamped.rawDeviceTime).getTime()).toBe(1_000_000_000_000);
    expect(new Date(stamped.occurredAt).getTime()).toBe(1_000_000_000_000 - 2000);
    expect(stamped.clockOffsetMs).toBe(-2000);
  });

  describe('§6.3 skew policy', () => {
    it('bans the banner only past 2 minutes of offset', () => {
      expect(needsSkewBanner(60_000)).toBe(false); // 1 min
      expect(needsSkewBanner(3 * 60_000)).toBe(true); // 3 min
    });

    it('flags offset-suspect only past 24h', () => {
      expect(isOffsetSuspect(23 * 60 * 60 * 1000)).toBe(false);
      expect(isOffsetSuspect(25 * 60 * 60 * 1000)).toBe(true);
    });

    it('T-13: +3h device is banner-worthy but not offset-suspect', () => {
      const threeHours = 3 * 60 * 60 * 1000;
      expect(needsSkewBanner(threeHours)).toBe(true);
      expect(isOffsetSuspect(threeHours)).toBe(false);
    });

    it('T-13: +30h device IS offset-suspect (time_suspect tagging territory)', () => {
      const thirtyHours = 30 * 60 * 60 * 1000;
      expect(isOffsetSuspect(thirtyHours)).toBe(true);
    });

    it('T-13: -3h device is symmetric (abs value)', () => {
      expect(isOffsetSuspect(-30 * 60 * 60 * 1000)).toBe(true);
      expect(isOffsetSuspect(-3 * 60 * 60 * 1000)).toBe(false);
    });

    it('time_suspect fires when occurred_at is far in the future relative to the first server sighting, even with zero offset', () => {
      const relayReceivedAt = new Date('2026-08-17T00:00:00.000Z').toISOString();
      const occurredAt = new Date('2026-08-17T00:10:00.000Z').toISOString(); // 10 min "in the future" vs relay
      expect(isTimeSuspectAtApply(occurredAt, relayReceivedAt, 0)).toBe(true);
    });

    it('does not flag a claim inside the 5-minute grace window', () => {
      const relayReceivedAt = new Date('2026-08-17T00:00:00.000Z').toISOString();
      const occurredAt = new Date('2026-08-17T00:04:00.000Z').toISOString();
      expect(isTimeSuspectAtApply(occurredAt, relayReceivedAt, 0)).toBe(false);
    });
  });

  describe('§6.4 defensible_at', () => {
    it('passes occurred_at through unchanged when it is within the offline window', () => {
      const relayReceivedAt = new Date('2026-08-17T12:00:00.000Z').toISOString();
      const occurredAt = new Date('2026-08-17T08:00:00.000Z').toISOString(); // 4h before relay
      expect(computeDefensibleAt(occurredAt, relayReceivedAt)).toBe(occurredAt);
    });

    it('clamps a claim further back than max_offline_window to the lower bound', () => {
      const relayReceivedAt = new Date('2026-08-17T12:00:00.000Z').toISOString();
      const occurredAt = new Date('2026-08-15T12:00:00.000Z').toISOString(); // 48h before relay, default window is 24h
      const result = computeDefensibleAt(occurredAt, relayReceivedAt);
      expect(new Date(result).getTime()).toBe(
        new Date(relayReceivedAt).getTime() - 24 * 60 * 60 * 1000,
      );
    });

    it('clamps a future claim to relay_received_at itself (never lets a lying clock claim to be "later" than its first server sighting)', () => {
      const relayReceivedAt = new Date('2026-08-17T12:00:00.000Z').toISOString();
      const occurredAt = new Date('2026-08-20T12:00:00.000Z').toISOString(); // claims to be 3 days in the future
      expect(computeDefensibleAt(occurredAt, relayReceivedAt)).toBe(relayReceivedAt);
    });
  });

  describe('§6.4 offline-credential expiry provability (three-way)', () => {
    const exp = new Date('2026-08-17T00:00:00.000Z').toISOString();

    it('provable_valid when the first server sighting itself is before expiry', () => {
      const relay = new Date('2026-08-16T23:00:00.000Z').toISOString();
      const occurred = new Date('2026-08-16T22:00:00.000Z').toISOString();
      expect(evaluateExpiryProvability(occurred, relay, exp)).toBe('provable_valid');
    });

    it('unprovable when only the (attacker-controlled) claim is in-window but the first sighting is after expiry', () => {
      const relay = new Date('2026-08-17T02:00:00.000Z').toISOString(); // after exp
      const occurred = new Date('2026-08-16T23:00:00.000Z').toISOString(); // claims to be before exp
      expect(evaluateExpiryProvability(occurred, relay, exp)).toBe('unprovable');
    });

    it('unprovable with no relay sighting at all yet, as long as the claim itself is in-window', () => {
      const occurred = new Date('2026-08-16T23:00:00.000Z').toISOString();
      expect(evaluateExpiryProvability(occurred, null, exp)).toBe('unprovable');
    });

    it('expired when even the claim itself is past expiry — a backdated clock buys nothing further', () => {
      const occurred = new Date('2026-08-18T00:00:00.000Z').toISOString();
      expect(evaluateExpiryProvability(occurred, null, exp)).toBe('expired');
    });
  });
});
