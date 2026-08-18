import { describe, it, expect } from 'vitest';
import {
  formatCloudDocNumber,
  parseCloudDocNumber,
  formatDeviceDocNumber,
  formatShiftNumber,
} from './doc-number';

describe('cloud document numbers', () => {
  it('formats per CONTRACTS.md §0 example', () => {
    expect(formatCloudDocNumber('SJ', '202608', 42)).toBe('SJ/202608/0042');
    expect(formatCloudDocNumber('PO', '202608', 7)).toBe('PO/202608/0007');
  });

  it('round-trips through parse', () => {
    const formatted = formatCloudDocNumber('OPN', '202601', 123);
    expect(parseCloudDocNumber(formatted)).toEqual({ prefix: 'OPN', period: '202601', seq: 123 });
  });

  it('rejects a malformed period', () => {
    expect(() => formatCloudDocNumber('SJ', '2026-08', 1)).toThrow(RangeError);
  });

  it('returns null for a non-matching string', () => {
    expect(parseCloudDocNumber('not-a-doc-number')).toBeNull();
  });
});

describe('device-born document numbers', () => {
  it('formats a local-sequence number', () => {
    expect(formatDeviceDocNumber('BPP01', 'KSR1', 15)).toBe('BPP01-KSR1-15');
  });

  it('formats a shift number with the S prefix', () => {
    expect(formatShiftNumber('BPP01', 'KSR1', 3)).toBe('BPP01-KSR1-S3');
  });

  it('rejects a non-positive sequence', () => {
    expect(() => formatDeviceDocNumber('BPP01', 'KSR1', 0)).toThrow(RangeError);
  });
});
