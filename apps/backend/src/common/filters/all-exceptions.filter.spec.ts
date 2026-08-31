import { describe, it, expect, vi } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ERR_FORBIDDEN } from '@mimi/shared';
import { AllExceptionsFilter } from './all-exceptions.filter';

function makeHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status };
  const request = { method: 'GET', originalUrl: '/api/items', url: '/api/items' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
      getNext: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('passes through an already-shaped { code, message, details } body verbatim when code is a real ErrorCode', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(
      new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'nope',
        details: { required: ['x'] },
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      statusCode: 403,
      code: ERR_FORBIDDEN,
      message: 'nope',
      details: { required: ['x'] },
    });
  });

  /**
   * `ApiErrorShape.code` is a closed `ErrorCode` union, but this filter still
   * receives whatever string ANY thrown exception's body happens to carry —
   * a stale hand-typed code from before the union existed, or a typo. This
   * is the test that guards against silently shipping one: an unrecognized
   * `code` must be overridden by the status-derived default, never passed
   * through verbatim.
   */
  it('overrides an unrecognized code that is not a real ErrorCode with the status-derived default', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(
      new ForbiddenException({ code: 'ERR_PERMISSION_DENIED', message: 'stale code' }),
      host,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: ERR_FORBIDDEN, message: 'stale code' }),
    );
  });

  it('derives a default code from the HTTP status when none was provided', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(new NotFoundException('Item not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: 'ERR_NOT_FOUND',
        message: 'Item not found',
      }),
    );
  });

  it('folds a class-validator array message into details and a joined message string', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(
      new BadRequestException({
        code: 'ERR_VALIDATION',
        message: ['name should not be empty', 'sku must be a string'],
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'ERR_VALIDATION',
      message: 'name should not be empty; sku must be a string',
      details: ['name should not be empty', 'sku must be a string'],
    });
  });

  it('shapes an unknown thrown Error as a 500 ERR_INTERNAL', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(new Error('unexpected'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'ERR_INTERNAL',
      message: 'unexpected',
    });
  });

  it('shapes a non-Error throw as a 500 ERR_INTERNAL with a generic message', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch('a string throw', host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'ERR_INTERNAL',
      message: 'Internal server error',
    });
  });
});

/**
 * The supplier-duplicate outage, at the filter (owner, 2026-08-31). A raw
 * `pg` error thrown by a service that had not pre-checked a constraint used
 * to fall through to `500 ERR_INTERNAL` carrying the driver's own English —
 * `duplicate key value violates unique constraint "suppliers_code_key"` —
 * which the frontend showed in a toast.
 *
 * Both halves are asserted, because either one alone would have left the bug
 * visible: the STATUS has to stop being 500 (it is a refusal the user can
 * fix), and the MESSAGE has to stop carrying the driver's text and our table
 * names.
 */
describe('AllExceptionsFilter — raw database errors', () => {
  function pgError(over: Record<string, string> & { code: string }) {
    return Object.assign(
      new Error('duplicate key value violates unique constraint "suppliers_code_key"'),
      over,
    );
  }

  it('serves a unique violation as 409 ERR_DUPLICATE with the field in details', () => {
    const { host, status, json } = makeHost();
    new AllExceptionsFilter().catch(
      pgError({ code: '23505', constraint: 'suppliers_code_key', table: 'suppliers' }),
      host,
    );
    expect(status).toHaveBeenCalledWith(409);
    const shape = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(shape.code).toBe('ERR_DUPLICATE');
    expect(shape.details).toMatchObject({ entity: 'suppliers', field: 'code' });
  });

  it("never puts the driver's text in the response", () => {
    const { host, json } = makeHost();
    new AllExceptionsFilter().catch(
      pgError({ code: '23505', constraint: 'suppliers_code_key' }),
      host,
    );
    const message = String((json.mock.calls[0]![0] as Record<string, unknown>).message);
    expect(message).not.toContain('duplicate key');
    expect(message).not.toContain('unique constraint');
    expect(message).toBe('Database constraint violation (SQLSTATE 23505)');
  });

  it('still reports a genuine database fault as 500', () => {
    // A deadlock is not something the caller did wrong; downgrading it to a
    // 4xx would tell them to fix their input and hide a real problem.
    const { host, status, json } = makeHost();
    new AllExceptionsFilter().catch(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      host,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect((json.mock.calls[0]![0] as Record<string, unknown>).code).toBe('ERR_INTERNAL');
  });
});
