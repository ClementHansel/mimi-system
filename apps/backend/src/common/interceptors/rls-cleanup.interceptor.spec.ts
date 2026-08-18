import { describe, it, expect, vi, afterEach } from 'vitest';
import { of, throwError, lastValueFrom } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { RlsCleanupInterceptor } from './rls-cleanup.interceptor';
import { RequestWithDbContext } from '../guards/rls-context.guard';

function makeContext(request: RequestWithDbContext): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
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

    await expect(lastValueFrom(interceptor.intercept(makeContext(request), next))).rejects.toThrow(
      'boom',
    );
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

  // BE-TXN-ROLLBACK GUARD: a successful mutating response whose transaction actually wrote
  // something (`pg_current_xact_id_if_assigned()` non-null) but never committed is exactly the
  // stock-opname data-loss shape — this must be caught here, not discovered by re-reading a module.
  describe('BE-TXN-ROLLBACK guard (uncommitted-write detection)', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('throws (outside production) when a mutating success response never committed a real write', async () => {
      process.env.NODE_ENV = 'test';
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ xid: '12345' }] })
          .mockResolvedValue(undefined),
        release: vi.fn(),
      };
      const request: RequestWithDbContext & { method: string; originalUrl: string } = {
        dbClient: client as never,
        method: 'POST',
        originalUrl: '/api/t1/stock-opname',
      };
      const interceptor = new RlsCleanupInterceptor();
      const next: CallHandler = { handle: () => of({ id: 'opn-1' }) };

      await expect(
        lastValueFrom(interceptor.intercept(makeContext(request), next)),
      ).rejects.toThrow(/never committed/);
      // Still cleans up: the diagnostic query, then ROLLBACK, then release — never left hanging.
      expect(client.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_current_xact_id_if_assigned'),
      );
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });

    it('only warns, never throws, in production', async () => {
      process.env.NODE_ENV = 'production';
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ xid: '999' }] })
          .mockResolvedValue(undefined),
        release: vi.fn(),
      };
      const request: RequestWithDbContext & { method: string; originalUrl: string } = {
        dbClient: client as never,
        method: 'POST',
        originalUrl: '/api/t1/stock-opname',
      };
      const interceptor = new RlsCleanupInterceptor();
      const next: CallHandler = { handle: () => of({ id: 'opn-1' }) };

      const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));
      expect(result).toEqual({ id: 'opn-1' });
      expect(client.release).toHaveBeenCalled();
    });

    it('does not run the check at all for a GET (never risks a false positive on a pure read)', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
      const request: RequestWithDbContext & { method: string; originalUrl: string } = {
        dbClient: client as never,
        method: 'GET',
        originalUrl: '/api/t1/stock-opname',
      };
      const interceptor = new RlsCleanupInterceptor();
      const next: CallHandler = { handle: () => of({ rows: [] }) };

      const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));
      expect(result).toEqual({ rows: [] });
      // Only ROLLBACK was issued — the xid diagnostic query never ran for a GET.
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('does not warn or throw for a mutating success response whose client never wrote anything (xid null)', async () => {
      process.env.NODE_ENV = 'test';
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ xid: null }] })
          .mockResolvedValue(undefined),
        release: vi.fn(),
      };
      const request: RequestWithDbContext & { method: string; originalUrl: string } = {
        dbClient: client as never,
        method: 'POST',
        originalUrl: '/api/t1/dashboard/refresh',
      };
      const interceptor = new RlsCleanupInterceptor();
      const next: CallHandler = { handle: () => of({ ok: true }) };

      const result = await lastValueFrom(interceptor.intercept(makeContext(request), next));
      expect(result).toEqual({ ok: true });
      expect(client.release).toHaveBeenCalled();
    });

    it('a thrown-handler (error) path never runs the check, even for a mutating method', async () => {
      const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
      const request: RequestWithDbContext & { method: string; originalUrl: string } = {
        dbClient: client as never,
        method: 'POST',
        originalUrl: '/api/t1/stock-opname',
      };
      const interceptor = new RlsCleanupInterceptor();
      const boom = new Error('validation failed');
      const next: CallHandler = { handle: () => throwError(() => boom) };

      await expect(
        lastValueFrom(interceptor.intercept(makeContext(request), next)),
      ).rejects.toThrow('validation failed');
      // Only ROLLBACK — the diagnostic query is success-path only (an error means nothing should have committed anyway).
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });
});
