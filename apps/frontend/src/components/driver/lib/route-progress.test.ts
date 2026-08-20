import { describe, expect, it } from 'vitest';
import { orderedDrops, routeProgress } from './route-progress';
import type { Drop, DropStatus } from './types';

function drop(dropSeq: number, status: DropStatus, id = `d${dropSeq}`): Drop {
  return {
    id,
    dropSeq,
    locationId: `loc-${dropSeq}`,
    locationName: `Outlet ${dropSeq}`,
    city: 'Samarinda',
    address: null,
    latitude: null,
    longitude: null,
    deliveryInstructions: null,
    replenishmentRequestId: null,
    status,
    departedAt: null,
    arrivedAt: null,
    receivedBy: null,
    receivedAt: null,
    signatureUrl: null,
    photoUrls: [],
    discrepancyNotes: null,
    lines: [],
  };
}

describe('routeProgress', () => {
  it('points at the lowest-seq open stop, not the first in array order', () => {
    // Deliberately out of order: the API is free to return drops unsorted, and
    // "next stop" must follow the dispatcher's sequence, not the payload's.
    const p = routeProgress([drop(3, 'pending'), drop(1, 'completed'), drop(2, 'pending')]);
    expect(p.nextDropId).toBe('d2');
    expect(p.done).toBe(1);
    expect(p.remaining).toBe(2);
  });

  it('counts a discrepancy delivery as delivered, and reports it separately', () => {
    const p = routeProgress([drop(1, 'completed_discrepancy'), drop(2, 'completed')]);
    expect(p.done).toBe(2);
    expect(p.withDiscrepancy).toBe(1);
    expect(p.complete).toBe(true);
  });

  it('treats a failed stop as finished for sequencing but never as delivered', () => {
    const p = routeProgress([drop(1, 'failed'), drop(2, 'pending')]);
    expect(p.failed).toBe(1);
    expect(p.done).toBe(0);
    expect(p.nextDropId).toBe('d2');
    expect(p.remaining).toBe(1);
  });

  it('a run whose every stop failed is complete, with nothing delivered', () => {
    const p = routeProgress([drop(1, 'failed'), drop(2, 'failed')]);
    expect(p.complete).toBe(true);
    expect(p.done).toBe(0);
    expect(p.remaining).toBe(0);
  });

  it('an EMPTY route is not complete — a truck with no stops has not finished its day', () => {
    const p = routeProgress([]);
    expect(p.complete).toBe(false);
    expect(p.nextDropId).toBeNull();
  });

  it('orderedDrops does not mutate its input', () => {
    const input = [drop(2, 'pending'), drop(1, 'pending')];
    const sorted = orderedDrops(input);
    expect(sorted.map((d) => d.dropSeq)).toEqual([1, 2]);
    expect(input.map((d) => d.dropSeq)).toEqual([2, 1]);
  });
});
