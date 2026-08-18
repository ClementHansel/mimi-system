import { describe, it, expect } from 'vitest';
import { SyncEntity, SyncOriginType } from '@mimi/shared';
import {
  AUTHORITY,
  canOriginate,
  isKnownSyncEntity,
  resolveDirection,
  resolvePullScope,
  wireEligibleEntities,
} from './authority-matrix';

describe('AUTHORITY coverage', () => {
  it('has an entry for every SyncEntity value', () => {
    for (const value of Object.values(SyncEntity)) {
      expect(AUTHORITY[value], `missing AUTHORITY entry for SyncEntity.${value}`).toBeDefined();
    }
  });

  it('classifies every SyncEntity as M, F, or B (never D/X/T, except the flagged service_history gap)', () => {
    for (const value of Object.values(SyncEntity)) {
      const meta = AUTHORITY[value]!;
      if (value === SyncEntity.SERVICE_HISTORY) {
        expect(meta.class).toBe('D'); // documented CONTRACT NOTE
        continue;
      }
      expect(['M', 'F', 'B']).toContain(meta.class);
    }
  });
});

describe('canOriginate — master data is read-only offline, no exceptions', () => {
  it('a device can never push a class-M entity', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.ITEMS, 'updated')).toBe(false);
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.USERS, 'created')).toBe(false);
    expect(canOriginate(SyncOriginType.NODE, SyncEntity.PRODUCTS, 'price_changed')).toBe(false);
  });

  it('the cloud may originate any known (entity, op) pair, including class M', () => {
    expect(canOriginate(SyncOriginType.CLOUD, SyncEntity.ITEMS, 'updated')).toBe(true);
    expect(canOriginate(SyncOriginType.CLOUD, SyncEntity.PRODUCTS, 'price_changed')).toBe(true);
  });
});

describe('canOriginate — known non-wire entities (class D/X/T) always reject a push', () => {
  it('rejects a push against a derived entity', () => {
    expect(canOriginate(SyncOriginType.DEVICE, 'stock_balances', 'updated')).toBe(false);
    expect(canOriginate(SyncOriginType.CLOUD, 'stock_movements', 'anything')).toBe(false);
  });

  it('rejects a push against a cloud-only entity', () => {
    expect(canOriginate(SyncOriginType.DEVICE, 'suppliers', 'updated')).toBe(false);
    expect(canOriginate(SyncOriginType.NODE, 'purchase_orders', 'created')).toBe(false);
  });

  it('rejects a push against telemetry (device_heartbeats is not a sync event)', () => {
    expect(canOriginate(SyncOriginType.DEVICE, 'device_heartbeats', 'anything')).toBe(false);
  });

  it('rejects a device push against every D-18/D-19 statutory/cash-variance table — these are precisely the tables an offline-capable device might plausibly try to write, so authority_violation must be unconditional', () => {
    const amendmentTables = [
      'bpjs_configs',
      'pph21_ter_rates',
      'pph21_ptkp',
      'pph21_article17_brackets',
      'employee_tax_profiles',
      'cash_variance_proposals',
    ];
    const plausibleOps = ['created', 'updated', 'recorded', 'approved', 'requested'];
    for (const table of amendmentTables) {
      for (const tier of [SyncOriginType.DEVICE, SyncOriginType.NODE, SyncOriginType.CLOUD]) {
        for (const op of plausibleOps) {
          expect(
            canOriginate(tier, table, op),
            `${tier} should never originate ${table}.${op}`,
          ).toBe(false);
        }
      }
    }
  });

  it('rejects an entirely unknown entity name (malformed)', () => {
    expect(canOriginate(SyncOriginType.DEVICE, 'not_a_real_table', 'created')).toBe(false);
  });
});

describe('canOriginate — class F (fact) entities are push-only from device/node', () => {
  it('a device may push sales.completed', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.SALES, 'completed')).toBe(true);
  });

  it("a device may not push an op outside the entity's vocabulary", () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.SALES, 'refunded')).toBe(false);
  });

  it('a node may push attendance.checked_in on behalf of a relayed device', () => {
    expect(canOriginate(SyncOriginType.NODE, SyncEntity.ATTENDANCE, 'checked_in')).toBe(true);
  });
});

describe('canOriginate — class B (bidirectional) entities: push side is device-eligible, decision side is not', () => {
  it('a device may push a replenishment submission', () => {
    expect(
      canOriginate(SyncOriginType.DEVICE, SyncEntity.REPLENISHMENT_REQUESTS, 'submitted'),
    ).toBe(true);
  });

  it('a device may push the outlet-supervisor offline-provisional approval op', () => {
    expect(
      canOriginate(
        SyncOriginType.DEVICE,
        SyncEntity.REPLENISHMENT_REQUESTS,
        'supervisor_approved_offline',
      ),
    ).toBe(true);
  });

  it('stock_opname adjudication (approved/rejected) is cloud-only, never device-originated', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.STOCK_OPNAME, 'approved')).toBe(false);
    expect(canOriginate(SyncOriginType.CLOUD, SyncEntity.STOCK_OPNAME, 'approved')).toBe(true);
  });

  it('payment_verifications is pull-only: no device push op exists at all', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.PAYMENT_VERIFICATIONS, 'verified')).toBe(
      false,
    );
    expect(canOriginate(SyncOriginType.CLOUD, SyncEntity.PAYMENT_VERIFICATIONS, 'verified')).toBe(
      true,
    );
  });
});

describe('the notifications push exception (read_marked)', () => {
  it('a device may push notifications.read_marked even though the entity is otherwise pull-only', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.NOTIFICATIONS, 'read_marked')).toBe(true);
  });

  it('a device may not push notifications.issued', () => {
    expect(canOriginate(SyncOriginType.DEVICE, SyncEntity.NOTIFICATIONS, 'issued')).toBe(false);
  });
});

describe('resolveDirection / resolvePullScope / isKnownSyncEntity', () => {
  it('resolves direction for known entities and undefined for unknown ones', () => {
    expect(resolveDirection(SyncEntity.SALES)).toBe('push');
    expect(resolveDirection('not_a_table')).toBeUndefined();
  });

  it('resolves pull scope', () => {
    expect(resolvePullScope(SyncEntity.LOCATIONS)).toBe('global');
    expect(resolvePullScope(SyncEntity.ATTENDANCE)).toBe('own_location');
  });

  it('isKnownSyncEntity is false for class D/X/T names even if present in AUTHORITY', () => {
    expect(isKnownSyncEntity('stock_balances')).toBe(false);
    expect(isKnownSyncEntity('suppliers')).toBe(false);
    expect(isKnownSyncEntity(SyncEntity.SALES)).toBe(true);
  });
});

describe('wireEligibleEntities', () => {
  it('returns exactly the SyncEntity members minus the flagged service_history gap', () => {
    const wireEntities = new Set(wireEligibleEntities());
    for (const value of Object.values(SyncEntity)) {
      if (value === SyncEntity.SERVICE_HISTORY) {
        expect(wireEntities.has(value)).toBe(false);
      } else {
        expect(wireEntities.has(value)).toBe(true);
      }
    }
  });
});
