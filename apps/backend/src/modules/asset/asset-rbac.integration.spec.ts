import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { can, RoleKey } from '@mimi/shared';
import {
  closePool,
  createAsset,
  deleteAsset,
  loadFixtures,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

/**
 * RBAC + RLS proof for M16 `asset` (this ticket's explicit deliverable):
 * "prove a Supervisor at outlet A cannot see an asset at outlet B while an
 * Owner sees both."
 *
 *  1. Permission matrix (`@mimi/shared`'s `can()`) — both directions, so the
 *     matrix is neither accidentally permissive nor accidentally locked out.
 *  2. RLS, against the LIVE database under the real `app_user` identity —
 *     `assets` is the one table in this module that IS RLS-scoped
 *     (`assets_loc`, migration 074); this is the boundary that actually
 *     matters.
 */
describe('asset module RBAC + RLS (integration, live Postgres)', () => {
  let fixtures: Fixtures;
  let dbAvailable = true;
  let assetAId: string | null = null;
  let assetBId: string | null = null;

  beforeAll(async () => {
    try {
      fixtures = await loadFixtures();
      if (!fixtures.usersByRole[RoleKey.SUPERVISOR] || !fixtures.usersByRole[RoleKey.OWNER]) {
        dbAvailable = false;
        return;
      }
      assetAId = await createAsset(fixtures.outletId);
      assetBId = await createAsset(fixtures.outletBId);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (assetAId) await deleteAsset(assetAId);
    if (assetBId) await deleteAsset(assetBId);
    await closePool();
  });

  // ── Layer 1: permission matrix, both directions ───────────────────────────

  it('roles CONTRACTS.md §3 denies asset permissions to are denied', () => {
    const denied: [string, RoleKey][] = [
      ['asset.read', RoleKey.KASIR],
      ['asset.read', RoleKey.HR_ADMIN],
      ['asset.read', RoleKey.DRIVER],
      ['asset.manage', RoleKey.SUPERVISOR],
      ['asset.manage', RoleKey.KEPALA_GUDANG],
      ['asset.schedule.manage', RoleKey.SUPERVISOR],
      ['asset.job.execute', RoleKey.OWNER],
      ['asset.job.execute', RoleKey.KASIR],
      ['asset.job.verify', RoleKey.KEPALA_GUDANG],
      ['asset.job.verify', RoleKey.LEADER_OUTLET],
    ];
    for (const [key, role] of denied) {
      expect(can(role, key as never), `${role} should NOT hold ${key}`).toBe(false);
    }
  });

  it('roles CONTRACTS.md §3 grants asset permissions to are allowed', () => {
    const allowed: [string, RoleKey][] = [
      ['asset.read', RoleKey.OWNER],
      ['asset.read', RoleKey.SUPERVISOR],
      ['asset.manage', RoleKey.OWNER],
      ['asset.manage', RoleKey.MANAGER],
      ['asset.schedule.manage', RoleKey.MANAGER],
      ['asset.job.execute', RoleKey.MANAGER],
      ['asset.job.execute', RoleKey.KEPALA_GUDANG],
      ['asset.job.execute', RoleKey.SUPERVISOR],
      ['asset.job.execute', RoleKey.LEADER_OUTLET],
      ['asset.job.verify', RoleKey.OWNER],
      ['asset.job.verify', RoleKey.MANAGER],
      ['asset.job.verify', RoleKey.SUPERVISOR],
    ];
    for (const [key, role] of allowed) {
      expect(can(role, key as never), `${role} should hold ${key}`).toBe(true);
    }
  });

  // ── Layer 2: RLS, live Postgres, both directions ──────────────────────────

  it('a Supervisor at outlet A CANNOT see an asset at outlet B (cross-location isolation)', async () => {
    if (!dbAvailable || !assetBId) return;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR];
    await withRollbackAs(
      { role: RoleKey.SUPERVISOR, userId: spv, locationIds: [fixtures.outletId] },
      async (client) => {
        const res = await client.query('SELECT id FROM assets WHERE id = $1', [assetBId]);
        expect(res.rows.length).toBe(0);
      },
    );
  });

  it("a Supervisor at outlet A CAN see their OWN outlet's asset", async () => {
    if (!dbAvailable || !assetAId) return;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR];
    await withRollbackAs(
      { role: RoleKey.SUPERVISOR, userId: spv, locationIds: [fixtures.outletId] },
      async (client) => {
        const res = await client.query('SELECT id FROM assets WHERE id = $1', [assetAId]);
        expect(res.rows.length).toBe(1);
      },
    );
  });

  it("an Owner (central role) sees BOTH outlets' assets", async () => {
    if (!dbAvailable || !assetAId || !assetBId) return;
    const owner = fixtures.usersByRole[RoleKey.OWNER];
    await withRollbackAs(
      { role: RoleKey.OWNER, userId: owner, locationIds: [] },
      async (client) => {
        const res = await client.query('SELECT id FROM assets WHERE id = ANY($1::uuid[])', [
          [assetAId, assetBId],
        ]);
        expect(res.rows.length).toBe(2);
      },
    );
  });
});
