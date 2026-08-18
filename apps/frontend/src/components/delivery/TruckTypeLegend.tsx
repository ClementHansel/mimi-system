'use client';

import { Snowflake, Package } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Badge } from '@/components/ui';
import { allowedStorageTypesForShipment, type ShipmentTypeKey } from './lib/truck-rules';

/**
 * Makes the FR-LOG-02 truck split visually unambiguous wherever a Surat
 * Jalan's `shipmentType` is shown (list row, detail header): 'frozen' is the
 * cold-chain/chiller truck (frozen + chilled goods together), 'dry' is the
 * separate ambient truck (dry goods only) — never rendered as a bare status
 * word, always paired with the icon + which goods classes ride it.
 */
export function TruckTypeBadge({
  shipmentType,
  size = 'md',
}: {
  shipmentType: ShipmentTypeKey;
  size?: 'sm' | 'md';
}) {
  const { t } = useI18n();
  const isChiller = shipmentType === 'frozen';
  return (
    <Badge variant={isChiller ? 'info' : 'default'} size={size}>
      {isChiller ? (
        <Snowflake className="size-3.5" aria-hidden />
      ) : (
        <Package className="size-3.5" aria-hidden />
      )}
      {isChiller ? t('delivery.truckChiller') : t('delivery.truckDry')}
    </Badge>
  );
}

/** The compatible-storage-types line under the badge, e.g. "frozen, chilled" — spells out exactly what FR-LOG-02 allows so "never mixed" reads as a fact, not a slogan. */
export function truckTypeStorageSummary(shipmentType: ShipmentTypeKey): string {
  return allowedStorageTypesForShipment(shipmentType).join(' + ');
}
