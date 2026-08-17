import { describe, it, expect, vi } from 'vitest';
import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ERR_FORBIDDEN } from '@mimi/shared';
import { AllExceptionsFilter } from './all-exceptions.filter';

function makeHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status };
  const request = { method: 'GET', originalUrl: '/api/items', url: '/api/items' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request, getNext: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('passes through an already-shaped { code, message, details } body verbatim when code is a real ErrorCode', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(
      new ForbiddenException({ code: ERR_FORBIDDEN, message: 'nope', details: { required: ['x'] } }),
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
    filter.catch(new ForbiddenException({ code: 'ERR_PERMISSION_DENIED', message: 'stale code' }), host);
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
      expect.objectContaining({ statusCode: 404, code: 'ERR_NOT_FOUND', message: 'Item not found' }),
    );
  });

  it('folds a class-validator array message into details and a joined message string', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch(
      new BadRequestException({ code: 'ERR_VALIDATION', message: ['name should not be empty', 'sku must be a string'] }),
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
    expect(json).toHaveBeenCalledWith({ statusCode: 500, code: 'ERR_INTERNAL', message: 'unexpected' });
  });

  it('shapes a non-Error throw as a 500 ERR_INTERNAL with a generic message', () => {
    const { host, status, json } = makeHost();
    const filter = new AllExceptionsFilter();
    filter.catch('a string throw', host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, code: 'ERR_INTERNAL', message: 'Internal server error' });
  });
});
