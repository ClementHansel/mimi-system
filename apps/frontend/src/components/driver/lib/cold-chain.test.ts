import { describe, it, expect } from 'vitest';
import { isFrozenBreach, nextActionForDrop, sealForDrop, tempLogsForDrop, FROZEN_TEMP_RANGE } from './cold-chain';
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

describe('isFrozenBreach — cold-chain breach rule (D-14, OBJ-03)', () => {
  it('flags a reading colder than -25.0°C on a frozen shipment', () => {
    expect(isFrozenBreach('-27.0', 'frozen')).toBe(true);
  });

  it('flags a reading warmer than -15.0°C on a frozen shipment', () => {
    expect(isFrozenBreach('-10.0', 'frozen')).toBe(true);
  });

  it('does NOT flag a reading inside the frozen range', () => {
    expect(isFrozenBreach('-18.0', 'frozen')).toBe(false);
  });

  it('treats the exact boundary values as within range (inclusive)', () => {
    expect(isFrozenBreach(String(FROZEN_TEMP_RANGE.min), 'frozen')).toBe(false);
    expect(isFrozenBreach(String(FROZEN_TEMP_RANGE.max), 'frozen')).toBe(false);
  });

  it('never flags a breach for a dry shipment, however extreme the reading', () => {
    expect(isFrozenBreach('40.0', 'dry')).toBe(false);
  });

  it('is not a breach when no reading has been entered yet — never blocks the form', () => {
    expect(isFrozenBreach(null, 'frozen')).toBe(false);
  });

  it('still records an out-of-range reading rather than rejecting it (the "record it honestly" rule) — the caller decides to submit, this predicate only flags', () => {
    // isFrozenBreach never throws or returns an error — it's purely advisory.
    expect(() => isFrozenBreach('-99.9', 'frozen')).not.toThrow();
    expect(isFrozenBreach('-99.9', 'frozen')).toBe(true);
  });
});

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
});
