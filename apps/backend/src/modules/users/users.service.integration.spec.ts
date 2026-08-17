/**
 * Live-DB integration suite for M02 `users` (CONTRACTS.md §4.2). Runs
 * `UsersService` against the REAL `mimi_app` pool, under real `SET LOCAL
 * ROLE app_user` + session-var RLS context — same two-pool harness as
 * `modules/auth/test-support/live-db.ts` (copied from
 * `kernel/approvals/test-support/live-db.ts` per this agent's brief).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import {
  asRequest,
  closeTestPool,
  deleteTestUser,
  fetchOneLocationId,
  fetchOneUserId,
  getAppPool,
  withRollback,
} from '../auth/test-support/live-db';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

function buildService(): UsersService {
  const pool = getAppPool();
  const events = new SyncEventsRepository(pool);
  const syncEmit = new SyncEmitService(events, new ConflictDetectorService(events, new SyncConflictsRepository()));
  return new UsersService(new UsersRepository(), syncEmit);
}

afterAll(async () => {
  await closeTestPool();
});

describe('UsersService RBAC/RLS — BOTH directions on the real DB (not just can())', () => {
  it('a KASIR session sees only its OWN row via users_select RLS (central-role-OR-self)', async () => {
    const kasir = await fetchOneUserId('kasir');
    const result = await withRollback(
      async (client) => buildService().list({}, client),
      { userId: kasir.id, roleKey: 'kasir' },
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.id).toBe(kasir.id);
  });

  it('an OWNER session (central role) sees EVERY user — the same query, the opposite outcome', async () => {
    const result = await withRollback(async (client) => buildService().list({}, client), { roleKey: 'owner' });
    expect(result.total).toBeGreaterThan(10); // 97 seeded users at last count — definitely more than one kasir's self-view
  });

  it('a SUPERVISOR (scoped, non-central, not the target) also cannot see a DIFFERENT user by id — getOne throws 404, not a silently-empty row', async () => {
    const supervisor = await fetchOneUserId('supervisor');
    const otherKasir = await fetchOneUserId('kasir');
    await expect(
      withRollback(async (client) => buildService().getOne(otherKasir.id, client), { userId: supervisor.id, roleKey: 'supervisor' }),
    ).rejects.toMatchObject({ response: { code: 'ERR_NOT_FOUND' } });
  });
});

// BE-TXN-ROLLBACK: `create`/`assignRole`/`assignLocations`/`deactivate` now wrap their
// writes in `withWrite` (real `BEGIN...COMMIT`) — see `users/db-tx.ts`. That `COMMIT` ends
// whatever transaction `withRollback` opened and reverts `SET LOCAL ROLE`/session GUCs
// with it, so a later call (even a plain read) on the SAME connection now fails
// `permission denied for table users`. Every test below therefore opens a SEPARATE
// `asRequest`/`withRollback` connection per mutating call — mirroring `stock-opname`'s
// regression-suite shape — and, because `create` now genuinely commits a real `users` row,
// cleans it up via `deleteTestUser` (owner pool) in a `finally` block.
describe('UsersService.create / assignRole / assignLocations / deactivate — live DB', () => {
  it('creates a user with locations, then role-rank-blocks a supervisor from promoting them to manager, then an owner CAN', async () => {
    const locationId = await fetchOneLocationId('outlet');
    let newUserId: string | undefined;
    try {
      const created = await asRequest(
        (client) =>
          buildService().create(
            {
              username: `w301-users-create-${Date.now()}`,
              name: 'Test Created User',
              password: 'SomeLongEnoughPassword1!',
              roleKey: 'kasir',
              locationIds: [locationId],
            },
            { roleKey: 'owner', sub: randomUUID() },
            client,
          ),
        { roleKey: 'owner' },
      );
      newUserId = created.id;
      expect(created.roleKey).toBe('kasir');
      expect(created.locations).toHaveLength(1);

      // A supervisor (rank 40) may not promote anyone to manager (rank 90). Rejected before
      // any write (`assertCanGrantRole` runs before `withWrite`), so this never commits and
      // never disturbs the session — but it's still its own connection for consistency.
      await asRequest(
        (client) => expect(buildService().assignRole(created.id, { roleKey: 'manager' }, { roleKey: 'supervisor', sub: randomUUID() }, client)).rejects.toMatchObject({
          response: { code: 'ERR_FORBIDDEN' },
        }),
        { roleKey: 'owner' },
      );

      // An owner (rank 100) may.
      const promoted = await asRequest(
        (client) => buildService().assignRole(created.id, { roleKey: 'manager' }, { roleKey: 'owner', sub: randomUUID() }, client),
        { roleKey: 'owner' },
      );
      expect(promoted.roleKey).toBe('manager');

      // Deactivate revokes sessions/credentials and flips is_active.
      const deactivated = await asRequest((client) => buildService().deactivate(created.id, { sub: randomUUID() }, client), { roleKey: 'owner' });
      expect(deactivated.deactivated).toBe(true);

      // A GENUINELY separate connection — never sees `deactivate`'s connection's uncommitted
      // state, only what it actually COMMITted.
      const after = await asRequest((client) => buildService().getOne(created.id, client), { roleKey: 'owner' });
      expect(after.isActive).toBe(false);
    } finally {
      if (newUserId) await deleteTestUser(newUserId).catch(() => {});
    }
  });

  it('rejects assigning a role that does not exist', async () => {
    const locationId = await fetchOneLocationId('outlet');
    let newUserId: string | undefined;
    try {
      const created = await asRequest(
        (client) =>
          buildService().create(
            { username: `w301-badrole-${Date.now()}`, name: 'Bad Role Target', password: 'AnotherLongPassword1!', roleKey: 'kasir', locationIds: [locationId] },
            { roleKey: 'owner', sub: randomUUID() },
            client,
          ),
        { roleKey: 'owner' },
      );
      newUserId = created.id;

      await asRequest(
        (client) =>
          expect(
            buildService().assignRole(created.id, { roleKey: 'not_a_real_role' as never }, { roleKey: 'owner', sub: randomUUID() }, client),
          ).rejects.toBeTruthy(),
        { roleKey: 'owner' },
      );
    } finally {
      if (newUserId) await deleteTestUser(newUserId).catch(() => {});
    }
  });

  it('assignLocations computes an add/remove diff and both directions round-trip', async () => {
    const locationA = await fetchOneLocationId('outlet');
    let newUserId: string | undefined;
    try {
      const created = await asRequest(
        (client) =>
          buildService().create(
            { username: `w301-locs-${Date.now()}`, name: 'Location Diff Target', password: 'YetAnotherLongPassword1!', roleKey: 'kasir', locationIds: [locationA] },
            { roleKey: 'owner', sub: randomUUID() },
            client,
          ),
        { roleKey: 'owner' },
      );
      newUserId = created.id;
      expect(created.locations.map((l) => l.id)).toEqual([locationA]);

      const cleared = await asRequest((client) => buildService().assignLocations(created.id, { locationIds: [] }, { sub: randomUUID() }, client), { roleKey: 'owner' });
      expect(cleared.locations).toHaveLength(0);

      const reassigned = await asRequest(
        (client) => buildService().assignLocations(created.id, { locationIds: [locationA] }, { sub: randomUUID() }, client),
        { roleKey: 'owner' },
      );
      expect(reassigned.locations.map((l) => l.id)).toEqual([locationA]);
    } finally {
      if (newUserId) await deleteTestUser(newUserId).catch(() => {});
    }
  });
});

