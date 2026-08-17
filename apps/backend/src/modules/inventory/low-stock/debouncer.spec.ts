import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyedDebouncer } from './debouncer';

describe('KeyedDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a burst of triggers for the same key within the delay window fires the callback exactly once', () => {
    const debouncer = new KeyedDebouncer(1000);
    const fn = vi.fn();

    // Simulates a busy shift: many movements for one item, each retriggering the same key.
    for (let i = 0; i < 20; i++) {
      debouncer.trigger('loc-1::item-1', fn);
      vi.advanceTimersByTime(100); // well inside the 1000ms window — never lets the timer fire
    }

    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('two different keys debounce independently', () => {
    const debouncer = new KeyedDebouncer(500);
    const fnA = vi.fn();
    const fnB = vi.fn();

    debouncer.trigger('loc-1::item-1', fnA);
    debouncer.trigger('loc-2::item-9', fnB);
    vi.advanceTimersByTime(500);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('a trigger AFTER the previous one already fired starts a fresh debounce window (a later crossing still notifies)', () => {
    const debouncer = new KeyedDebouncer(500);
    const fn = vi.fn();

    debouncer.trigger('loc-1::item-1', fn);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);

    debouncer.trigger('loc-1::item-1', fn);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clear() cancels every pending timer without invoking the callback', () => {
    const debouncer = new KeyedDebouncer(500);
    const fn = vi.fn();

    debouncer.trigger('loc-1::item-1', fn);
    debouncer.trigger('loc-2::item-2', fn);
    expect(debouncer.pendingCount).toBe(2);

    debouncer.clear();
    expect(debouncer.pendingCount).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('pendingCount reflects in-flight (not yet fired) keys only', () => {
    const debouncer = new KeyedDebouncer(200);
    debouncer.trigger('a', () => {});
    debouncer.trigger('b', () => {});
    expect(debouncer.pendingCount).toBe(2);

    vi.advanceTimersByTime(200);
    expect(debouncer.pendingCount).toBe(0);
  });
});
