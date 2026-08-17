/**
 * FR-LOG-02's hard truck-type split, mirrored client-side for immediate
 * dispatcher feedback — the server (`apps/backend/.../storage-type.util.ts`'s
 * `allowedStorageTypesForShipment`, called from
 * `surat-jalan.service.ts#assertLinesMatchShipmentType`) remains the
 * authority and re-checks every line on `POST /delivery/surat-jalan`
 * (`ERR_SHIPMENT_TYPE_MIX` on a mismatch); this only lets the dispatcher see
 * the problem before submitting instead of after a 400 comes back.
 *
 * Owner decision (2026-08-17): Indonesia's cold-chain truck ALWAYS carries a
 * chiller, so `shipmentType: 'frozen'` means "the cold-chain-capable
 * vehicle" and legitimately carries BOTH `frozen` and `chilled` goods in one
 * run. `'dry'` is the plain ambient truck — dry goods only. Two truck types;
 * the split is just not a 1:1 mirror of `items.storageType`.
 *
 * `components/warehouse/SjCreateForm.tsx` already builds this same rule
 * inline (`isCompatible`, not exported) for its own picker; this module
 * exists so F-DELIVERY's screens get an exported, independently-testable
 * version rather than a third silent reimplementation with no test coverage
 * of its own.
 */
export type ShipmentTypeKey = 'frozen' | 'dry';
export type StorageTypeKey = 'frozen' | 'chilled' | 'dry';

/** Which `items.storageType`s may ride a given `shipmentType` truck (FR-LOG-02). */
export function allowedStorageTypesForShipment(shipmentType: ShipmentTypeKey): StorageTypeKey[] {
  return shipmentType === 'frozen' ? ['frozen', 'chilled'] : ['dry'];
}

/** True when an item of the given storage type may legally ride this shipment's truck. */
export function isStorageTypeAllowed(shipmentType: ShipmentTypeKey, storageType: StorageTypeKey): boolean {
  return allowedStorageTypesForShipment(shipmentType).includes(storageType);
}

/**
 * Filters a set of candidate lines down to only those compatible with the
 * chosen truck — the structural enforcement (mixing becomes impossible to
 * build, not merely rejected after the fact) that `SjCreateForm` already
 * applies to its own request/line picker; exposed here as a pure, reusable,
 * unit-tested predicate for any other F-DELIVERY screen that needs the same
 * guarantee (e.g. flagging a stray line on a detail view).
 */
export function partitionLinesByShipmentType<T extends { storageType?: StorageTypeKey }>(
  lines: readonly T[],
  shipmentType: ShipmentTypeKey,
): { compatible: T[]; excluded: T[] } {
  const compatible: T[] = [];
  const excluded: T[] = [];
  for (const line of lines) {
    // A line with no declared storage type (defensive — every real `items` row has one) is treated as
    // compatible rather than silently dropped, matching `SjCreateForm.isCompatible`'s own `!storageType` case.
    if (!line.storageType || isStorageTypeAllowed(shipmentType, line.storageType)) {
      compatible.push(line);
    } else {
      excluded.push(line);
    }
  }
  return { compatible, excluded };
}
