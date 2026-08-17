import type { LocalDatabase, StoreOps, TxHandle } from './local-database';

/**
 * In-memory `LocalDatabase` — the dependency-free fake every test in this
 * package runs against (see `local-database.ts`'s header for why). Also
 * usable as a non-persistent fallback in non-browser dev tooling, but its
 * real job is making the durable-outbox atomicity property (§2.2) and crash
 * scenarios (T-08, T-09) testable without a real IndexedDB.
 */
export function createMemoryDatabase(keyPaths: Record<string, string>): LocalDatabase {
  const maps = new Map<string, Map<IDBValidKey, unknown>>();

  function mapFor(name: string): Map<IDBValidKey, unknown> {
    let m = maps.get(name);
    if (!m) {
      m = new Map();
      maps.set(name, m);
    }
    return m;
  }

  function keyOf(name: string, value: unknown): IDBValidKey {
    const path = keyPaths[name];
    if (!path) throw new Error(`Unknown store: ${name}`);
    const key = (value as Record<string, unknown>)[path];
    if (key === undefined) throw new Error(`Value for store "${name}" is missing its key field "${path}"`);
    return key as IDBValidKey;
  }

  function opsOver<T>(name: string, backing: Map<IDBValidKey, unknown>): StoreOps<T> {
    return {
      async get(key) {
        return backing.get(key) as T | undefined;
      },
      async getAll() {
        return [...backing.values()] as T[];
      },
      async put(value) {
        backing.set(keyOf(name, value), value);
      },
      async delete(key) {
        backing.delete(key);
      },
      async count() {
        return backing.size;
      },
    };
  }

  return {
    store<T>(name: string): StoreOps<T> {
      return opsOver<T>(name, mapFor(name));
    },

    async runTransaction<R>(
      storeNames: readonly string[],
      _mode: 'readonly' | 'readwrite',
      fn: (tx: TxHandle) => Promise<R>,
    ): Promise<R> {
      // Shadow copies: reads/writes during `fn` see and mutate ONLY these
      // clones (read-your-writes within the tx), and no other transaction or
      // direct `store()` caller sees anything until `fn` resolves and we
      // splice the shadows back into the real maps — that splice IS the
      // commit. If `fn` throws, we return without ever touching `maps`:
      // nothing committed, faithfully modeling an aborted IndexedDB
      // transaction (and, for this codebase's purposes, a crashed tab).
      const shadow = new Map<string, Map<IDBValidKey, unknown>>();
      for (const name of storeNames) {
        shadow.set(name, new Map(mapFor(name)));
      }
      const tx: TxHandle = {
        store<T>(name: string): StoreOps<T> {
          if (!shadow.has(name)) {
            throw new Error(`Store "${name}" was not included in this transaction's store list`);
          }
          return opsOver<T>(name, shadow.get(name)!);
        },
      };

      const result = await fn(tx);

      for (const [name, m] of shadow) {
        maps.set(name, m);
      }
      return result;
    },

    close() {
      // no-op; nothing to release in memory
    },
  };
}
