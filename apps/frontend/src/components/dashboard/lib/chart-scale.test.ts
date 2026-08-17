import { describe, it, expect } from 'vitest';
import { ratiosForChart } from './chart-scale';

describe('ratiosForChart', () => {
  it('scales decimal-string wire values relative to the max', () => {
    expect(ratiosForChart(['1000000.00', '2000000.00', '4000000.00'])).toEqual([0.25, 0.5, 1]);
  });

  it('returns all-zero ratios for an all-zero series instead of dividing by zero', () => {
    expect(ratiosForChart(['0.00', '0.00'])).toEqual([0, 0]);
  });

  it('treats malformed/empty values as zero rather than NaN or crashing', () => {
    expect(ratiosForChart(['', 'not-a-number', '500.00'])).toEqual([0, 0, 1]);
  });

  it('never negatively scales a negative figure below zero height', () => {
    expect(ratiosForChart(['-100.00', '100.00'])).toEqual([0, 1]);
  });
});
