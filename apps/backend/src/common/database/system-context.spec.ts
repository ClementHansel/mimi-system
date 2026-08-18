import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  assertSystemContext,
  withSystemContext,
  SYSTEM_SENTINEL_USER_ID,
  SYSTEM_CENTRAL_ROLE,
} from './system-context';

function makeClient() {
  const calls: Array<[string, unknown[] | undefined]> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

describe('assertSystemContext', () => {
  it('switches role, then sets app.role, app.user_id, app.location_ids — in that order', async () => {
    const client = makeClient();

    await assertSystemContext(client as never, { role: SYSTEM_CENTRAL_ROLE });

    expect(client.calls[0]).toEqual(['SET LOCAL ROLE app_user', undefined]);
    expect(client.calls[1]).toEqual([expect.stringContaining('app.role'), ['owner']]);
    expect(client.calls[2]).toEqual([
      expect.stringContaining('app.user_id'),
      [SYSTEM_SENTINEL_USER_ID],
    ]);
    expect(client.calls[3]).toEqual([expect.stringContaining('app.location_ids'), ['']]);
  });

  it('defaults app.user_id to the inert all-zero sentinel when no userId is given', async () => {
    const client = makeClient();
    await assertSystemContext(client as never, { role: SYSTEM_CENTRAL_ROLE });
    const userIdCall = client.calls.find(([sql]) => sql.includes('app.user_id'));
    expect(userIdCall?.[1]).toEqual([SYSTEM_SENTINEL_USER_ID]);
  });

  it('asserts the ACTUAL recipient id when impersonating a specific self-only user', async () => {
    const client = makeClient();
    await assertSystemContext(client as never, { role: '', userId: 'real-recipient-id' });
    const userIdCall = client.calls.find(([sql]) => sql.includes('app.user_id'));
    expect(userIdCall?.[1]).toEqual(['real-recipient-id']);
    const roleCall = client.calls.find(([sql]) => sql.includes(`set_config('app.role'`));
    expect(roleCall?.[1]).toEqual(['']);
  });

  it('joins locationIds with a comma when provided', async () => {
    const client = makeClient();
    await assertSystemContext(client as never, {
      role: SYSTEM_CENTRAL_ROLE,
      locationIds: ['loc-1', 'loc-2'],
    });
    const locCall = client.calls.find(([sql]) => sql.includes('app.location_ids'));
    expect(locCall?.[1]).toEqual(['loc-1,loc-2']);
  });

  it('binds every value as a query parameter, never string-interpolated', async () => {
    const client = makeClient();
    await assertSystemContext(client as never, { role: "owner'; DROP TABLE users; --" });
    const roleCall = client.calls.find(([sql]) => sql.includes(`set_config('app.role'`));
    // The malicious string traveled as a bind parameter, never concatenated into the SQL text.
    expect(roleCall?.[0]).not.toContain('DROP TABLE');
    expect(roleCall?.[1]).toEqual(["owner'; DROP TABLE users; --"]);
  });
});

describe('withSystemContext', () => {
  let client: ReturnType<typeof makeClient>;
  let pool: { connect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = makeClient();
    pool = { connect: vi.fn(async () => client) };
  });

  it('BEGINs, asserts context, runs fn, COMMITs, and releases on success', async () => {
    const fn = vi.fn(async () => 'result');

    const result = await withSystemContext(pool as never, { role: SYSTEM_CENTRAL_ROLE }, fn);

    expect(result).toBe('result');
    expect(client.calls[0]).toEqual(['BEGIN', undefined]);
    expect(client.calls.some(([sql]) => sql === 'SET LOCAL ROLE app_user')).toBe(true);
    expect(client.calls[client.calls.length - 1]).toEqual(['COMMIT', undefined]);
    expect(fn).toHaveBeenCalledWith(client);
    expect(client.release).toHaveBeenCalled();
  });

  it('ROLLBACKs and releases (never leaves the connection dangling) when fn throws', async () => {
    const boom = new Error('boom');
    const fn = vi.fn(async () => {
      throw boom;
    });

    await expect(
      withSystemContext(pool as never, { role: SYSTEM_CENTRAL_ROLE }, fn),
    ).rejects.toThrow('boom');

    expect(client.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(client.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('still releases even if ROLLBACK itself fails', async () => {
    client.query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // SET LOCAL ROLE
      .mockResolvedValueOnce(undefined) // app.role
      .mockResolvedValueOnce(undefined) // app.user_id
      .mockResolvedValueOnce(undefined) // app.location_ids
      .mockRejectedValueOnce(new Error('fn failed'))
      .mockRejectedValueOnce(new Error('rollback failed'));

    const fn = vi.fn(async () => {
      throw new Error('fn failed');
    });

    await expect(
      withSystemContext(pool as never, { role: SYSTEM_CENTRAL_ROLE }, fn),
    ).rejects.toThrow('fn failed');
    expect(client.release).toHaveBeenCalled();
  });
});
