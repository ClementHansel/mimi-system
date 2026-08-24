'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { Button, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Drop } from '@/lib/shared-types';
import { planRoute } from './lib/delivery-api';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface Stop {
  dropId: string;
  locationName: string;
  city: string;
}

/**
 * Dedicated dispatch screen (`/delivery/assign`) reorder widget for one
 * Surat Jalan's drops.
 *
 * TWO input methods, not one: native HTML5 drag-and-drop for the mouse, AND
 * up/down buttons that work with a keyboard or a finger. `RoutePlanner.tsx`
 * (the existing per-SJ drawer widget) already ships the button-only version
 * — this component adds drag on top rather than replacing that one, because
 * this screen's ticket explicitly calls out that gudang staff on a desktop
 * would otherwise be stuck with drag-only, which is not acceptable as the
 * sole input method. No `@dnd-kit` (or any drag library) — checked
 * `apps/frontend/package.json` first and none is a dependency, so this uses
 * the plain `draggable`/`onDragStart`/`onDragOver`/`onDrop` browser API
 * instead of adding one for a list this short.
 *
 * Deliberately sends dropId-only stops to `PUT :id/route` (no
 * `deliveryInstructions` field at all) — that field is OPTIONAL per stop and
 * the backend COALESCEs a missing value, so a pure reorder from this screen
 * can never blank out a delivery brief a dispatcher wrote earlier from the
 * SJ detail drawer.
 */
export function DropOrderEditor({
  sjId,
  drops,
  editable,
  onSaved,
}: {
  sjId: string;
  drops: Drop[];
  /** False once the SJ has left draft/ready — the backend rejects a reorder
   * then ("Urutan rute terkunci — Surat Jalan sudah dimuat atau dalam
   * perjalanan"), because the truck is already loaded to this sequence. */
  editable: boolean;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [stops, setStops] = useState<Stop[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Re-seed from the server's `dropSeq` order whenever the SJ reloads (a
  // fresh selection, or right after a save round-trip).
  useEffect(() => {
    setStops(
      [...drops]
        .sort((a, b) => a.dropSeq - b.dropSeq)
        .map((d) => ({ dropId: d.id, locationName: d.locationName, city: d.city })),
    );
    setDirty(false);
    setError(null);
  }, [drops]);

  function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= stops.length || to >= stops.length) return;
    const next = [...stops];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setStops(next);
    setDirty(true);
  }

  function move(index: number, delta: number) {
    reorder(index, index + delta);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await planRoute(
        sjId,
        stops.map((s) => ({ dropId: s.dropId })),
      );
      toast({ title: t('deliveryAssign.order.saved'), variant: 'success' });
      setDirty(false);
      onSaved();
    } catch (err) {
      // Shown plainly, not just toasted — this is exactly where the
      // one-truck-type/locked-route rejections need to be legible, not a
      // generic failure. Kept inline so it survives the toast's auto-dismiss.
      setError(errMsg(err, t('deliveryAssign.order.saveError')));
    } finally {
      setSaving(false);
    }
  }

  if (stops.length === 0) {
    return <p className="text-sm text-text-muted">{t('deliveryAssign.order.empty')}</p>;
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium text-text-primary">{t('deliveryAssign.order.title')}</h3>
          <p className="text-xs text-text-muted">{t('deliveryAssign.order.subtitle')}</p>
        </div>
        <Button
          size="sm"
          onClick={save}
          loading={saving}
          disabled={!editable || !dirty}
          leftIcon={<Save className="size-4" />}
        >
          {t('deliveryAssign.order.save')}
        </Button>
      </div>

      {!editable && <p className="text-xs text-warning-700">{t('deliveryAssign.order.locked')}</p>}
      {error && <p className="text-sm text-danger-600">{error}</p>}

      <ol className="flex flex-col gap-2" aria-label={t('deliveryAssign.order.title')}>
        {stops.map((stop, index) => (
          <li
            key={stop.dropId}
            draggable={editable}
            onDragStart={(e) => {
              dragIndex.current = index;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!editable) return;
              e.preventDefault();
              setDragOverIndex(index);
            }}
            onDragLeave={() => setDragOverIndex((prev) => (prev === index ? null : prev))}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverIndex(null);
              if (dragIndex.current === null) return;
              reorder(dragIndex.current, index);
              dragIndex.current = null;
            }}
            onDragEnd={() => {
              dragIndex.current = null;
              setDragOverIndex(null);
            }}
            className={cn(
              'flex items-center gap-3 rounded-lg border border-border bg-surface-raised p-3',
              editable && 'cursor-grab active:cursor-grabbing',
              dragOverIndex === index && 'border-brand-500 bg-brand-50/40',
            )}
          >
            {editable && <GripVertical className="size-4 flex-none text-text-muted" aria-hidden />}
            <span className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text-primary">{stop.locationName}</p>
              <p className="text-xs text-text-muted">{stop.city}</p>
            </div>
            {editable && (
              <div className="flex flex-none flex-col gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('deliveryAssign.order.moveUp')}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('deliveryAssign.order.moveDown')}
                  disabled={index === stops.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
