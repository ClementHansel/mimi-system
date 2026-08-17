/**
 * A generic trailing-edge debouncer keyed by an arbitrary string. Used by
 * `LowStockDetectorService` to coalesce a burst of `stock.moved` events for
 * the SAME `(locationId, itemId)` into a single deferred check — "an outlet
 * crossing a threshold repeatedly during a busy shift must not generate a
 * notification per movement" (the ticket's debounce requirement).
 *
 * Pure timer bookkeeping, zero I/O — kept standalone specifically so it is
 * unit-testable with fake timers, independent of the database/notification
 * plumbing `LowStockDetectorService` wraps around it.
 */
export class KeyedDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly delayMs: number) {}

  /** (Re)schedules `fn` to run `delayMs` after the LAST call for this `key` — any pending call for the same key is cancelled, not run. */
  trigger(key: string, fn: () => void | Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void fn();
    }, this.delayMs);
    // Never keep the Node process alive just for a pending debounce fire (harmless in tests and in a graceful shutdown).
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.timers.set(key, timer);
  }

  /** Cancels every pending timer without running them — used on module shutdown. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Number of keys with a pending (not yet fired) check — test/diagnostic use. */
  get pendingCount(): number {
    return this.timers.size;
  }
}
