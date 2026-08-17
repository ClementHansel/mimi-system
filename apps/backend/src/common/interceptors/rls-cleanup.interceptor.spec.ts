import { describe, it, expect, vi } from 'vitest';
import { of, throwError, lastValueFrom } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { RlsCleanupInterceptor } from './rls-cleanup.interceptor';
import { RequestWithDbContext } from '../guards/rls-context.guard';

function makeContext(request: RequestWithDbContext): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RlsCleanupInterceptor', () => {
  it('rolls back and releases the client after a successful handler, without touching the response', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    const request: RequestWithDbContext = { dbClient: client as never };
    const interceptor = new RlsCleanupInterceptor();
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));

    expect(result).toEqual({ ok: true });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(request.dbClient).toBeUndefined();
  });

  it('still releases the client when the handler throws, and rethrows the original error', async () => {
    const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    const request: RequestWithDbContext = { dbClient: client as never };
    const interceptor = new RlsCleanupInterceptor();
    const boom = new Error('boom');
    const next: CallHandler = { handle: () => throwError(() => boom) };

    await expect(lastValueFrom(interceptor.intercept(makeContext(request), next))).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('tolerates ROLLBACK failing (transaction already closed by a module service COMMIT) and still releases', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('no transaction in progress')),
      release: vi.fn(),
    };
    const request: RequestWithDbContext = { dbClient: client as never };
    const interceptor = new RlsCleanupInterceptor();
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));

    expect(result).toEqual({ ok: true });
    expect(client.release).toHaveBeenCalled();
  });

  it('is a no-op when the request never got a dbClient (e.g. a @Public() route)', async () => {
    const request: RequestWithDbContext = {};
    const interceptor = new RlsCleanupInterceptor();
    const next: CallHandler = { handle: () => of('fine') };

    const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));

    expect(result).toBe('fine');
  });
});
