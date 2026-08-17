import { describe, it, expect } from 'vitest';
import { allowedStorageTypesForShipment, isStorageTypeAllowed, partitionLinesByShipmentType } from './truck-rules';

describe('allowedStorageTypesForShipment — FR-LOG-02 truck split', () => {
  it('a frozen (cold-chain) truck carries both frozen AND chilled goods', () => {
    expect(allowedStorageTypesForShipment('frozen')).toEqual(['frozen', 'chilled']);
  });

  it('a dry truck carries dry goods only', () => {
    expect(allowedStorageTypesForShipment('dry')).toEqual(['dry']);
  });
});

describe('isStorageTypeAllowed — the rule the chiller/dry truck split cannot violate', () => {
  it.each([
    ['frozen', 'frozen', true],
    ['frozen', 'chilled', true],
    ['frozen', 'dry', false],
    ['dry', 'dry', true],
    ['dry', 'frozen', false],
    ['dry', 'chilled', false],
  ] as const)('shipmentType=%s storageType=%s -> %s', (shipmentType, storageType, expected) => {
    expect(isStorageTypeAllowed(shipmentType, storageType)).toBe(expected);
  });

  it('never allows frozen goods onto a dry truck, for any storage type the dry truck accepts', () => {
    for (const storageType of allowedStorageTypesForShipment('dry')) {
      expect(storageType).not.toBe('frozen');
      expect(storageType).not.toBe('chilled');
    }
  });

  it('never allows dry goods onto the cold-chain truck', () => {
    expect(allowedStorageTypesForShipment('frozen')).not.toContain('dry');
  });
});

describe('partitionLinesByShipmentType', () => {
  const lines = [
    { id: 'a', storageType: 'frozen' as const },
    { id: 'b', storageType: 'chilled' as const },
    { id: 'c', storageType: 'dry' as const },
  ];

  it('a frozen SJ keeps frozen+chilled and excludes dry — mixing is structurally impossible to build', () => {
    const { compatible, excluded } = partitionLinesByShipmentType(lines, 'frozen');
    expect(compatible.map((l) => l.id)).toEqual(['a', 'b']);
    expect(excluded.map((l) => l.id)).toEqual(['c']);
  });

  it('a dry SJ keeps only dry and excludes frozen+chilled', () => {
    const { compatible, excluded } = partitionLinesByShipmentType(lines, 'dry');
    expect(compatible.map((l) => l.id)).toEqual(['c']);
    expect(excluded.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('treats an undeclared storage type as compatible (defensive default, never silently dropped)', () => {
    const { compatible, excluded } = partitionLinesByShipmentType([{ id: 'x' }], 'dry');
    expect(compatible.map((l) => l.id)).toEqual(['x']);
    expect(excluded).toEqual([]);
  });
});
