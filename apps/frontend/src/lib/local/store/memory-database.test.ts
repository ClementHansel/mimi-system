import { describe, expect, it } from 'vitest';
import { createMemoryDatabase } from './memory-database';

interface Row {
  id: string;
  value: number;
}

describe('memory-database (LocalDatabase atomicity contract)', () => {
  const keyPaths = { a: 'id', b: 'id' };

  it('commits every write made inside runTransaction only once the callback resolves', async () => {
    const db = createMemoryDatabase(keyPaths);
    await db.runTransaction(['a', 'b'], 'readwrite', async (tx) => {
      await tx.store<Row>('a').put({ id: '1', value: 10 });
      await tx.store<Row>('b').put({ id: '1', value: 20 });
    });

    expect(await db.store<Row>('a').get('1')).toEqual({ id: '1', value: 10 });
    expect(await db.store<Row>('b').get('1')).toEqual({ id: '1', value: 20 });
  });

  it('rolls back EVERY write in a transaction whose callback throws (simulates a crashed tab, T-08)', async () => {
    const db = createMemoryDatabase(keyPaths);
    await expect(
      db.runTransaction(['a', 'b'], 'readwrite', async (tx) => {
        await tx.store<Row>('a').put({ id: '1', value: 10 });
        throw new Error('simulated crash mid-transaction');
      }),
    ).rejects.toThrow('simulated crash mid-transaction');

    expect(await db.store<Row>('a').get('1')).toBeUndefined();
  });

  it('gives read-your-writes WITHIN one transaction before it commits', async () => {
    const db = createMemoryDatabase(keyPaths);
    let seenDuringTx: Row | undefined;
    await db.runTransaction(['a'], 'readwrite', async (tx) => {
      const store = tx.store<Row>('a');
      await store.put({ id: '1', value: 1 });
      seenDuringTx = await store.get('1');
    });
    expect(seenDuringTx).toEqual({ id: '1', value: 1 });
  });

  it('isolates a transaction in progress from concurrent direct store() reads until it commits', async () => {
    const db = createMemoryDatabase(keyPaths);
    await db.store<Row>('a').put({ id: '1', value: 0 });

    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => (releaseTx = resolve));

    const txPromise = db.runTransaction(['a'], 'readwrite', async (tx) => {
      await tx.store<Row>('a').put({ id: '1', value: 999 });
      await gate; // hold the transaction open
    });

    // While the transaction is still open, outside readers must not see its uncommitted write.
    expect(await db.store<Row>('a').get('1')).toEqual({ id: '1', value: 0 });

    releaseTx();
    await txPromise;

    expect(await db.store<Row>('a').get('1')).toEqual({ id: '1', value: 999 });
  });

  it('count() and delete() behave as expected', async () => {
    const db = createMemoryDatabase(keyPaths);
    await db.store<Row>('a').put({ id: '1', value: 1 });
    await db.store<Row>('a').put({ id: '2', value: 2 });
    expect(await db.store<Row>('a').count()).toBe(2);

    await db.store<Row>('a').delete('1');
    expect(await db.store<Row>('a').count()).toBe(1);
    expect(await db.store<Row>('a').getAll()).toEqual([{ id: '2', value: 2 }]);
  });
});
