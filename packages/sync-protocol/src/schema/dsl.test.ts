import { describe, it, expect } from 'vitest';
import {
  array,
  boolean,
  enumOf,
  isoDate,
  isoDateTime,
  literal,
  money,
  nullable,
  number,
  object,
  optional,
  qty,
  string,
  temp,
  unknownField,
  uuid,
  validate,
} from './dsl';

function ok(result: ReturnType<typeof validate>): boolean {
  return result.ok;
}

describe('primitive fields', () => {
  it('string', () => {
    expect(ok(validate(string(), 'hello'))).toBe(true);
    expect(ok(validate(string(), 42))).toBe(false);
  });

  it('uuid', () => {
    expect(ok(validate(uuid(), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'))).toBe(true);
    expect(ok(validate(uuid(), 'not-a-uuid'))).toBe(false);
    expect(ok(validate(uuid(), 42))).toBe(false);
  });

  it('money/qty/temp validate real decimal-string scales via @mimi/shared parsing (one validator, not a second regex)', () => {
    expect(ok(validate(money(), '125000.00'))).toBe(true);
    expect(ok(validate(money(), '125000'))).toBe(true); // fewer decimals than the scale is fine (padded)
    expect(ok(validate(money(), '125000.000'))).toBe(false); // MORE than 2dp exceeds money's scale — invalid
    expect(ok(validate(qty(), '12.500'))).toBe(true);
    expect(ok(validate(qty(), '12.5000'))).toBe(false); // MORE than 3dp exceeds qty's scale — invalid
    expect(ok(validate(temp(), '-18.0'))).toBe(true);
    expect(ok(validate(temp(), '-18.00'))).toBe(false); // MORE than 1dp exceeds temp's scale — invalid
    expect(ok(validate(money(), 'not-a-number'))).toBe(false);
    expect(ok(validate(money(), 42))).toBe(false);
  });

  it('isoDate', () => {
    expect(ok(validate(isoDate(), '2026-08-17'))).toBe(true);
    expect(ok(validate(isoDate(), '2026-08-17T00:00:00.000Z'))).toBe(false);
    expect(ok(validate(isoDate(), 'not-a-date'))).toBe(false);
  });

  it('isoDateTime', () => {
    expect(ok(validate(isoDateTime(), '2026-08-17T05:00:00.000Z'))).toBe(true);
    expect(ok(validate(isoDateTime(), 'not-a-datetime'))).toBe(false);
  });

  it('boolean / number', () => {
    expect(ok(validate(boolean(), true))).toBe(true);
    expect(ok(validate(boolean(), 'true'))).toBe(false);
    expect(ok(validate(number(), 42))).toBe(true);
    expect(ok(validate(number(), Number.NaN))).toBe(false);
    expect(ok(validate(number(), '42'))).toBe(false);
  });

  it('literal', () => {
    const schema = literal('cash');
    expect(ok(validate(schema, 'cash'))).toBe(true);
    expect(ok(validate(schema, 'qris'))).toBe(false);
  });

  it('enumOf', () => {
    const schema = enumOf(['cash', 'qris', 'bank_transfer'] as const);
    expect(ok(validate(schema, 'qris'))).toBe(true);
    expect(ok(validate(schema, 'bitcoin'))).toBe(false);
  });

  it('unknownField accepts anything, including undefined', () => {
    expect(ok(validate(unknownField(), 'anything'))).toBe(true);
    expect(ok(validate(unknownField(), { nested: true }))).toBe(true);
    expect(ok(validate(unknownField(), undefined))).toBe(true);
  });
});

describe('array', () => {
  it('validates every element', () => {
    expect(ok(validate(array(string()), ['a', 'b', 'c']))).toBe(true);
    expect(ok(validate(array(string()), ['a', 42, 'c']))).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(ok(validate(array(string()), 'not-an-array'))).toBe(false);
  });

  it('accepts an empty array', () => {
    expect(ok(validate(array(string()), []))).toBe(true);
  });

  it('reports a path pinpointing which element failed', () => {
    const result = validate(array(string()), ['a', 42], '$.lines');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('$.lines[1]');
  });
});

describe('object', () => {
  const schema = object({ id: uuid(), name: string(), age: optional(number()) });

  it('accepts a fully-populated object', () => {
    expect(ok(validate(schema, { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Ayam', age: 3 }))).toBe(true);
  });

  it('accepts an optional field being absent', () => {
    expect(ok(validate(schema, { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'Ayam' }))).toBe(true);
  });

  it('rejects a missing required field', () => {
    expect(ok(validate(schema, { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }))).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(ok(validate(schema, 'not-an-object'))).toBe(false);
    expect(ok(validate(schema, ['a', 'b']))).toBe(false);
    expect(ok(validate(schema, null))).toBe(false);
  });

  it('does NOT reject unknown extra properties (SYNC-PROTOCOL §2.3 additive-only versioning)', () => {
    expect(
      ok(
        validate(schema, {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          name: 'Ayam',
          aBrandNewFieldFromAFutureAppVersion: 'whatever',
        }),
      ),
    ).toBe(true);
  });

  it('validates nested objects and reports a dotted path', () => {
    const nested = object({ line: object({ productId: uuid(), qty: qty() }) });
    const result = validate(nested, { line: { productId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', qty: 'bad' } }, '$');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('$.line.qty');
  });

  it('collects every failing field, not just the first', () => {
    const result = validate(schema, { id: 'not-a-uuid', name: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });
});

describe('nullable', () => {
  it('accepts null or the wrapped type, rejects everything else', () => {
    const schema = nullable(string());
    expect(ok(validate(schema, null))).toBe(true);
    expect(ok(validate(schema, 'hello'))).toBe(true);
    expect(ok(validate(schema, undefined))).toBe(false);
    expect(ok(validate(schema, 42))).toBe(false);
  });
});

describe('optional', () => {
  it('accepts undefined or the wrapped type, rejects null', () => {
    const schema = optional(string());
    expect(ok(validate(schema, undefined))).toBe(true);
    expect(ok(validate(schema, 'hello'))).toBe(true);
    expect(ok(validate(schema, null))).toBe(false);
  });
});

describe('error-message robustness — describing an invalid value must never itself throw', () => {
  it('does not throw when a bigint reaches a string/uuid/isoDate field validation failure', () => {
    expect(() => validate(uuid(), 42n)).not.toThrow();
    expect(() => validate(isoDate(), 42n)).not.toThrow();
    expect(() => validate(money(), 42n)).not.toThrow();
    expect(() => validate(enumOf(['a', 'b'] as const), 42n)).not.toThrow();
    expect(() => validate(literal('a'), 42n)).not.toThrow();
  });

  it('reports failure (not a crash) for a bigint in a typed field', () => {
    expect(ok(validate(uuid(), 42n))).toBe(false);
  });
});
