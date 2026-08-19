import { describe, expect, it } from 'vitest';
import { SyncEntity } from '@mimi/shared';
import { commitFact, getOutboxDepth } from './idempotent-commit';
import { createTestDatabase, setupIdentity, ACTOR } from './test-support/fixtures';
import type { LocalDatabase, StoreOps, TxHandle } from './store/local-database';

/**
 * W6-02 adversarial case: "storage full". `idempotent-commit.test.ts`'s
 * T-08 already proves atomicity when the CALLER's own `projectWithin`
 * callback throws a plain `Error` — but that is a controlled, in-app throw.
 * A device genuinely out of disk space fails differently: `IndexedDB`
 * itself throws `DOMException('...', 'QuotaExceededError')` out of a
 * `store.put()` call, and it can happen on ANY write inside the
 * transaction — the outbox row, the durable `client_seq` counter, or the
 * caller's projection — not only the one T-08 already exercises. This file
 * proves §2.2's "commit of this transaction IS the acceptance of the
 * action" holds for a genuine storage-layer fault at each of those write
 * points, and specifically that a failed commit never leaves the durable
 * `client_seq` counter advanced (a "phantom gap" that would poison the
 * gapless-sequence invariant every later push and `seq_conflict` check
 * depends on).
 *
 * `createMemoryDatabase`'s `runTransaction` already models real IndexedDB's
 * abort semantics faithfully (shadow-copy, spliced back only on success —
 * see `store/memory-database.ts`'s header) — this file only needs to make
 * one `put()` call throw to get a faithful "transaction aborted mid-write"
 * scenario, no product code changes required.
 */

/**
 * Wraps a `LocalDatabase` so the Nth `put()` call against `targetStore`
 * (across the WHOLE test, not per-transaction) throws a genuine
 * `QuotaExceededError`-shaped `DOMException` instead of writing — modeling
 * "the device's storage is full" at the exact point IndexedDB itself would
 * report it, rather than a caller-thrown application error.
 */
function withQuotaFailureOn(
  db: LocalDatabase,
  targetStore: string,
  failOnCallNumber = 1,
): LocalDatabase {
  let calls = 0;
  return {
    ...db,
    async runTransaction<R>(
      storeNames: readonly string[],
      mode: 'readonly' | 'readwrite',
      fn: (tx: TxHandle) => Promise<R>,
    ): Promise<R> {
      return db.runTransaction(storeNames, mode, async (tx) => {
        const wrappedTx: TxHandle = {
          store<T>(name: string): StoreOps<T> {
            const ops = tx.store<T>(name);
            if (name !== targetStore) return ops;
            return {
              ...ops,
              async put(value: T) {
                calls += 1;
                if (calls === failOnCallNumber) {
                  throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
                }
                return ops.put(value);
              },
            };
          },
        };
        return fn(wrappedTx);
      });
    },
  };
}

describe('commitFact under a genuine storage-full fault (QuotaExceededError, not a caller-thrown Error)', () => {
  it('a quota failure writing the OUTBOX row itself leaves nothing committed, and the error is a recognizable QuotaExceededError (so the UI can show the right message)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const faulty = withQuotaFailureOn(db, 'outbox', 1);

    let caught: unknown;
    try {
      await commitFact(faulty, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-quota-1',
        data: { total: '10000.00' },
        meta: ACTOR,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('QuotaExceededError');
    expect(await getOutboxDepth(db)).toBe(0); // nothing committed
  });

  it('the durable client_seq counter is NOT advanced by a failed commit — the next successful commit still mints seq 1, not seq 2', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const faulty = withQuotaFailureOn(db, 'outbox', 1);

    await expect(
      commitFact(faulty, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-quota-failed',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow();

    // Retried (or a fresh, unrelated) commit against the REAL (non-faulty) db must start at 1 —
    // a phantom seq bump here would poison every future push's gapless-ordering guarantee.
    const result = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-after-quota-failure',
      data: {},
      meta: ACTOR,
    });
    expect(result.envelope.clientSeq).toBe(1n);
  });

  it('a quota failure writing the client_seq counter (instead of the outbox row) still leaves the outbox untouched — both-or-neither regardless of which store fails', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const faulty = withQuotaFailureOn(db, 'client_seq_counter', 1);

    await expect(
      commitFact(faulty, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-counter-quota',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow(/QuotaExceededError|quota/i);

    expect(await getOutboxDepth(db)).toBe(0);
  });

  it('a quota failure in the caller-supplied projection (stock movement write) still leaves the outbox row unwritten — the atomicity applies to Wave 4 projections too, not just this module’s own stores', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const faulty = withQuotaFailureOn(db, 'movements', 1);

    let projectionAttempted = false;
    await expect(
      commitFact(
        faulty,
        {
          entity: SyncEntity.SALES,
          op: 'completed',
          entityId: 'sale-projection-quota',
          data: {},
          meta: ACTOR,
          projectWithin: async (tx) => {
            projectionAttempted = true;
            await tx.store('movements').put({ id: 'mv-1', qty: '1' } as never);
          },
        },
        ['movements'],
      ),
    ).rejects.toThrow(/QuotaExceededError|quota/i);

    expect(projectionAttempted).toBe(true);
    expect(await getOutboxDepth(db)).toBe(0); // the outbox row the projection was attached to never exists either
  });

  it('a quota failure on the SECOND of two sequential commits does not corrupt the FIRST, already-committed one', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-1-ok',
      data: {},
      meta: ACTOR,
    });
    expect(await getOutboxDepth(db)).toBe(1);

    const faulty = withQuotaFailureOn(db, 'outbox', 1);
    await expect(
      commitFact(faulty, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-2-quota-fails',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow();

    // sale-1 survives untouched; sale-2 never happened — never a partial state in between.
    expect(await getOutboxDepth(db)).toBe(1);
    const remaining = await db.store('outbox').getAll();
    expect((remaining as Array<{ envelope: { entityId: string } }>)[0]?.envelope.entityId).toBe(
      'sale-1-ok',
    );
  });
});
