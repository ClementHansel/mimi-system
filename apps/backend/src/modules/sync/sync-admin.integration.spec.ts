/**
 * Live-DB integration suite for `sync-admin.controller.ts`'s two BE-TXN-ROLLBACK fixes:
 * `dismissConflict` (`POST /api/sync/conflicts/:id/dismiss`) and `resolveReconciliation`
 * (`POST /api/sync/reconciliations/:id/resolve`). Neither of these routes has a service
 * layer to wrap in `withWrite` — both were raw `client.query(...)` calls in the controller
 * with no `COMMIT` anywhere, so `RlsCleanupInterceptor`'s unconditional post-request
 * `ROLLBACK` silently discarded them. Fixed by adding `await client.query('COMMIT')` right
 * after each mutation succeeds, matching `pos.controller.ts`'s controller-commit
 * convention exactly (see that file's header).
 *
 * Same two-pool + `withRollback` harness as `auth`/`settings`/`users`
 * (`modules/auth/test-support/live-db.ts`) — reused rather than duplicated (a fourth copy
 * of the identical helper would be pure drift risk). Every mutating call opens its OWN
 * connection (`asRequest`), and the verifying read is a GENUINELY separate connection —
 * the only shape that can catch a controller action that silently never commits.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { asRequest, closeTestPool, fetchOneUserId, getOwnerPool, withRollback } from '../auth/test-support/live-db';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ReconciliationService } from '../../kernel/sync/reconciliation.service';
import { SyncAdminController } from './sync-admin.controller';

function buildController(client: PoolClient): SyncAdminController {
  // `ReconciliationService` is never exercised by `dismissConflict`/`resolveReconciliation`
  // (only `triggerReconcile`, out of scope here — already correct per this ticket's brief) —
  // wired with `undefined as never` rather than a real `Pool`-backed instance, matching how
  // this suite only touches the two fixed routes.
  return new SyncAdminController(new SyncConflictsRepository(), undefined as unknown as ReconciliationService, undefined as never);
}

function fakeReq(client: PoolClient, userId: string) {
  return { dbClient: client, user: { sub: userId }, locationScope: null } as any;
}

let ownerUserId: string;
let locationId: string;
let itemId: string;

beforeAll(async () => {
  const owner = await fetchOneUserId('owner');
  ownerUserId = owner.id;
  const locRes = await getOwnerPool().query<{ id: string }>(`SELECT id FROM locations LIMIT 1`);
  const itemRes = await getOwnerPool().query<{ id: string }>(`SELECT id FROM items LIMIT 1`);
  if (!locRes.rows[0] || !itemRes.rows[0]) throw new Error('Test fixture requires at least one seeded location and item');
  locationId = locRes.rows[0].id;
  itemId = itemRes.rows[0].id;
});

afterAll(async () => {
  await closeTestPool();
});

async function insertOpenConflict(kind: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO sync_conflicts (kind, queue, entity, entity_id, location_id, detail, status)
     VALUES ($1, 'exception', 'devices', $2, $3, '{}'::jsonb, 'open') RETURNING id`,
    [kind, randomUUID(), locationId],
  );
  return res.rows[0]!.id;
}

async function insertOpenReconciliation(): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO stock_reconciliations (location_id, item_id, tier, expected_qty, stored_qty, divergence, status)
     VALUES ($1, $2, 'cloud', '10.000', '8.000', '-2.000', 'open') RETURNING id`,
    [locationId, itemId],
  );
  return res.rows[0]!.id;
}

describe('SyncAdminController.dismissConflict — write-then-read-back across SEPARATE connections', () => {
  it('persists past its own request — a later read (new connection) sees it dismissed, not open', async () => {
    const conflictId = await insertOpenConflict('poison');
    try {
      const dismissed = await asRequest((client) => buildController(client).dismissConflict(fakeReq(client, ownerUserId), conflictId, { reason: 'test dismiss' }));
      expect(dismissed.status).toBe('dismissed');
      expect(dismissed.resolution).toBe('test dismiss');

      // A GENUINELY separate connection/transaction — never sees the mutating call's
      // uncommitted state, only what it actually COMMITted.
      const reread = await withRollback((client) => client.query<{ status: string; resolution: string | null }>(`SELECT status, resolution FROM sync_conflicts WHERE id = $1`, [conflictId]));
      expect(reread.rows[0]?.status).toBe('dismissed');
      expect(reread.rows[0]?.resolution).toBe('test dismiss');
    } finally {
      await getOwnerPool().query(`DELETE FROM sync_conflicts WHERE id = $1`, [conflictId]);
    }
  });

  it('rejects a domain-resolved kind (e.g. double_count) with ERR_RESOLVE_IN_DOMAIN and never commits anything', async () => {
    const conflictId = await insertOpenConflict('double_count');
    try {
      await asRequest((client) =>
        expect(buildController(client).dismissConflict(fakeReq(client, ownerUserId), conflictId, { reason: 'nope' })).rejects.toMatchObject({
          response: { code: 'ERR_RESOLVE_IN_DOMAIN' },
        }),
      );

      const reread = await withRollback((client) => client.query<{ status: string }>(`SELECT status FROM sync_conflicts WHERE id = $1`, [conflictId]));
      expect(reread.rows[0]?.status).toBe('open');
    } finally {
      await getOwnerPool().query(`DELETE FROM sync_conflicts WHERE id = $1`, [conflictId]);
    }
  });
});

describe('SyncAdminController.resolveReconciliation — write-then-read-back across SEPARATE connections', () => {
  it('persists past its own request — a later read (new connection) sees it resolved, not open', async () => {
    const reconciliationId = await insertOpenReconciliation();
    try {
      const resolved = await asRequest((client) =>
        buildController(client).resolveReconciliation(fakeReq(client, ownerUserId), reconciliationId, { resolution: 'adjusted via test' }),
      );
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution).toBe('adjusted via test');

      const reread = await withRollback((client) =>
        client.query<{ status: string; resolution: string | null }>(`SELECT status, resolution FROM stock_reconciliations WHERE id = $1`, [reconciliationId]),
      );
      expect(reread.rows[0]?.status).toBe('resolved');
      expect(reread.rows[0]?.resolution).toBe('adjusted via test');
    } finally {
      await getOwnerPool().query(`DELETE FROM stock_reconciliations WHERE id = $1`, [reconciliationId]);
    }
  });

  it('404s when the reconciliation is already resolved (not open) and never re-commits', async () => {
    const reconciliationId = await insertOpenReconciliation();
    try {
      await asRequest((client) => buildController(client).resolveReconciliation(fakeReq(client, ownerUserId), reconciliationId, { resolution: 'first pass' }));

      await asRequest((client) =>
        expect(buildController(client).resolveReconciliation(fakeReq(client, ownerUserId), reconciliationId, { resolution: 'second pass' })).rejects.toMatchObject({
          response: { code: 'ERR_NOT_FOUND' },
        }),
      );

      const reread = await withRollback((client) =>
        client.query<{ resolution: string | null }>(`SELECT resolution FROM stock_reconciliations WHERE id = $1`, [reconciliationId]),
      );
      expect(reread.rows[0]?.resolution).toBe('first pass');
    } finally {
      await getOwnerPool().query(`DELETE FROM stock_reconciliations WHERE id = $1`, [reconciliationId]);
    }
  });
});
