import { describe, it, expect } from 'vitest';
import { nextActionForDrop, sealForDrop, tempLogsForDrop } from './cold-chain';
import type { Drop, Seal, SuratJalan } from './types';

const BASE_DROP: Drop = {
  id: 'drop-1',
  dropSeq: 1,
  locationId: 'loc-1',
  locationName: 'Outlet A',
  city: 'Balikpapan',
  replenishmentRequestId: null,
  status: 'pending',
  departedAt: null,
  arrivedAt: null,
  receivedBy: null,
  receivedAt: null,
  signatureUrl: null,
  photoUrls: [],
  discrepancyNotes: null,
  lines: [],
};

function makeSj(overrides: Partial<SuratJalan> = {}): SuratJalan {
  return {
    id: 'sj-1',
    sjNumber: 'SJ-001',
    originLocationId: 'origin-1',
    shipmentType: 'frozen',
    driver: { id: 'driver-1', name: 'Budi', phone: null },
    vehicle: { id: 'veh-1', plateNumber: 'KT 1234 AB', hasFreezer: true },
    status: 'in_transit',
    plannedDate: '2026-08-17',
    dispatchedAt: null,
    completedAt: null,
    drops: [BASE_DROP],
    seals: [],
    tempLogs: [],
    createdBy: 'kepala_gudang-1',
    ...overrides,
  };
}

describe('nextActionForDrop — per-drop gating (D-14 multi-drop sequence)', () => {
  it('requires depart first when nothing has happened yet', () => {
    expect(nextActionForDrop(BASE_DROP)).toBe('depart');
  });

  it('requires arrive once departed', () => {
    expect(nextActionForDrop({ ...BASE_DROP, status: 'en_route', departedAt: '2026-08-17T01:00:00Z' })).toBe('arrive');
  });

  it('requires serah-terima (receive) once arrived', () => {
    expect(
      nextActionForDrop({
        ...BASE_DROP,
        status: 'arrived',
        departedAt: '2026-08-17T01:00:00Z',
        arrivedAt: '2026-08-17T02:00:00Z',
      }),
    ).toBe('receive');
  });

  it.each(['completed', 'completed_discrepancy', 'failed'] as const)('offers no further action once terminal (%s)', (status) => {
    expect(nextActionForDrop({ ...BASE_DROP, status, departedAt: 'x', arrivedAt: 'y' })).toBe('none');
  });

  it('never blocks drop N+1 on drop N — gating is per-drop status only, not dropSeq order', () => {
    const laterDrop: Drop = { ...BASE_DROP, id: 'drop-2', dropSeq: 2, status: 'pending' };
    // drop-1 (seq 1) hasn't departed; drop-2 (seq 2) is independently gate-able.
    expect(nextActionForDrop(BASE_DROP)).toBe('depart');
    expect(nextActionForDrop(laterDrop)).toBe('depart');
  });
});

describe('sealForDrop / tempLogsForDrop', () => {
  it('prefers a drop-specific seal over an SJ-wide one', () => {
    const seals: Seal[] = [
      { id: 'seal-wide', dropId: null, sealNumber: 'WIDE-1', status: 'applied', checkedBy: null, checkedAt: null },
      { id: 'seal-specific', dropId: 'drop-1', sealNumber: 'SPEC-1', status: 'applied', checkedBy: null, checkedAt: null },
    ];
    const sj = makeSj({ seals });
    expect(sealForDrop(sj, 'drop-1')?.id).toBe('seal-specific');
  });

  it('falls back to the SJ-wide seal when no drop-specific one exists', () => {
    const seals: Seal[] = [{ id: 'seal-wide', dropId: null, sealNumber: 'WIDE-1', status: 'applied', checkedBy: null, checkedAt: null }];
    const sj = makeSj({ seals });
    expect(sealForDrop(sj, 'drop-1')?.id).toBe('seal-wide');
  });

  it('returns null when the SJ tracked no seal at all', () => {
    expect(sealForDrop(makeSj({ seals: [] }), 'drop-1')).toBeNull();
  });

  it('returns temp logs for one drop, most recent first', () => {
    const sj = makeSj({
      tempLogs: [
        { id: 'l1', dropId: 'drop-1', stage: 'depart', tempC: '-18.0', isBreach: false, loggedBy: 'driver-1', loggedAt: '2026-08-17T01:00:00Z' },
        { id: 'l2', dropId: 'drop-1', stage: 'arrive', tempC: '-19.0', isBreach: false, loggedBy: 'driver-1', loggedAt: '2026-08-17T03:00:00Z' },
        { id: 'l3', dropId: 'drop-2', stage: 'depart', tempC: '-17.0', isBreach: false, loggedBy: 'driver-1', loggedAt: '2026-08-17T01:30:00Z' },
      ],
    });
    const logs = tempLogsForDrop(sj, 'drop-1');
    expect(logs.map((l) => l.id)).toEqual(['l2', 'l1']);
  });

  /**
   * The owner's ruling (post-launch fix): `frozen` SJs are the cold-chain
   * truck and carry BOTH chilled (0..5°C) and frozen (-25..-15°C) goods, so
   * the acceptable range is per-class and only the backend (which knows
   * `storage_areas` and which lines are still onboard) can evaluate it.
   * This module deliberately exposes NO breach predicate of its own —
   * `tempLogsForDrop` passes the server's `isBreach` straight through,
   * unmodified, for every temp log regardless of its value. A 3.0°C chiller
   * reading (legitimate — well inside 0..5°C) and a -18.0°C freezer reading
   * (also legitimate) sit side by side below with whatever `isBreach` the
   * server assigned; this test would have caught the old bug, where a
   * single static -25..-15°C range would have mislabeled the chiller
   * reading a breach regardless of what the server said.
   */
  it('surfaces exactly the server-provided isBreach per log — no re-evaluation, even for a legitimate chiller-range reading', () => {
    const sj = makeSj({
      tempLogs: [
        { id: 'chiller-ok', dropId: 'drop-1', stage: 'depart', tempC: '3.0', isBreach: false, loggedBy: 'driver-1', loggedAt: '2026-08-17T01:00:00Z' },
        { id: 'freezer-ok', dropId: 'drop-1', stage: 'depart', tempC: '-18.0', isBreach: false, loggedBy: 'driver-1', loggedAt: '2026-08-17T01:00:01Z' },
        { id: 'freezer-breach', dropId: 'drop-1', stage: 'arrive', tempC: '-8.0', isBreach: true, loggedBy: 'driver-1', loggedAt: '2026-08-17T03:00:00Z' },
      ],
    });
    const logs = tempLogsForDrop(sj, 'drop-1');
    const byId = Object.fromEntries(logs.map((l) => [l.id, l.isBreach]));
    expect(byId).toEqual({ 'chiller-ok': false, 'freezer-ok': false, 'freezer-breach': true });
  });
});
