'use client';

import { Snowflake, Package, Truck, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, StatusBadge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { DropCard } from './DropCard';
import type { Drop, SuratJalan } from './lib/types';

/**
 * One assigned Surat Jalan: header (SJ number, vehicle, shipment type,
 * seals) + its drops in `dropSeq` order. Each drop is its own `DropCard`, so
 * a multi-drop route reads top-to-bottom as the actual sequence the driver
 * follows.
 */
export function SjJobCard({ sj, onChanged }: { sj: SuratJalan; onChanged: (dropId: string, patch: Partial<Drop>) => void }) {
  const { t } = useI18n();
  const isFrozen = sj.shipmentType === 'frozen';
  const drops = [...sj.drops].sort((a, b) => a.dropSeq - b.dropSeq);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>{sj.sjNumber}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <Truck className="size-3.5" aria-hidden />
              {sj.vehicle.plateNumber}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 font-medium',
                isFrozen ? 'text-cold-700' : 'text-text-secondary',
              )}
            >
              {isFrozen ? <Snowflake className="size-3.5" aria-hidden /> : <Package className="size-3.5" aria-hidden />}
              {isFrozen ? t('driver.shipmentType.frozen') : t('driver.shipmentType.dry')}
            </span>
            {sj.seals.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="size-3.5" aria-hidden />
                {sj.seals.map((s) => s.sealNumber).join(', ')}
              </span>
            )}
          </CardDescription>
        </div>
        <StatusBadge domain="suratJalan" status={sj.status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {drops.map((drop) => (
          <DropCard key={drop.id} sj={sj} drop={drop} onChanged={onChanged} />
        ))}
      </CardContent>
    </Card>
  );
}
