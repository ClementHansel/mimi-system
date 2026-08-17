import { BadRequestException } from '@nestjs/common';
import { StorageAreaType } from '@mimi/shared';

export type ItemStorageType = 'frozen' | 'chilled' | 'dry';

/**
 * D-15 putaway rule ("Received goods land in the right area: frozen into the
 * freezer, dry into dry store"): the ONE storage-area type an item of a given
 * `items.storage_type` may be received/held in. Used both to validate a
 * receiving line's `receivedStorageAreaId` and to resolve the warehouse-side
 * area a Surat Jalan's stock leaves from at dispatch.
 */
export function requiredAreaTypeFor(itemStorageType: ItemStorageType): StorageAreaType {
  switch (itemStorageType) {
    case 'frozen':
      return StorageAreaType.FREEZER;
    case 'chilled':
      return StorageAreaType.CHILLER;
    case 'dry':
      return StorageAreaType.DRY_STORE;
  }
}

/** Throws `ERR_VALIDATION` (via `BadRequestException`) when the chosen area's type doesn't match the item's storage type. */
export function assertAreaMatchesStorageType(itemStorageType: ItemStorageType, areaType: string, itemName: string, areaName: string): void {
  const required = requiredAreaTypeFor(itemStorageType);
  if (areaType !== required) {
    throw new BadRequestException({
      code: 'ERR_VALIDATION',
      message: `${itemName} is '${itemStorageType}' and must be putaway in a '${required}' area — '${areaName}' is '${areaType}'`,
    });
  }
}

/**
 * Which `items.storage_type`s may travel on a given `shipment_types.key` truck
 * (owner decision, 2026-08-17, cross-referencing FR-LOG-02): Indonesia's cold
 * truck ALWAYS carries a chiller, so a single 'frozen' shipment type means
 * "the cold-chain-capable vehicle" — it legitimately carries BOTH frozen AND
 * chilled goods in one run. 'dry' is the plain ambient truck, dry goods only.
 * There are still exactly two truck types; the split just isn't a 1:1 mirror
 * of `items.storage_type` anymore for the cold one.
 */
export function allowedStorageTypesForShipment(shipmentType: 'frozen' | 'dry'): ItemStorageType[] {
  return shipmentType === 'frozen' ? ['frozen', 'chilled'] : ['dry'];
}

/** Storage-type classes that ride a cold-chain ('frozen') truck and therefore need a per-class temperature check — everything else ('dry') never breaches (no range to breach against). */
export const COLD_CHAIN_STORAGE_TYPES: readonly ItemStorageType[] = ['frozen', 'chilled'];
