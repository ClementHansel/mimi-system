'use client';

import { Snowflake, Package, Truck, ShieldCheck, MapPinOff, Radio } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  StatusBadge,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { DropCard } from './DropCard';
import { useTripTracking } from './lib/use-trip-tracking';
import type { Drop, SuratJalan } from './lib/types';

/**
 * One assigned Surat Jalan: header (SJ number, vehicle, shipment type,
 * seals) + its drops in `dropSeq` order. Each drop is its own `DropCard`, so
 * a multi-drop route reads top-to-bottom as the actual sequence the driver
 * follows.
 */
export function SjJobCard({
  sj,
  onChanged,
}: {
  sj: SuratJalan;
  onChanged: (dropId: string, patch: Partial<Drop>) => void;
}) {
  const { t } = useI18n();
  const isFrozen = sj.shipmentType === 'frozen';
  const drops = [...sj.drops].sort((a, b) => a.dropSeq - b.dropSeq);

  // Position reporting is scoped to THIS trip and only while it is in transit —
  // the same window the backend enforces. A driver holding two jobs for the day
  // therefore only ever broadcasts for the one they are actually driving.
  const { state: tracking, pending } = useTripTracking(sj.id, sj.status === 'in_transit');

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
              {isFrozen ? (
                <Snowflake className="size-3.5" aria-hidden />
              ) : (
                <Package className="size-3.5" aria-hidden />
              )}
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
        {/*
          Being tracked is stated plainly rather than left implicit. The driver
          is the person whose location this is, and a silent background collector
          is not something to hide behind a settings screen. The denied state is
          equally explicit: dispatch would otherwise read "no position" as a
          broken-down truck rather than an unanswered browser prompt.
        */}
        {tracking === 'active' && (
          <div className="flex items-start gap-2 rounded-lg bg-success-50 p-2.5 text-sm text-success-800">
            <Radio className="mt-0.5 size-4 flex-none" aria-hidden />
            <div>
              <p className="font-medium">{t('driver.tracking.active')}</p>
              <p className="text-xs text-success-700">{t('driver.tracking.activeHint')}</p>
              {pending > 0 && (
                <p className="mt-0.5 text-xs text-success-700">
                  {t('driver.tracking.queued', { count: pending })}
                </p>
              )}
            </div>
          </div>
        )}
        {tracking === 'denied' && (
          <div className="flex items-start gap-2 rounded-lg bg-warning-50 p-2.5 text-sm text-warning-800">
            <MapPinOff className="mt-0.5 size-4 flex-none" aria-hidden />
            <div>
              <p className="font-medium">{t('driver.tracking.denied')}</p>
              <p className="text-xs text-warning-700">{t('driver.tracking.deniedHint')}</p>
            </div>
          </div>
        )}

        {drops.map((drop) => (
          <DropCard key={drop.id} sj={sj} drop={drop} onChanged={onChanged} />
        ))}
      </CardContent>
    </Card>
  );
}
