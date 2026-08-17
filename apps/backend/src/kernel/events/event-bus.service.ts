import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent, DomainEventPayloadMap, DomainEventType } from './domain-events';

export type DomainEventHandler<T extends DomainEventType> = (
  event: DomainEvent<T>,
) => void | Promise<void>;

/** A handler subscribed via `subscribeAll` sees every event, envelope included. */
export type WildcardHandler = (event: DomainEvent) => void | Promise<void>;

/**
 * In-process, typed publish/subscribe bus (kernel/events, BUILD-PLAN §5 W2-C).
 *
 * Deliberately NOT a message queue: every subscriber runs in this same
 * process, synchronously reachable, with no persistence or redelivery. That
 * is the correct tool here — cross-tier durability is `sync_events`
 * (SYNC-PROTOCOL), and cross-request retry is each channel's own concern
 * (kernel/notification's outbox). `EventBus` exists purely so that, e.g.,
 * `StockLedgerService` (W2-A) does not need to import `NotificationService`
 * or the future accounting posting-rule engine (W4-03, M17) to tell them
 * something happened — it publishes `stock.moved` and walks away.
 *
 * SEMANTICS A SUBSCRIBER CAN RELY ON:
 * - Handlers for one event type run in subscription order, awaited
 *   sequentially (not `Promise.all`) — a handler that mutates shared state
 *   (e.g. a running total) will not race a sibling handler for the same
 *   event.
 * - One handler throwing NEVER stops another handler from running, and
 *   NEVER makes `publish()` reject — this bus is a fan-out notifier, not a
 *   distributed transaction. `publish()` awaits every handler (so a caller
 *   who wants "all reactions have at least been attempted" can await it) but
 *   always resolves; failures are logged and returned in-band as a report
 *   for callers/tests that care (never thrown).
 * - `publish()` performs NO I/O of its own beyond invoking handlers — safe
 *   to call from inside or outside a caller's DB transaction. Callers that
 *   want strict "only after commit" semantics should call `publish()` after
 *   their own `COMMIT`, not before (this bus does not defer for them).
 *
 * W4-03 (accounting posting-rule engine, not built yet) is expected to
 * subscribe once via `subscribe('journal.action', ...)` in its module's
 * `onModuleInit`, rather than every emitting module knowing about GL. This
 * is deliberately the seam that consumer is designed against today.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<DomainEventType, DomainEventHandler<DomainEventType>[]>();
  private readonly wildcardHandlers: WildcardHandler[] = [];

  /** Register a handler for exactly one event type. Returns an unsubscribe function. */
  subscribe<T extends DomainEventType>(type: T, handler: DomainEventHandler<T>): () => void {
    const list = (this.handlers.get(type) ?? []) as DomainEventHandler<T>[];
    list.push(handler);
    this.handlers.set(type, list as DomainEventHandler<DomainEventType>[]);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      const idx = current.indexOf(handler as DomainEventHandler<DomainEventType>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /** Register a handler that observes every event type, regardless of subscribers above (used by audit/diagnostics, not by domain logic). */
  subscribeAll(handler: WildcardHandler): () => void {
    this.wildcardHandlers.push(handler);
    return () => {
      const idx = this.wildcardHandlers.indexOf(handler);
      if (idx >= 0) this.wildcardHandlers.splice(idx, 1);
    };
  }

  /**
   * Publish a domain event. Resolves with per-handler outcomes; never
   * rejects on a handler's behalf (see class doc). `occurredAt` defaults to
   * `now()` (ISO-8601) if the caller omits it.
   */
  async publish<T extends DomainEventType>(
    type: T,
    payload: DomainEventPayloadMap[T],
    occurredAt: string = new Date().toISOString(),
  ): Promise<{ handled: number; failed: number }> {
    const event: DomainEvent<T> = { type, payload, occurredAt };
    let failed = 0;
    let handled = 0;

    const specific = (this.handlers.get(type) ?? []) as DomainEventHandler<T>[];
    for (const handler of specific) {
      try {
        await handler(event);
        handled++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Subscriber for '${type}' threw: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    for (const handler of this.wildcardHandlers) {
      try {
        await handler(event as DomainEvent);
        handled++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Wildcard subscriber threw for '${type}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { handled, failed };
  }

  /** Test/diagnostic helper — number of handlers currently registered for a type (wildcard excluded). */
  listenerCount(type: DomainEventType): number {
    return this.handlers.get(type)?.length ?? 0;
  }
}
