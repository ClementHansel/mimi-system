import { describe, it, expect } from 'vitest';
import type { TempLog } from './index';

/**
 * `TempLog` is a pure resource shape (no runtime logic lives in this
 * package — `cold-chain.service.ts` populates `breachedClasses`/`ranges`
 * from `sj_temperature_logs.notes`, this package only names the shape). As
 * with the sync-protocol wire types, the assertion here IS that this file
 * type-checks: a field renamed or dropped without updating every producer/
 * consumer would fail here first.
 */
describe('TempLog — per-goods-class breach detail (2026-08-17 owner ruling)', () => {
  it('a non-breach reading omits breachedClasses/ranges entirely', () => {
    const log: TempLog = {
      id: 'log-1',
      dropId: null,
      stage: 'load',
      tempC: '-20.0',
      isBreach: false,
      loggedBy: 'Driver Budi',
      loggedAt: '2026-08-17T02:00:00.000Z',
    };
    expect(log.breachedClasses).toBeUndefined();
    expect(log.ranges).toBeUndefined();
  });

  it('a single-class breach names exactly that class and its range', () => {
    const log: TempLog = {
      id: 'log-2',
      dropId: 'drop-1',
      stage: 'arrive',
      tempC: '-10.0',
      isBreach: true,
      breachedClasses: ['frozen'],
      ranges: { frozen: { min: '-25.0', max: '-15.0' } },
      loggedBy: 'Driver Budi',
      loggedAt: '2026-08-17T05:00:00.000Z',
    };
    expect(log.breachedClasses).toEqual(['frozen']);
    expect(log.ranges?.frozen).toEqual({ min: '-25.0', max: '-15.0' });
    expect(log.ranges?.chilled).toBeUndefined();
  });

  it('one reading can breach BOTH classes on a mixed load at once', () => {
    const log: TempLog = {
      id: 'log-3',
      dropId: 'drop-2',
      stage: 'depart',
      tempC: '10.0',
      isBreach: true,
      breachedClasses: ['frozen', 'chilled'],
      ranges: {
        frozen: { min: '-25.0', max: '-15.0' },
        chilled: { min: '0.0', max: '5.0' },
      },
      loggedBy: 'Driver Budi',
      loggedAt: '2026-08-17T06:00:00.000Z',
    };
    expect(log.breachedClasses).toHaveLength(2);
    expect(Object.keys(log.ranges ?? {})).toEqual(['frozen', 'chilled']);
  });

  it('a range side (min or max) may be null, matching storage_areas allowing an open-ended bound', () => {
    const log: TempLog = {
      id: 'log-4',
      dropId: null,
      stage: 'load',
      tempC: '10.0',
      isBreach: true,
      breachedClasses: ['chilled'],
      ranges: { chilled: { min: null, max: '5.0' } },
      loggedBy: 'Driver Budi',
      loggedAt: '2026-08-17T07:00:00.000Z',
    };
    expect(log.ranges?.chilled?.min).toBeNull();
  });
});
