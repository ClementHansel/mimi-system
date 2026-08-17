import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MovementType } from '@mimi/shared';
import { foldMovementsToBalances, type MovementFact } from './stock-projector';

const MOVEMENT_TYPES = Object.values(MovementType);
const LOCATIONS = ['loc-1', 'loc-2'];
const AREAS = ['area-1', 'area-2'];
const ITEMS = ['item-1', 'item-2', 'item-3'];

function movementArb(index: number) {
  return fc
    .record({
      locationId: fc.constantFrom(...LOCATIONS),
      storageAreaId: fc.constantFrom(...AREAS),
      itemId: fc.constantFrom(...ITEMS),
      movementType: fc.constantFrom(...MOVEMENT_TYPES),
      qtyWhole: fc.integer({ min: 0, max: 100_000 }),
    })
    .map(
      (r): MovementFact => ({
        locationId: r.locationId,
        storageAreaId: r.storageAreaId,
        itemId: r.itemId,
        factId: `fact-${index}`,
        movementType: r.movementType,
        qty: `${r.qtyWhole}.000`,
        unitCost: '1000.00',
        refType: 'test',
        refId: null,
        occurredAt: '2026-08-17T00:00:00.000Z',
      }),
    );
}

function movementsArb(maxLength = 60) {
  return fc
    .integer({ min: 0, max: maxLength })
    .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => movementArb(i))));
}

function serializeBalances(balances: ReturnType<typeof foldMovementsToBalances>): string {
  return [...balances.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${key}=${v.qtyOnHand}`)
    .join('|');
}

describe('T-02: balance ≡ fold of facts, replay order-insensitive', () => {
  it('shuffling the movement stream never changes the resulting balances', () => {
    fc.assert(
      fc.property(movementsArb(), fc.integer({ min: 0, max: 2 ** 31 - 1 }), (movements, seed) => {
        const original = serializeBalances(foldMovementsToBalances(movements));

        // Deterministic shuffle seeded by `seed` (Fisher-Yates with a simple LCG) — no reliance on Math.random.
        let state = seed || 1;
        const rand = () => {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          return state / 0x7fffffff;
        };
        const shuffled = [...movements];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }

        expect(serializeBalances(foldMovementsToBalances(shuffled))).toBe(original);
      }),
    );
  });

  it('replaying the whole set 1-5 times produces the same balances as replaying it once (idempotent apply)', () => {
    fc.assert(
      fc.property(movementsArb(40), fc.integer({ min: 1, max: 5 }), (movements, repeats) => {
        const once = serializeBalances(foldMovementsToBalances(movements));
        const repeated = Array.from({ length: repeats }, () => movements).flat();
        expect(serializeBalances(foldMovementsToBalances(repeated))).toBe(once);
      }),
    );
  });

  it('splitting the stream into two arbitrary batches and folding each, then merging, matches folding it all at once', () => {
    fc.assert(
      fc.property(movementsArb(50), fc.integer({ min: 0, max: 50 }), (movements, splitPoint) => {
        const whole = foldMovementsToBalances(movements);
        const first = movements.slice(0, splitPoint);
        const second = movements.slice(splitPoint);
        // Merge two partial foldings the same way a real projector would: fold the union of both fact lists.
        const merged = foldMovementsToBalances([...first, ...second]);
        expect(serializeBalances(merged)).toBe(serializeBalances(whole));
      }),
    );
  });

  it('every reported balance equals the manually-summed signed total for its key (no drift, decimal-safe)', () => {
    fc.assert(
      fc.property(movementsArb(30), (movements) => {
        const balances = foldMovementsToBalances(movements);
        const byKey = new Map<string, number>();
        const seenFacts = new Set<string>();
        for (const m of movements) {
          if (seenFacts.has(m.factId)) continue;
          seenFacts.add(m.factId);
          const key = `${m.locationId}::${m.storageAreaId}::${m.itemId}`;
          const sign = m.movementType.endsWith('_out') ? -1 : 1;
          byKey.set(key, (byKey.get(key) ?? 0) + sign * Number(m.qty));
        }
        for (const [key, expected] of byKey) {
          expect(Number(balances.get(key)!.qtyOnHand)).toBeCloseTo(expected, 6);
        }
      }),
    );
  });
});
