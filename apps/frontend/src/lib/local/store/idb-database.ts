import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { LocalDatabase, StoreOps, TxHandle } from './local-database';
import { STORE_KEY_PATH, STORE_NAMES, type StoreName } from '../types';

export const DB_NAME = 'mimi-local';
/** Bump on any STORE_NAMES/STORE_KEY_PATH change. `idb`'s upgrade callback below must stay additive-only in production (never drop a store with un-drained data). */
export const DB_VERSION = 2;

/**
 * The REAL IndexedDB-backed `LocalDatabase` (via `idb`, already a repo
 * dependency). Object stores are created verbatim from `STORE_NAMES` /
 * `STORE_KEY_PATH` (`../types.ts`) — that file is the schema; this file only
 * wires it into `idb`'s `openDB`.
 *
 * Deliberately no secondary indexes yet: at Tier-1 volumes (one device's own
 * outbox/cache) a `getAll()` + in-memory filter/sort is simpler and correct,
 * and IndexedDB indexes are additive (a future perf pass can add one without
 * a version-migration data hazard).
 */
export async function openLocalDatabase(dbName = DB_NAME): Promise<LocalDatabase> {
  const db = await openDB(dbName, DB_VERSION, {
    upgrade(database) {
      for (const name of STORE_NAMES) {
        if (!database.objectStoreNames.contains(name)) {
          database.createObjectStore(name, { keyPath: STORE_KEY_PATH[name] });
        }
      }
    },
  });

  return wrapIdb(db);
}

/**
 * `idb`'s compile-time typing (`IDBPDatabase<DBSchema>`) buys real value only
 * when the schema is declared as a `DBSchema` type with one entry per store;
 * this runtime opens the database generically (`STORE_NAMES` is a data-driven
 * list, not a `DBSchema`) so the store handle's own type here is intentionally
 * loose (`any`) — `StoreOps<T>`'s signature is what every CALLER actually
 * type-checks against (see every `db.store<SomeRecord>(name)` call site).
 */
function opsOver<T>(
  tx: IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>,
  name: string,
): StoreOps<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = tx.objectStore(name);
  return {
    get: (key) => store.get(key) as Promise<T | undefined>,
    getAll: () => store.getAll() as Promise<T[]>,
    put: async (value: T) => {
      await store.put(value);
    },
    delete: (key) => store.delete(key) as Promise<void>,
    count: () => store.count() as Promise<number>,
  };
}

function wrapIdb(db: IDBPDatabase): LocalDatabase {
  return {
    store<T>(name: string): StoreOps<T> {
      const tx = db.transaction(name as StoreName, 'readwrite');
      const ops = opsOver<T>(
        tx as unknown as IDBPTransaction<unknown, string[], 'readwrite'>,
        name,
      );
      // Fire-and-forget the tx completion; single-store convenience ops don't need to await it explicitly per-call.
      void tx.done;
      return ops;
    },

    async runTransaction<R>(
      storeNames: readonly string[],
      mode: 'readonly' | 'readwrite',
      fn: (tx: TxHandle) => Promise<R>,
    ): Promise<R> {
      const tx = db.transaction(storeNames as StoreName[], mode);
      const handle: TxHandle = {
        store<T>(name: string) {
          return opsOver<T>(
            tx as unknown as IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>,
            name,
          );
        },
      };
      const result = await fn(handle);
      await tx.done;
      return result;
    },

    close() {
      db.close();
    },
  };
}
