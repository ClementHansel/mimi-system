import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseClientSeq, formatClientSeq } from './types';
import type {
  SyncBootstrapPage,
  SyncBootstrapRequest,
  SyncChecksumMessage,
  SyncDeliverMessage,
  SyncHealthResponse,
  SyncHelloAck,
  SyncHeartbeatAck,
  SyncHeartbeatMessage,
  SyncScope,
} from './types';

describe('parseClientSeq / formatClientSeq — the client_seq wire boundary', () => {
  it('round-trips a real BIGINT-scale value', () => {
    const huge = 9_007_199_254_740_993n; // one past Number.MAX_SAFE_INTEGER
    expect(parseClientSeq(formatClientSeq(huge))).toBe(huge);
  });

  it('parses a plain decimal string', () => {
    expect(parseClientSeq('184223')).toBe(184223n);
    expect(parseClientSeq('0')).toBe(0n);
  });

  it('formats back to the exact wire string', () => {
    expect(formatClientSeq(184223n)).toBe('184223');
    expect(formatClientSeq(0n)).toBe('0');
  });

  it('rejects a negative client_seq on format', () => {
    expect(() => formatClientSeq(-1n)).toThrow(RangeError);
  });

  it('rejects a non-integer wire string on parse', () => {
    expect(() => parseClientSeq('12.5')).toThrow(RangeError);
    expect(() => parseClientSeq('-5')).toThrow(RangeError);
    expect(() => parseClientSeq('abc')).toThrow(RangeError);
    expect(() => parseClientSeq('')).toThrow(RangeError);
  });

  it('property: parse(format(x)) === x for any non-negative bigint, including values beyond Number.MAX_SAFE_INTEGER', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (seq) => {
        expect(parseClientSeq(formatClientSeq(seq))).toBe(seq);
      }),
    );
  });
});

/**
 * SYNC-PROTOCOL.md v1.2 (interop fix): five wire messages previously existed
 * only as prose (`sync:heartbeat`, `sync:checksum`, `sync:deliver`, the
 * health response, and bootstrap) — exactly the condition that let W2-D and
 * W2-F build incompatible readings of `sync:hello`/`sync:push` before those
 * got frozen types. These are compile-time-only checks: there is no runtime
 * logic to exercise (they're pure shapes), so the assertion IS that this
 * file type-checks — a field renamed or dropped without updating a producer/
 * consumer elsewhere would fail here first.
 */
describe('the five previously prose-only wire messages now have one frozen shape', () => {
  it('SyncHeartbeatMessage (§4.6) — device/node telemetry, class T, field-set-identical to the shipped W2-E/CONTRACTS §7.2 artifact', () => {
    const deviceHeartbeat: SyncHeartbeatMessage = {
      deviceId: 'device-1',
      at: '2026-08-17T09:31:02.113Z',
      queueDepth: 3,
      quarantineDepth: 0,
      pullLag: 12,
      lastSyncAt: '2026-08-17T09:30:00.000Z',
      storage: { usedMb: 4200, quotaMb: 50_000 },
      clockOffsetMs: -1250,
      appVersion: '1.4.2',
      batteryPct: 81,
      networkType: 'wifi',
      activeUserId: 'user-1',
      shiftOpen: true,
    };
    const nodeHeartbeat: SyncHeartbeatMessage = {
      deviceId: 'node-1',
      at: '2026-08-17T09:31:02.113Z',
      queueDepth: 0,
      quarantineDepth: 0,
      pullLag: 0,
      lastSyncAt: '2026-08-17T09:30:00.000Z',
      storage: { usedMb: 500, quotaMb: 100_000 },
      clockOffsetMs: 10,
      appVersion: '1.4.2',
      deviceSummaries: [
        { deviceId: 'device-1', lastSeenAt: '2026-08-17T09:30:50.000Z', queueDepth: 2 },
      ],
    };
    expect(deviceHeartbeat.storage.usedMb).toBeLessThan(deviceHeartbeat.storage.quotaMb);
    expect(nodeHeartbeat.deviceSummaries).toHaveLength(1);
    expect(deviceHeartbeat.shiftOpen).toBe(true);
  });

  it('SyncHeartbeatAck (§4.6) — piggybacked, not a per-event ack', () => {
    const ack: SyncHeartbeatAck = {
      confirmedThrough: { 'device-1': 5521 },
      serverTime: '2026-08-17T09:31:02.500Z',
    };
    expect(ack.confirmedThrough['device-1']).toBe(5521);
  });

  it('SyncChecksumMessage (§5.5 R2) — the {locationId, asOfCursor, areaHashes} shape by name', () => {
    const message: SyncChecksumMessage = {
      locationId: 'loc-1',
      asOfCursor: 184223,
      areaHashes: { 'area-freezer': 'a1b2c3d4e5f60708', 'area-dry': '0102030405060708' },
    };
    expect(Object.keys(message.areaHashes)).toEqual(['area-freezer', 'area-dry']);
  });

  it('SyncDeliverMessage (§4.5) — same event shape as a pull page, no hasMore (it is a live feed)', () => {
    const message: SyncDeliverMessage = { events: [], nextCursor: 184300 };
    expect(message).not.toHaveProperty('hasMore');
  });

  it('SyncHealthResponse (§4.1/§4.8) — the upstream-probe shape', () => {
    const cloudHealth: SyncHealthResponse = {
      ok: true,
      protocolV: 1,
      serverTime: '2026-08-17T09:31:02.500Z',
      tier: 'cloud',
    };
    const nodeHealth: SyncHealthResponse = {
      ok: true,
      protocolV: 1,
      serverTime: '2026-08-17T09:31:02.500Z',
      tier: 'node',
    };
    expect(cloudHealth.tier).not.toBe(nodeHealth.tier);
  });

  it('SyncBootstrapRequest / SyncBootstrapPage (§4.6)', () => {
    const scope: SyncScope = {
      globalMaster: true,
      locationIds: ['loc-1'],
      projectionRole: 'pos_device',
      excludeOrigin: 'device-1',
    };
    const request: SyncBootstrapRequest = { scope };
    const page: SyncBootstrapPage = {
      snapshotId: 'snap-1',
      page: 0,
      hasMore: true,
      startingCursor: 184223,
      events: [],
    };
    expect(request.scope.projectionRole).toBe('pos_device');
    expect(page.hasMore).toBe(true);
  });
});

describe("SyncHelloAck.cursorExpired — the flag §4.5's bootstrap-trigger prose already relied on", () => {
  it('an ordinary hello:ack omits the flag entirely', () => {
    const ack: SyncHelloAck = {
      ok: true,
      protocolV: 1,
      serverTime: '2026-08-17T09:31:02.500Z',
      resumeCursor: 184223,
      confirmedThrough: { 'device-1': 5521 },
      scope: {
        globalMaster: true,
        locationIds: ['loc-1'],
        projectionRole: 'pos_device',
        excludeOrigin: 'device-1',
      },
    };
    expect(ack.cursorExpired).toBeUndefined();
  });

  it('a stale-subscriber hello:ack can express cursorExpired: true, forcing a re-bootstrap (§4.6)', () => {
    const ack: SyncHelloAck = {
      ok: true,
      protocolV: 1,
      serverTime: '2026-08-17T09:31:02.500Z',
      resumeCursor: 184223,
      confirmedThrough: { 'device-1': 5521 },
      scope: {
        globalMaster: true,
        locationIds: ['loc-1'],
        projectionRole: 'pos_device',
        excludeOrigin: 'device-1',
      },
      cursorExpired: true,
    };
    expect(ack.cursorExpired).toBe(true);
  });
});
