import { describe, it, expect } from 'vitest';
import { formatUuidV7, isUuidV7, extractUuidV7Timestamp, outboxDedupeKey } from './idempotency';

function bytes(...values: number[]): Uint8Array {
  const arr = new Uint8Array(10);
  for (let i = 0; i < 10; i++) arr[i] = values[i % values.length] ?? 0;
  return arr;
}

describe('formatUuidV7', () => {
  it('produces a string matching the UUIDv7 shape (version 7, RFC 9562 variant)', () => {
    const id = formatUuidV7(Date.parse('2026-08-17T00:00:00.000Z'), bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase()); // variant bits
  });

  it('is deterministic given the same inputs', () => {
    const ts = Date.parse('2026-08-17T02:31:00.000Z');
    const rand = bytes(9, 9, 9, 9, 9, 9, 9, 9, 9, 9);
    expect(formatUuidV7(ts, rand)).toBe(formatUuidV7(ts, rand));
  });

  it('encodes the timestamp recoverably', () => {
    const ts = Date.parse('2026-08-17T02:31:00.000Z');
    const id = formatUuidV7(ts, bytes(0));
    expect(extractUuidV7Timestamp(id)).toBe(ts);
  });

  it('is time-ordered: a later timestamp sorts after an earlier one lexicographically', () => {
    const early = formatUuidV7(Date.parse('2026-01-01T00:00:00.000Z'), bytes(5));
    const late = formatUuidV7(Date.parse('2026-12-31T00:00:00.000Z'), bytes(5));
    expect(early < late).toBe(true);
  });

  it('rejects insufficient randomness', () => {
    expect(() => formatUuidV7(Date.now(), new Uint8Array(5))).toThrow(RangeError);
  });

  it('rejects a negative timestamp', () => {
    expect(() => formatUuidV7(-1, bytes(0))).toThrow(RangeError);
  });
});

describe('isUuidV7', () => {
  it('rejects a UUIDv4', () => {
    expect(isUuidV7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isUuidV7('not-a-uuid')).toBe(false);
  });
});

describe('outboxDedupeKey', () => {
  it('combines origin and seq into one stable key', () => {
    expect(outboxDedupeKey('device-1', 42n)).toBe('device-1:42');
  });

  it('distinguishes different origins at the same seq', () => {
    expect(outboxDedupeKey('device-1', 5n)).not.toBe(outboxDedupeKey('device-2', 5n));
  });
});
