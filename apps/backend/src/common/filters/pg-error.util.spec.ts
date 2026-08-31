import { describe, expect, it } from 'vitest';
import { ERR_DUPLICATE, ERR_REFERENCED, ERR_VALIDATION, ERR_FORBIDDEN } from '@mimi/shared';
import { isPgError, mapPgError, parseConstraint, pgErrorMessage } from './pg-error.util';

/**
 * What this locks in, in one line: a database constraint must never reach a
 * caller in the driver's words, and must never be reported as a 500.
 *
 * The bug (owner, 2026-08-31): `POST /api/suppliers` with a code that already
 * existed answered `500 ERR_INTERNAL` with
 * `duplicate key value violates unique constraint "suppliers_code_key"` as
 * the message, which the frontend then showed verbatim.
 */

function pgError(over: Partial<Record<string, string>> & { code: string }) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), over);
}

describe('isPgError', () => {
  it('recognizes a five-character SQLSTATE', () => {
    expect(isPgError(pgError({ code: '23505' }))).toBe(true);
    expect(isPgError(pgError({ code: '23P01' }))).toBe(true);
  });

  it('does not mistake Node/library errors for database errors', () => {
    // These carry a `code` too, and treating `ENOENT` as a SQLSTATE would map
    // a filesystem bug to a 409 the caller could not act on.
    expect(isPgError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isPgError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isPgError(new Error('plain'))).toBe(false);
    expect(isPgError(null)).toBe(false);
    expect(isPgError('23505')).toBe(false);
  });
});

describe('parseConstraint', () => {
  it('splits Postgres default unique names', () => {
    expect(parseConstraint('suppliers_code_key')).toEqual({ entity: 'suppliers', field: 'code' });
  });

  it("strips this repo's hand-written prefixes", () => {
    expect(parseConstraint('ux_users_username')).toEqual({ entity: 'users', field: 'username' });
    expect(parseConstraint('uq_items_barcode')).toEqual({ entity: 'items', field: 'barcode' });
  });

  it('handles a multi-column name without pretending to be precise', () => {
    // Two columns; the `field` is the honest remainder, and the frontend shows
    // nothing rather than a guess when it does not recognize it.
    expect(parseConstraint('replenishment_requests_location_id_needed_by_key').field).toBe(
      'requests_location_id_needed_by',
    );
  });

  it('returns nothing for no constraint', () => {
    expect(parseConstraint(undefined)).toEqual({});
  });
});

describe('mapPgError', () => {
  it('turns a unique violation into 409 ERR_DUPLICATE naming the field', () => {
    const mapped = mapPgError(pgError({ code: '23505', constraint: 'suppliers_code_key' }));
    expect(mapped).toEqual({
      statusCode: 409,
      code: ERR_DUPLICATE,
      details: { constraint: 'suppliers_code_key', entity: 'suppliers', field: 'code' },
    });
  });

  it('turns a foreign-key violation into 409 ERR_REFERENCED', () => {
    expect(mapPgError(pgError({ code: '23503' }))?.code).toBe(ERR_REFERENCED);
  });

  it('prefers the reported column over the constraint name for NOT NULL', () => {
    // Postgres names the column directly here, which beats parsing.
    const mapped = mapPgError(pgError({ code: '23502', column: 'name', table: 'suppliers' }));
    expect(mapped?.statusCode).toBe(422);
    expect(mapped?.code).toBe(ERR_VALIDATION);
    expect(mapped?.details.field).toBe('name');
  });

  it('treats bad values as 422, not as a server fault', () => {
    for (const code of ['23514', '22P02', '22003', '22001']) {
      const mapped = mapPgError(pgError({ code }));
      expect(mapped?.statusCode).toBe(422);
      expect(mapped?.code).toBe(ERR_VALIDATION);
    }
  });

  it('maps an RLS/privilege refusal to a bare 403 with NO schema detail', () => {
    // The one case where `details` is deliberately emptied: a caller who
    // reached a row outside their scope must not learn the policy or table.
    const mapped = mapPgError(
      pgError({ code: '42501', table: 'replenishment_requests', constraint: 'rr_select' }),
    );
    expect(mapped?.statusCode).toBe(403);
    expect(mapped?.code).toBe(ERR_FORBIDDEN);
    expect(mapped?.details).toEqual({});
  });

  it('leaves our own faults as faults', () => {
    // Deadlock, syntax error, connection failure — genuinely 500s. Dressing
    // them as 4xx would tell the user to fix something they cannot.
    for (const code of ['40P01', '42601', '08006', '57014']) {
      expect(mapPgError(pgError({ code }))).toBeNull();
    }
  });
});

describe('pgErrorMessage', () => {
  it('carries the SQLSTATE and nothing about the schema', () => {
    const message = pgErrorMessage(
      pgError({ code: '23505', constraint: 'suppliers_code_key', table: 'suppliers' }),
    );
    expect(message).toBe('Database constraint violation (SQLSTATE 23505)');
    expect(message).not.toContain('suppliers');
    expect(message).not.toContain('duplicate key');
  });
});
