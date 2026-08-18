'use client';

import { useState } from 'react';
import { AlertTriangle, Info, MapPin, Navigation, Thermometer, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, Button, StatusBadge } from '@/components/ui';
import { fmtTime } from '@/lib/dates';
import { formatTemp } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { nextActionForDrop, tempLogsForDrop } from './lib/cold-chain';
import {
  canNavigate,
  formatCoords,
  googleMapsUrl,
  wazeUrl,
  type NavTarget,
} from './lib/navigation';
import { NavigateLink } from './NavigateLink';
import { DropDepartModal } from './DropDepartModal';
import { DropArriveModal } from './DropArriveModal';
import { DropReceiveModal } from './DropReceiveModal';
import { DropFailModal } from './DropFailModal';
import type { Drop, SuratJalan } from './lib/types';

/**
 * One stop on the route (D-14). Exactly one action button shows at a time,
 * driven by `nextActionForDrop` — large touch targets throughout (this is a
 * one-handed phone screen, possibly in rain), high-contrast status badge,
 * minimal typing until the driver actually opens an action's modal.
 */
export interface DropCardProps {
  sj: SuratJalan;
  drop: Drop;
  onChanged: (dropId: string, patch: Partial<Drop>) => void;
}

export function DropCard({ sj, drop, onChanged }: DropCardProps) {
  const { t } = useI18n();
  const [modal, setModal] = useState<'depart' | 'arrive' | 'receive' | 'fail' | null>(null);
  const action = nextActionForDrop(drop);
  const logs = tempLogsForDrop(sj, drop.id);

  const navTarget: NavTarget = {
    latitude: drop.latitude,
    longitude: drop.longitude,
    address: drop.address,
    locationName: drop.locationName,
  };
  const coords = formatCoords(navTarget);
  const waze = wazeUrl(navTarget);
  // A finished stop keeps its address on the card (useful when reviewing the
  // day) but loses the navigation buttons — routing a driver back to a delivery
  // they already made is never the intent.
  const showNav = canNavigate(navTarget) && action !== 'none';

  function handleDone(patch: Partial<Drop>) {
    setModal(null);
    onChanged(drop.id, patch);
  }

  return (
    <Card className={cn(action === 'none' && 'opacity-90')}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 size-5 flex-none text-text-muted" aria-hidden />
            <div>
              <p className="text-lg font-semibold text-text-primary">
                {t('driver.dropSeq', { seq: drop.dropSeq })} — {drop.locationName}
              </p>
              <p className="text-sm text-text-muted">{drop.city}</p>
              {drop.address && <p className="mt-1 text-sm text-text-secondary">{drop.address}</p>}
              {coords && <p className="mt-0.5 font-mono text-xs text-text-muted">{coords}</p>}
            </div>
          </div>
          <StatusBadge domain="drop" status={drop.status} />
        </div>

        {/*
          The delivery brief gudang wrote for THIS stop. Given its own boxed
          treatment rather than another muted paragraph: it is the one thing on
          the card the driver has not seen before and cannot infer, and it is
          frequently the difference between finding the loading bay and
          circling the block.
        */}
        {drop.deliveryInstructions && (
          <div className="flex items-start gap-2 rounded-lg bg-brand-50 p-3">
            <Info className="mt-0.5 size-4 flex-none text-brand-600" aria-hidden />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                {t('driver.nav.instructions')}
              </p>
              <p className="mt-0.5 whitespace-pre-line text-sm text-text-primary">
                {drop.deliveryInstructions}
              </p>
            </div>
          </div>
        )}

        {/*
          Navigation hands off to the map app already on the phone (see
          lib/navigation.ts). `target="_blank"` + `rel="noopener"` so the PWA
          keeps its own state — a driver bounced out of the app mid-route would
          lose the queue of offline actions they are carrying.
        */}
        {showNav && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <NavigateLink
              href={googleMapsUrl(navTarget)}
              variant="secondary"
              fullWidth
              leftIcon={<Navigation className="size-4" />}
            >
              {t('driver.nav.navigate')}
            </NavigateLink>
            {waze && (
              <NavigateLink href={waze} variant="outline" className="sm:w-auto">
                {t('driver.nav.waze')}
              </NavigateLink>
            )}
          </div>
        )}

        {(drop.departedAt || drop.arrivedAt || drop.receivedAt) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
            {drop.departedAt && (
              <span>
                {t('driver.actions.depart')}: {fmtTime(drop.departedAt)}
              </span>
            )}
            {drop.arrivedAt && (
              <span>
                {t('driver.actions.arrive')}: {fmtTime(drop.arrivedAt)}
              </span>
            )}
            {drop.receivedAt && (
              <span>
                {t('driver.actions.receive')}: {fmtTime(drop.receivedAt)}
              </span>
            )}
          </div>
        )}

        {logs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {/*
              Breach state is `l.isBreach` straight off the wire — the
              backend resolves it per-class (chiller 0..5°C / freezer
              -25..-15°C, whichever classes are still onboard) and reports it
              here; this surface never recomputes it. Color is paired with a
              distinct icon AND an explicit "breach" word, not color alone
              (StatusBadge's own accessibility rule). We can't yet name WHICH
              class breached — CONTRACTS.md's `TempLog` has no such field —
              see this ticket's report for the follow-up asked of the
              `@mimi/shared` owner.
            */}
            {logs.map((l) => (
              <span
                key={l.id}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                  l.isBreach ? 'bg-danger-50 text-danger-700' : 'bg-cold-50 text-cold-700',
                )}
              >
                {l.isBreach ? (
                  <AlertTriangle className="size-3.5" aria-hidden />
                ) : (
                  <Thermometer className="size-3.5" aria-hidden />
                )}
                {t(`driver.coldChain.stage.${l.stage}`)}: {formatTemp(l.tempC)}
                {l.isBreach && ` — ${t('driver.coldChain.breach')}`}
              </span>
            ))}
          </div>
        )}

        {drop.discrepancyNotes && (
          <p className="text-sm text-warning-700">{drop.discrepancyNotes}</p>
        )}

        {action !== 'none' && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {action === 'depart' && (
              <Button size="touch-lg" fullWidth onClick={() => setModal('depart')}>
                {t('driver.actions.depart')}
              </Button>
            )}
            {action === 'arrive' && (
              <Button size="touch-lg" fullWidth onClick={() => setModal('arrive')}>
                {t('driver.actions.arrive')}
              </Button>
            )}
            {action === 'receive' && (
              <Button size="touch-lg" fullWidth onClick={() => setModal('receive')}>
                {t('driver.actions.receive')}
              </Button>
            )}
            <Button
              size="touch-lg"
              variant="outline"
              className="sm:w-auto"
              leftIcon={<XCircle className="size-4" />}
              onClick={() => setModal('fail')}
            >
              {t('driver.actions.fail')}
            </Button>
          </div>
        )}
      </CardContent>

      {modal === 'depart' && (
        <DropDepartModal
          open
          sj={sj}
          drop={drop}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      )}
      {modal === 'arrive' && (
        <DropArriveModal
          open
          sj={sj}
          drop={drop}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      )}
      {modal === 'receive' && (
        <DropReceiveModal
          open
          sj={sj}
          drop={drop}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      )}
      {modal === 'fail' && (
        <DropFailModal open drop={drop} onClose={() => setModal(null)} onDone={handleDone} />
      )}
    </Card>
  );
}
