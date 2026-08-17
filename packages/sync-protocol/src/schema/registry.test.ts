import { describe, it, expect } from 'vitest';
import { AUTHORITY, wireEligibleEntities } from '../authority-matrix';
import { PAYLOAD_SCHEMA_KEYS, getPayloadSchema, isRegisteredPayloadKey, validatePayloadData } from './index';

describe('payload schema coverage vs. the authority matrix', () => {
  it('has a registered payload schema for EVERY (entity, op) pair the authority matrix declares wire-eligible (class M/F/B)', () => {
    const missing: string[] = [];
    for (const entity of wireEligibleEntities()) {
      const meta = AUTHORITY[entity]!;
      for (const op of [...meta.ops, ...(meta.pushExceptionOps ?? [])]) {
        if (!isRegisteredPayloadKey(entity, op)) missing.push(`${entity}.${op}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers NO schema for any class D/X/T (non-wire-eligible) entity', () => {
    const spuriouslyRegistered: string[] = [];
    for (const [entityName, meta] of Object.entries(AUTHORITY)) {
      if (meta.class === 'M' || meta.class === 'F' || meta.class === 'B') continue;
      for (const op of meta.ops) {
        if (isRegisteredPayloadKey(entityName, op)) spuriouslyRegistered.push(`${entityName}.${op}`);
      }
    }
    expect(spuriouslyRegistered).toEqual([]);
  });

  it('has no orphan schema entries for a pair the authority matrix does not declare (catches a stale/renamed op)', () => {
    const orphans: string[] = [];
    for (const key of PAYLOAD_SCHEMA_KEYS) {
      const dotIndex = key.lastIndexOf('.');
      const entity = key.slice(0, dotIndex);
      const op = key.slice(dotIndex + 1);
      const meta = AUTHORITY[entity];
      const validOp = meta !== undefined && (meta.ops.includes(op) || (meta.pushExceptionOps ?? []).includes(op));
      if (!validOp) orphans.push(key);
    }
    expect(orphans).toEqual([]);
  });

  it('covers exactly 139 (entity, op) pairs — every op of every wire-eligible entity, no more, no less', () => {
    const expectedCount = wireEligibleEntities().reduce((sum, entity) => {
      const meta = AUTHORITY[entity]!;
      return sum + meta.ops.length + (meta.pushExceptionOps?.length ?? 0);
    }, 0);
    expect(PAYLOAD_SCHEMA_KEYS).toHaveLength(expectedCount);
  });
});

describe('getPayloadSchema / isRegisteredPayloadKey', () => {
  it('returns undefined/false for an unknown pair', () => {
    expect(getPayloadSchema('not_a_table', 'created')).toBeUndefined();
    expect(isRegisteredPayloadKey('not_a_table', 'created')).toBe(false);
  });

  it('returns undefined/false for a real entity with a bogus op', () => {
    expect(getPayloadSchema('sales', 'refunded')).toBeUndefined();
    expect(isRegisteredPayloadKey('sales', 'refunded')).toBe(false);
  });

  it('returns the schema for a real pair', () => {
    expect(getPayloadSchema('sales', 'completed')).toBeDefined();
  });
});

describe('validatePayloadData — spot checks against realistic payloads', () => {
  it('accepts a well-formed sales.completed payload', () => {
    const result = validatePayloadData('sales', 'completed', {
      clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      shiftId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
      occurredAt: '2026-08-17T05:00:00.000Z',
      lines: [{ productId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890', qty: '2.000', unitPrice: '45000.00' }],
      payments: [{ method: 'cash', amount: '90000.00' }],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a sales.completed payload with a malformed money field', () => {
    const result = validatePayloadData('sales', 'completed', {
      clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      shiftId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
      occurredAt: '2026-08-17T05:00:00.000Z',
      lines: [{ productId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890', qty: '2.000', unitPrice: '45000.000' /* 3dp exceeds Money's 2dp scale */ }],
      payments: [{ method: 'cash', amount: '90000.00' }],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts the entity the coordinator named directly: stock_adjustments.posted', () => {
    const result = validatePayloadData('stock_adjustments', 'posted', {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      storageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
      itemId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890',
      qtyDelta: '-2.500',
      unitCost: '20000.00',
      reason: 'opname shortfall',
      source: 'opname',
      direction: 'shortage',
      opnameId: null,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects stock_adjustments.posted with an invalid source enum value', () => {
    const result = validatePayloadData('stock_adjustments', 'posted', {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      storageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
      itemId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890',
      qtyDelta: '-2.500',
      unitCost: '20000.00',
      reason: 'x',
      source: 'guesswork',
      direction: 'shortage',
      opnameId: null,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a sj_drops.received payload (photo/signature wajib, FR-LOG-15)', () => {
    const result = validatePayloadData('sj_drops', 'received', {
      dropId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      lines: [{ lineId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', qtyReceived: '10.000', receivedStorageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }],
      photoAttachmentIds: ['d1b2c3d4-e5f6-7890-abcd-ef1234567890'],
      signatureAttachmentId: 'e1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects sj_drops.received missing the wajib signature attachment', () => {
    const result = validatePayloadData('sj_drops', 'received', {
      dropId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      lines: [],
      photoAttachmentIds: [],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts an attendance.checked_in payload (FR-HR-01)', () => {
    const result = validatePayloadData('attendance', 'checked_in', {
      clientId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      lat: '-1.234567',
      lng: '116.123456',
      accuracyM: 8,
      selfieAttachmentId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a replenishment_requests.submitted payload with embedded lines', () => {
    const result = validatePayloadData('replenishment_requests', 'submitted', {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      requestNumber: 'RR/202608/0001',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
      neededBy: null,
      source: 'manual',
      lines: [{ itemId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890', qtyRequested: '5.000', unitId: 'd1b2c3d4-e5f6-7890-abcd-ef1234567890' }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts devices.registered (D-13 pairing handshake facts)', () => {
    const result = validatePayloadData('devices', 'registered', {
      fingerprint: 'abc123',
      category: 'tablet',
      locationId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
    expect(result.ok).toBe(true);
  });

  it('reports a clear error for an unregistered (entity, op) pair rather than silently passing', () => {
    const result = validatePayloadData('sales', 'not_a_real_op', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toContain('No payload schema registered');
  });

  it('reports a clear error for an entirely unknown entity', () => {
    const result = validatePayloadData('not_a_real_table', 'created', {});
    expect(result.ok).toBe(false);
  });
});
