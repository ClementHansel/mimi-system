import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseModule } from './database.module';

/**
 * The coordinator-mandated boot-time refusal: if the connected Postgres
 * role has RLS-bypassing privileges, the app must refuse to start rather
 * than run with every location-scoping policy silently inert. This is the
 * regression test for config drift — a `DATABASE_URL` pointed back at a
 * superuser/BYPASSRLS role, discovered a year from now in a `.env` file
 * nobody reviewed — turning an invisible production condition into a
 * container that will not boot.
 */
describe('DatabaseModule — boot-time RLS-bypass refusal', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // `process.exit` really would tear down the test runner — stub it so
    // the assertions below can observe that it WAS called (with the fatal
    // code) without actually exiting.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('boots normally when the connected role is a plain non-superuser, non-bypassrls role', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: false }] }) };
    const mod = new DatabaseModule(pool as never);

    await mod.onModuleInit();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses to boot (exit 1) when the connected role is a superuser', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ rolsuper: true, rolbypassrls: false }] }) };
    const mod = new DatabaseModule(pool as never);

    await mod.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses to boot (exit 1) when the connected role has BYPASSRLS even without superuser', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: true }] }) };
    const mod = new DatabaseModule(pool as never);

    await mod.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('refuses to boot (exit 1) if the connected role cannot be identified at all', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const mod = new DatabaseModule(pool as never);

    await mod.onModuleInit();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('queries pg_roles for current_user specifically, not an arbitrary/hardcoded role name', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ rolsuper: false, rolbypassrls: false }] }) };
    const mod = new DatabaseModule(pool as never);

    await mod.onModuleInit();

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('current_user'));
  });
});
