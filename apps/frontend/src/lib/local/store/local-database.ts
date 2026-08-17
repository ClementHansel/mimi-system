/**
 * The storage seam. Everything in `lib/local` talks to a `LocalDatabase`, never
 * to `idb`/`indexedDB` directly. Two implementations satisfy it:
 *
 *  - `idb-database.ts` — the REAL one, backed by `idb` (`public/sw.js` and the
 *    browser runtime use this). This is what "IndexedDB schema (via idb)" in
 *    the brief refers to.
 *  - `memory-database.ts` — a dependency-free in-memory fake used by every
 *    test in this package. jsdom (this repo's vitest environment) has no
 *    IndexedDB implementation and `fake-indexeddb` is not an existing
 *    dependency (BUILD-PLAN §6 rule 2 forbids adding one unilaterally), so
 *    testing the REAL transaction atomicity that §2.2's "one IndexedDB
 *    transaction" rule depends on requires an abstraction that can express
 *    that atomicity without a browser. `runTransaction` below is written to
 *    mirror IndexedDB's actual isolation model exactly (see its doc comment),
 *    not to approximate it — so tests against the memory fake are tests of
 *    the real contract, not of a simplification.
 */

export interface StoreOps<T> {
  get(key: IDBValidKey): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  put(value: T): Promise<void>;
  delete(key: IDBValidKey): Promise<void>;
  count(): Promise<number>;
}

export interface TxHandle {
  store<T>(name: string): StoreOps<T>;
}

export interface LocalDatabase {
  /** Un-transacted convenience access (single read/write, no cross-store atomicity need). */
  store<T>(name: string): StoreOps<T>;
  /**
   * Runs `fn` against a transaction spanning `storeNames`. All the ops `fn`
   * performs become visible to every OTHER caller of this database only once
   * `fn`'s returned promise resolves (== the transaction commits) — exactly
   * IndexedDB's isolation model: writes inside a transaction are immediately
   * visible to further reads WITHIN that same transaction (read-your-writes),
   * but invisible to any other transaction until commit. If `fn` throws, the
   * transaction aborts and NONE of its writes take effect — this is what
   * makes §2.2's "commit of this transaction IS the acceptance of the
   * action" testable: a test that throws partway through `fn` is simulating
   * exactly "the tab died mid-write" (T-08), and the assertion is that
   * either everything `fn` wrote exists, or none of it does.
   */
  runTransaction<R>(storeNames: readonly string[], mode: 'readonly' | 'readwrite', fn: (tx: TxHandle) => Promise<R>): Promise<R>;
  close(): void;
}
