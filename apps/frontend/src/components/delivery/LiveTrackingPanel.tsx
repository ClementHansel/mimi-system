'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { MapPin, RefreshCcw, Truck, WifiOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, Card, CardContent, EmptyState, Badge } from '@/components/ui';
import { fmtTime } from '@/lib/dates';
import type { LiveDelivery } from '@/lib/shared-types';
import { getLiveBoard } from './lib/delivery-api';
import { SuratJalanDetailDrawer } from './SuratJalanDetailDrawer';

/**
 * Leaflet reaches for `window` at import time, so the map is loaded client-side
 * only. `ssr: false` here rather than a guard inside the component: the App
 * Router would otherwise fail the server render of this whole route.
 */
const LiveTruckMap = dynamic(() => import('./LiveTruckMap').then((m) => m.LiveTruckMap), {
  ssr: false,
  loading: () => <div className="h-[420px] w-full animate-pulse rounded-lg bg-stone-100" />,
});

/** Poll cadence. Deliberately slower than the drivers' ~60s reporting interval:
 * polling faster than the data changes just burns battery on the dispatcher's
 * laptop and rows in the log for no extra information. */
const POLL_MS = 30_000;

/** A fix older than this is shown as delayed rather than current. Set to twice
 * the drivers' reporting interval, so one missed ping is tolerated and two
 * means something is actually wrong (dead zone, phone asleep, app closed). */
const STALE_AFTER_MS = 150_000;

/**
 * F-DELIVERY live board — where every truck currently in transit is.
 *
 * Deliberately pairs the map with a LIST. The map answers "where", but a
 * dispatcher's real questions are "who is behind" and "who has stopped
 * reporting", and those are read far faster from rows than from pins — a truck
 * with no signal has no pin at all, which is precisely the case you must not
 * let disappear from the screen.
 */
export function LiveTrackingPanel() {
  const { t } = useI18n();
  const [deliveries, setDeliveries] = useState<LiveDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** The row the dispatcher opened. The live board answers "where", and the
   * next question is always "what is on that truck / which drop is it on" —
   * which is the SAME drawer the Surat Jalan list opens, deliberately reused
   * rather than a second, thinner detail view that would drift from it. */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDeliveries(await getLiveBoard());
      setError(false);
    } catch {
      // Keep the last known board on screen instead of blanking it: a stale
      // position is still useful, and a dispatcher's flaky wifi should not
      // erase the fleet view.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-semibold text-text-primary">
            {t('delivery.live.title')}
          </h2>
          <p className="text-sm text-text-muted">{t('delivery.live.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void reload()}
          leftIcon={<RefreshCcw className="size-4" />}
        >
          {t('delivery.live.refresh')}
        </Button>
      </div>

      {error && <p className="text-xs text-warning-700">{t('table.error')}</p>}

      {loading && <EmptyState title={t('table.loading')} size="lg" />}

      {!loading && deliveries.length === 0 && (
        <EmptyState title={t('delivery.live.empty')} icon={Truck} size="lg" />
      )}

      {!loading && deliveries.length > 0 && (
        <>
          <LiveTruckMap deliveries={deliveries} />

          <div className="flex flex-col gap-2">
            {deliveries.map((d) => {
              const pos = d.lastPosition;
              const ageMs = pos ? now - new Date(pos.recordedAt).getTime() : null;
              const stale = ageMs !== null && ageMs > STALE_AFTER_MS;
              return (
                <Card
                  key={d.sjId}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(d.sjId)}
                  // Keyboard parity with the mouse: this is a plain <div>, so
                  // Enter/Space do not activate it for free the way they would
                  // on a real button. A <button> is not an option here — the row
                  // contains its own "open in maps" link, and nesting an anchor
                  // inside a button is invalid HTML that browsers repair by
                  // hoisting the link out of the row.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(d.sjId);
                    }
                  }}
                  className="cursor-pointer transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                >
                  <CardContent className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {d.sjNumber}
                        {d.vehiclePlate && (
                          <span className="text-text-muted"> · {d.vehiclePlate}</span>
                        )}
                      </p>
                      <p className="text-sm text-text-muted">
                        {d.driverName ?? '—'} ·{' '}
                        {t('delivery.live.progress', {
                          done: d.completedDrops,
                          total: d.totalDrops,
                        })}
                      </p>
                      {pos && (
                        <p className="mt-0.5 text-xs text-text-muted">
                          {t('delivery.live.lastSeen', { time: fmtTime(pos.recordedAt) })}
                          {pos.accuracyM !== null &&
                            ` · ${t('delivery.live.accuracy', { m: Math.round(pos.accuracyM) })}`}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-none items-center gap-2">
                      {!pos && (
                        <Badge variant="neutral" size="sm">
                          <WifiOff className="mr-1 inline size-3.5" aria-hidden />
                          {t('delivery.live.noSignal')}
                        </Badge>
                      )}
                      {pos && stale && (
                        <Badge variant="warning" size="sm">
                          {t('delivery.live.stale')}
                        </Badge>
                      )}
                      {pos && (
                        // Straight to the map app rather than an in-page zoom:
                        // the dispatcher's next move is usually to send the
                        // location to someone or check the surrounding roads.
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${pos.latitude},${pos.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          // The whole row now opens the SJ drawer; without this
                          // the map link would ALSO open it behind the new tab.
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1.5 text-sm text-text-primary hover:bg-stone-50"
                        >
                          <MapPin className="size-4" aria-hidden />
                          {t('delivery.live.openInMaps')}
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {selectedId && (
        <SuratJalanDetailDrawer
          id={selectedId}
          onClose={() => setSelectedId(null)}
          // A status walk from inside the drawer (dispatch, cancel) can move a
          // trip on or off this board, so refresh it rather than waiting out
          // the 30s poll with a row that no longer matches reality.
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}
