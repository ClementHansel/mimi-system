'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  Info,
  MapPin,
  Navigation,
  Phone,
  SkipForward,
  Thermometer,
  XCircle,
} from 'lucide-react';
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
import { DropSkipModal } from './DropSkipModal';
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
  /** The stop the driver is heading to now — given visual weight so it is findable at a glance. */
  isNext?: boolean;
  /** Tell the parent this stop was tapped, so the map can focus its pin. */
  onFocus?: () => void;
  /** True when this stop is the one the map is currently centred on. */
  isFocused?: boolean;
  /** Finished stops start folded away. Still expandable: the driver may need to re-read what was signed for. */
  defaultCollapsed?: boolean;
}

export function DropCard({
  sj,
  drop,
  onChanged,
  isNext = false,
  onFocus,
  isFocused = false,
  defaultCollapsed = false,
}: DropCardProps) {
  const { t } = useI18n();
  const [modal, setModal] = useState<'depart' | 'arrive' | 'receive' | 'skip' | 'fail' | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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
    <Card
      className={cn(
        action === 'none' && 'opacity-90',
        isNext && 'border-brand-500 ring-1 ring-brand-500',
        isFocused && !isNext && 'border-brand-300 ring-1 ring-brand-300',
      )}
    >
      <CardContent className="flex flex-col gap-3">
        {/* The whole heading is the hit target. Owner asked for the stop list to
            drive the map — a driver reading "Drop 4 — Balikpapan Timur" wants to
            see WHERE that is, and hunting for the matching numbered pin by eye
            is the thing the list is supposed to save them.

            A real <button> rather than an onClick div: this has to be reachable
            by keyboard for the dispatcher and owner, who use this screen on a
            desktop. `text-left` undoes the centring a button brings with it. */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button
            type="button"
            onClick={onFocus}
            className="flex items-start gap-2 text-left"
            aria-label={t('driver.map.focusStop', { location: drop.locationName })}
          >
            <MapPin className="mt-0.5 size-5 flex-none text-text-muted" aria-hidden />
            <div>
              {isNext && (
                <p className="text-xs font-bold uppercase tracking-wide text-brand-600">
                  {t('driver.progress.nextStop')}
                </p>
              )}
              <p className="text-lg font-semibold text-text-primary">
                {t('driver.dropSeq', { seq: drop.dropSeq })} — {drop.locationName}
              </p>
              <p className="text-sm text-text-muted">{drop.city}</p>
              {!collapsed && drop.address && (
                <p className="mt-1 text-sm text-text-secondary">{drop.address}</p>
              )}
              {!collapsed && coords && (
                <p className="mt-0.5 font-mono text-xs text-text-muted">{coords}</p>
              )}
            </div>
          </button>
          <div className="flex flex-col items-end gap-1.5">
            <StatusBadge domain="drop" status={drop.status} />
            {/* Always offered, not only on the stops that start collapsed.
                Owner: "able to click all to see more detail, not just the
                current active one." A driver checking what they dropped at the
                first outlet an hour ago should not have to remember that only
                completed stops can be reopened. */}
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="text-xs font-medium text-text-secondary underline underline-offset-2"
            >
              {collapsed ? t('common.showDetail') : t('common.hideDetail')}
            </button>
          </div>
        </div>

        {/* Everything below is detail: folded away for a finished stop until
            asked for, always shown for a stop still in play. */}
        {!collapsed && (
          <>
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

            {/* Calling ahead is the other thing a driver does constantly, and it
            should never mean digging the number out of a chat. Rendered only
            while the stop is still open, for the same reason navigation is:
            ringing an outlet about a delivery already completed is noise.
            `tel:` is a plain anchor so the phone's dialler handles it. */}
            {drop.phone && action !== 'none' && (
              <a
                href={`tel:${drop.phone.replace(/\s+/g, '')}`}
                className="inline-flex h-touch-lg items-center justify-center gap-2.5 rounded-md border border-border-strong bg-surface-raised px-6 text-lg font-semibold text-text-primary hover:bg-stone-50"
              >
                <Phone className="size-4" aria-hidden />
                {t('driver.nav.call')}
              </a>
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
                {/* Skip sits BEFORE fail, and looks less severe than it, because
                    it is the one a driver reaches for most and the one they
                    should reach for first. When the only non-delivery button
                    was "Gagal Kirim", every temporary obstacle got recorded as
                    a permanent failure — and failing a drop sends its stock
                    back to the warehouse on paper while it is still on the
                    van. */}
                <Button
                  size="touch-lg"
                  variant="outline"
                  className="sm:w-auto"
                  leftIcon={<SkipForward className="size-4" />}
                  onClick={() => setModal('skip')}
                >
                  {t('driver.actions.skip')}
                </Button>
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
          </>
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
      {modal === 'skip' && (
        <DropSkipModal open drop={drop} onClose={() => setModal(null)} onDone={handleDone} />
      )}
      {modal === 'fail' && (
        <DropFailModal open drop={drop} onClose={() => setModal(null)} onDone={handleDone} />
      )}
    </Card>
  );
}
