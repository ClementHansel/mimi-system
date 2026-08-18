'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, MapPin, MapPinOff, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { Button, Textarea, toast } from '@/components/ui';
import type { Drop } from '@/lib/shared-types';
import { planRoute, setDropInstructions } from './lib/delivery-api';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface PlannedStop {
  dropId: string;
  locationName: string;
  city: string;
  address: string | null;
  hasCoords: boolean;
  deliveryInstructions: string;
  /** The brief as the server last returned it, so a save can send only the
   * stops that actually changed once reordering is locked. */
  originalInstructions: string;
  /** Finished stops accept no further brief — the backend rejects it, and
   * rewriting the note on a delivery that already happened is editing history. */
  isTerminal: boolean;
}

const TERMINAL_DROP_STATUSES = new Set(['completed', 'completed_discrepancy', 'failed']);

/**
 * The gudang side of "set the directions": order the stops, and write the brief
 * the driver reads at each one.
 *
 * ORDER IS EXPLICIT, NOT OPTIMISED. There is deliberately no "shortest route"
 * button. A truck is loaded back-to-front — the last drop goes in first — so
 * the sequence is a physical property of how the vehicle was packed, not a
 * routing puzzle. Letting an optimiser reshuffle it would mean unloading half
 * the truck at every stop. Dispatch sets the order; the driver's map app
 * navigates one leg at a time (see `driver/lib/navigation.ts`).
 *
 * Move-up/move-down buttons rather than drag-and-drop: this list is short (a
 * route is a handful of stops), the control is keyboard-accessible and
 * touch-safe for free, and it avoids a drag library for a screen that would
 * gain nothing from one.
 */
export function RoutePlanner({
  sjId,
  drops,
  editable,
  onSaved,
}: {
  sjId: string;
  drops: Drop[];
  /** False once the SJ has left draft/ready — the backend refuses a reorder
   * then, because the truck is loaded to the sequence already agreed. */
  editable: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [stops, setStops] = useState<PlannedStop[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Re-seed whenever the server's view changes. `drops` arrives in `dropSeq`
  // order from the API, but sorting here too keeps this component correct even
  // if a caller hands it an unsorted array.
  useEffect(() => {
    setStops(
      [...drops]
        .sort((a, b) => a.dropSeq - b.dropSeq)
        .map((d) => ({
          dropId: d.id,
          locationName: d.locationName,
          city: d.city,
          address: d.address,
          hasCoords: typeof d.latitude === 'number' && typeof d.longitude === 'number',
          deliveryInstructions: d.deliveryInstructions ?? '',
          originalInstructions: d.deliveryInstructions ?? '',
          isTerminal: TERMINAL_DROP_STATUSES.has(d.status),
        })),
    );
    setDirty(false);
  }, [drops]);

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= stops.length) return;
    const next = [...stops];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setStops(next);
    setDirty(true);
  }

  function setInstruction(dropId: string, value: string) {
    setStops((prev) =>
      prev.map((s) => (s.dropId === dropId ? { ...s, deliveryInstructions: value } : s)),
    );
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      if (editable) {
        // Instructions are always sent, including empty strings — within this
        // form an empty box means "no brief", and omitting it would make the
        // backend's COALESCE silently restore a note the dispatcher just deleted.
        await planRoute(
          sjId,
          stops.map((s) => ({ dropId: s.dropId, deliveryInstructions: s.deliveryInstructions })),
        );
      } else {
        // Route is locked, but the BRIEFS are not: a dispatcher who learns
        // mid-route that a gate is blocked must still be able to tell the
        // driver, and that changes no loading assumption. Only the stops that
        // actually changed are sent, one per request — `PUT :id/route` would be
        // rejected outright for a locked SJ, and re-sending untouched stops
        // would pointlessly rewrite briefs the dispatcher never opened.
        const changed = stops.filter(
          (s) => !s.isTerminal && s.deliveryInstructions !== s.originalInstructions,
        );
        for (const s of changed) {
          await setDropInstructions(
            s.dropId,
            s.deliveryInstructions === '' ? null : s.deliveryInstructions,
          );
        }
      }
      toast({ title: t('delivery.route.saved'), variant: 'success' });
      setDirty(false);
      onSaved();
    } catch (err) {
      toast({ title: errMsg(err, t('delivery.route.saveError')), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  if (stops.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium text-text-primary">{t('delivery.route.title')}</h3>
          <p className="text-xs text-text-muted">{t('delivery.route.subtitle')}</p>
        </div>
        {/* Shown even when the order is locked — the briefs remain editable,
            which is exactly what the locked-state hint below promises. */}
        <Button
          size="sm"
          onClick={save}
          loading={saving}
          disabled={!dirty}
          leftIcon={<Save className="size-4" />}
        >
          {editable ? t('delivery.route.save') : t('delivery.route.saveInstructions')}
        </Button>
      </div>

      {!editable && <p className="text-xs text-warning-700">{t('delivery.route.locked')}</p>}

      <ol className="flex flex-col gap-2">
        {stops.map((stop, index) => (
          <li key={stop.dropId} className="rounded-lg border border-border bg-surface-raised p-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text-primary">{stop.locationName}</p>
                <p className="text-xs text-text-muted">{stop.city}</p>
                {stop.address && (
                  <p className="mt-0.5 text-sm text-text-secondary">{stop.address}</p>
                )}
                {/*
                  A stop with no coordinates still delivers fine — the driver
                  gets the address as text — but its Navigate button falls back
                  to an address search and it cannot be plotted on the live map.
                  Worth saying here, where someone can go and fix the location.
                */}
                {!stop.hasCoords && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-warning-700">
                    <MapPinOff className="size-3.5" aria-hidden />
                    {t('delivery.route.noCoords')}
                  </p>
                )}
                {stop.hasCoords && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-success-700">
                    <MapPin className="size-3.5" aria-hidden />
                    {t('delivery.route.hasCoords')}
                  </p>
                )}

                <div className="mt-2">
                  <label
                    className="text-xs font-medium text-text-secondary"
                    htmlFor={`instr-${stop.dropId}`}
                  >
                    {t('delivery.route.instructionsLabel')}
                  </label>
                  <Textarea
                    id={`instr-${stop.dropId}`}
                    rows={2}
                    maxLength={1000}
                    disabled={stop.isTerminal}
                    placeholder={t('delivery.route.instructionsPlaceholder')}
                    value={stop.deliveryInstructions}
                    onChange={(e) => setInstruction(stop.dropId, e.target.value)}
                  />
                </div>
              </div>

              {editable && (
                <div className="flex flex-none flex-col gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('delivery.route.moveUp')}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('delivery.route.moveDown')}
                    disabled={index === stops.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-4" aria-hidden />
                  </Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
