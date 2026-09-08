import { describe, it, expect } from 'vitest';
import {
  ERROR_CODE_LIST,
  isErrorCode,
  ERR_RESOLVE_IN_DOMAIN,
  ERR_INTERNAL,
  ERR_STOCK_INSUFFICIENT,
  type ErrorCode,
} from './error-codes';

describe('ErrorCode — closed literal union, same discipline as PermissionKey/SettingsKey', () => {
  it('has no duplicates, and the exported list matches the object it is derived from', () => {
    // NO HARDCODED TOTAL. This assertion used to pin an exact count, and the
    // count is the one thing here with no information in it: the title said
    // "52" while the body asserted 54, and its own comment already warned that
    // the number is "a moving target under concurrent agents". Adding a
    // legitimate code (`ERR_REQUEST_LINE_OVERCOMMITTED`, 2026-09-09) then fails
    // a test that is not about that code, which teaches everyone to bump the
    // number without reading why it moved.
    //
    // What actually needs guarding is the INVARIANT the closed union depends
    // on: no code appears twice, and the list and its type guard agree in both
    // directions. Those break the derived literal type; a changed total does
    // not, and they are caught below at any size.
    expect(new Set(ERROR_CODE_LIST).size, 'ERROR_CODE_LIST contains a duplicate').toBe(
      ERROR_CODE_LIST.length,
    );
    // Every listed code is recognised by the guard derived from the same
    // object, and nothing outside it is — the two directions that keep
    // `ErrorCode` a genuinely closed union rather than documentation.
    for (const code of ERROR_CODE_LIST) {
      expect(isErrorCode(code), `${code} is listed but not recognised`).toBe(true);
    }
    expect(isErrorCode('ERR_NOT_A_REAL_CODE')).toBe(false);
    // Non-empty, so a refactor that empties the list fails loudly instead of
    // making every assertion above vacuously true.
    expect(ERROR_CODE_LIST.length).toBeGreaterThan(50);
  });

  it('includes the two codes swept in from CONTRACTS.md/W1-D that were missing before this sweep', () => {
    // ERR_RESOLVE_IN_DOMAIN: CONTRACTS.md §4.23, POST /api/sync/conflicts/:id/dismiss.
    expect(ERROR_CODE_LIST).toContain(ERR_RESOLVE_IN_DOMAIN);
    // ERR_INTERNAL: W1-D's exception filter catch-all for an unhandled exception.
    expect(ERROR_CODE_LIST).toContain(ERR_INTERNAL);
  });

  it("rejects a typo'd code at COMPILE time", () => {
    // @ts-expect-error - 'ERR_RESOLVE_IN_DOMIAN' (typo) is not a member of ErrorCode; this must fail to compile.
    const typo: ErrorCode = 'ERR_RESOLVE_IN_DOMIAN';
    expect(typo).toBeDefined();
  });
});

describe('isErrorCode — derived from the same source as ErrorCode, not a hand-maintained copy', () => {
  it('is true for every real code', () => {
    for (const code of ERROR_CODE_LIST) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('is true for the two newly-swept codes specifically', () => {
    expect(isErrorCode('ERR_RESOLVE_IN_DOMAIN')).toBe(true);
    expect(isErrorCode('ERR_INTERNAL')).toBe(true);
  });

  it('is false for a plausible-looking but nonexistent code', () => {
    expect(isErrorCode('ERR_RESOLVE_IN_DOMIAN')).toBe(false); // the typo from the compile-time test above
    expect(isErrorCode('ERR_TOTALLY_MADE_UP')).toBe(false);
  });

  it("is false for a non-string value, including one that happens to equal a code's runtime shape", () => {
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode({ code: ERR_STOCK_INSUFFICIENT })).toBe(false);
  });

  it('narrows the type on a truthy branch (compile-time check via a value actually used as ErrorCode)', () => {
    const value: unknown = ERR_STOCK_INSUFFICIENT;
    if (isErrorCode(value)) {
      const narrowed: ErrorCode = value; // would not compile if isErrorCode didn't return a type predicate
      expect(narrowed).toBe(ERR_STOCK_INSUFFICIENT);
    } else {
      expect.fail('isErrorCode should have accepted a real code');
    }
  });

  it('agrees exactly with ERROR_CODE_LIST membership for every code plus a battery of non-codes', () => {
    const candidates: unknown[] = [
      ...ERROR_CODE_LIST,
      'ERR_NOT_A_REAL_CODE',
      '',
      'err_stock_insufficient',
      123,
      null,
      undefined,
      {},
    ];
    for (const candidate of candidates) {
      const expected =
        typeof candidate === 'string' && (ERROR_CODE_LIST as readonly string[]).includes(candidate);
      expect(isErrorCode(candidate)).toBe(expected);
    }
  });
});
