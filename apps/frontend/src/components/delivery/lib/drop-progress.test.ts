import { describe, it, expect } from 'vitest';
import { isDropTerminal, dropProgressRank, dropProgressTotal, routeCompletion, type DropStatusKey } from './drop-progress';

describe('drop status ladder — pending -> en_route -> arrived -> terminal', () => {
  it('ranks the live statuses in strict increasing order', () => {
    expect(dropProgressRank('pending')).toBe(0);
    expect(dropProgressRank('en_route')).toBe(1);
    expect(dropProgressRank('arrived')).toBe(2);
  });

  it.each(['completed', 'completed_discrepancy', 'failed'] as const)(
    'ranks every terminal status (%s) one past the live ladder — never a step backward',
    (status) => {
      expect(dropProgressRank(status)).toBe(dropProgressTotal() - 1);
      expect(dropProgressRank(status)).toBeGreaterThan(dropProgressRank('arrived'));
    },
  );

  it('never lets a later status rank behind an earlier one on the live ladder', () => {
    const order: DropStatusKey[] = ['pending', 'en_route', 'arrived'];
    for (let i = 1; i < order.length; i++) {
      expect(dropProgressRank(order[i]!)).toBeGreaterThan(dropProgressRank(order[i - 1]!));
    }
  });

  it.each(['pending', 'en_route', 'arrived'] as const)('%s is not terminal', (status) => {
    expect(isDropTerminal(status)).toBe(false);
  });

  it.each(['completed', 'completed_discrepancy', 'failed'] as const)('%s is terminal', (status) => {
    expect(isDropTerminal(status)).toBe(true);
  });
});

describe('routeCompletion — truck-level rollup for the dispatcher list/detail', () => {
  it('counts only terminal drops as done', () => {
    const drops = [
      { id: '1', status: 'completed' as const },
      { id: '2', status: 'completed_discrepancy' as const },
      { id: '3', status: 'failed' as const },
      { id: '4', status: 'en_route' as const },
      { id: '5', status: 'pending' as const },
    ];
    expect(routeCompletion(drops)).toEqual({ done: 3, total: 5 });
  });

  it('an empty route reports 0 of 0', () => {
    expect(routeCompletion([])).toEqual({ done: 0, total: 0 });
  });

  it('a fully completed route reports done === total', () => {
    const drops = [{ id: '1', status: 'completed' as const }, { id: '2', status: 'failed' as const }];
    expect(routeCompletion(drops)).toEqual({ done: 2, total: 2 });
  });
});
