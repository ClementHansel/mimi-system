import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './event-bus.service';
import { DomainEvent } from './domain-events';

const samplePayload = {
  movementId: 'm1',
  locationId: 'loc1',
  storageAreaId: 'area1',
  itemId: 'item1',
  movementType: 'usage_out',
  qtyDelta: '-1.000',
  unitCost: '1000.00',
  refType: 'sale',
  refId: 'ref1',
  mode: 'strict' as const,
  actorId: 'user1',
  occurredAt: '2026-08-16T00:00:00.000Z',
};

describe('EventBus', () => {
  it('delivers a published event to a subscriber of the same type', async () => {
    const bus = new EventBus();
    const received: DomainEvent[] = [];
    bus.subscribe('stock.moved', (event) => {
      received.push(event);
    });

    const result = await bus.publish('stock.moved', samplePayload);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('stock.moved');
    expect(received[0]!.payload).toEqual(samplePayload);
    expect(result).toEqual({ handled: 1, failed: 0 });
  });

  it('does not deliver to a subscriber of a different event type', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe('product.price_changed', handler);

    await bus.publish('stock.moved', samplePayload);

    expect(handler).not.toHaveBeenCalled();
  });

  it('runs multiple handlers for the same type in subscription order, sequentially', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe('stock.moved', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('first');
    });
    bus.subscribe('stock.moved', async () => {
      order.push('second');
    });

    await bus.publish('stock.moved', samplePayload);

    expect(order).toEqual(['first', 'second']);
  });

  it('one handler throwing does not stop a sibling handler from running, and publish() still resolves', async () => {
    const bus = new EventBus();
    const secondHandler = vi.fn();
    bus.subscribe('stock.moved', () => {
      throw new Error('boom');
    });
    bus.subscribe('stock.moved', secondHandler);

    const result = await bus.publish('stock.moved', samplePayload);

    expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ handled: 1, failed: 1 });
  });

  it('subscribeAll observes every event type', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeAll((event) => {
      seen.push(event.type);
    });

    await bus.publish('stock.moved', samplePayload);
    await bus.publish('product.price_changed', {
      productId: 'p1',
      oldPrice: '10000.00',
      newPrice: '11000.00',
      changedBy: 'user1',
      occurredAt: '2026-08-16T00:00:00.000Z',
    });

    expect(seen).toEqual(['stock.moved', 'product.price_changed']);
  });

  it('unsubscribe stops further delivery', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('stock.moved', handler);

    await bus.publish('stock.moved', samplePayload);
    unsubscribe();
    await bus.publish('stock.moved', samplePayload);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('defaults occurredAt to now when omitted', async () => {
    const bus = new EventBus();
    let captured: DomainEvent | undefined;
    bus.subscribe('stock.moved', (event) => {
      captured = event;
    });

    const before = Date.now();
    await bus.publish('stock.moved', samplePayload);
    const after = Date.now();

    expect(captured).toBeDefined();
    const ts = new Date(captured!.occurredAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
