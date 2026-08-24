'use client';
import { useState } from 'react';

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
import { DriverRouteMap } from './DriverRouteMap';
import { routeProgress, orderedDrops, isFinished } from './lib/route-progress';
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
  const drops = orderedDrops(sj.drops);
  /** The stop the driver last tapped in the list; the map pans to its pin. */
  const [focusedDropId, setFocusedDropId] = useState<string | null>(null);
  const progress = routeProgress(sj.drops);

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

        {/* Orientation first: how far through the run, then the shape of it.
            A driver glancing at this between stops needs "how many left"
            before anything else on the card. */}
        {progress.total > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-text-primary">
                {t('driver.progress.summary', { done: progress.done, total: progress.total })}
              </span>
              {progress.failed > 0 && (
                <span className="text-xs font-medium text-danger-700">
                  {t('driver.progress.failed', { count: progress.failed })}
                </span>
              )}
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200"
              role="progressbar"
              aria-valuenow={progress.done}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-[width]"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Map and stop list side by side once there is room for both, stacked
            below that.
            
            The driver's own device is a phone, where stacked is the only sane
            layout and the map must come first — it answers "where am I going"
            before the list answers "what do I do there". But gudang and the
            owner open this same screen on a desktop, where a full-width map
            with the stops pushed under it wastes the right half of the window
            and hides the route order the warehouse just set. Owner asked for
            the list beside the map; `lg:` is where that becomes true without
            costing the phone anything.

            `lg:items-start` stops the map column stretching to match a long
            stop list — a 260px map does not want to be 900px tall. */}
        <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          {/* STICKY on desktop. The stop list is far taller than the map, so a
              statically-placed map scrolled away the moment the driver looked
              past the second drop — leaving a long column of empty space where
              the map had been, and no map at the exact moment they were reading
              about a stop. Sticky keeps "where am I going" on screen while
              "what do I do there" scrolls beside it, and fills the column.

              `top-4` clears the sticky page header; the height is capped to the
              viewport in DriverRouteMap so a tall map cannot outgrow its own
              sticky window. */}
          <div className="lg:sticky lg:top-4">
            <DriverRouteMap
              drops={drops}
              nextDropId={progress.nextDropId}
              focusedDropId={focusedDropId}
            />
          </div>

          {/* Finished stops collapse. On a seven-stop run the screen is
              otherwise mostly history, and the one card that matters — the next
              stop — is pushed below the fold on a phone. */}
          <div className="flex flex-col gap-3">
            {drops.map((drop) => (
              <DropCard
                key={drop.id}
                sj={sj}
                drop={drop}
                onChanged={onChanged}
                isNext={drop.id === progress.nextDropId}
                defaultCollapsed={isFinished(drop)}
                isFocused={drop.id === focusedDropId}
                onFocus={() => setFocusedDropId(drop.id)}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
