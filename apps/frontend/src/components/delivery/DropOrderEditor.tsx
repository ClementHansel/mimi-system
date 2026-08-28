'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { Button, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ExportButton } from '@/components/common/ExportButton';
import { LineImportButton } from '@/components/common/LineImportButton';
import type { CsvColumn } from '@/lib/export/csv';
import type { CsvRecord } from '@/lib/import/csv-parse';
import { buildNameIndex, resolveNamed } from '@/lib/import/resolve';
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

/** One row of an imported ordering: an existing stop, and where it should go. */
interface SeqImportRow {
  dropId: string;
  seq: number;
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

  /**
   * BULK ORDERING, for the route that is too long to click into shape.
   *
   * Up/down buttons and drag are fine for five stops and miserable for
   * twenty-five — which is what a dry-goods run around Denpasar looks like, and
   * it is usually already sequenced in the spreadsheet the loading plan was
   * built in. So: export the stops, put the visit order in the `Urutan` column,
   * import it back.
   *
   * IMPORT CANNOT ADD OR REMOVE A STOP, only order the ones already on this
   * Surat Jalan. `PUT :id/route` reorders drops; a drop exists because a
   * replenishment request put it there, and inventing one from a CSV row would
   * mean a truck stopping at an outlet nothing was loaded for. A row naming an
   * unknown outlet is therefore an error, not a new stop.
   *
   * A PARTIAL FILE IS HONOURED rather than rejected: the stops the file names
   * take the order it gives, and any it does not mention keep their current
   * relative order at the end. That makes "just pull these three to the front"
   * a two-line file instead of a full retype, and it is always well defined —
   * unlike rejecting the file, which would leave the operator with no way to
   * express a partial change.
   */
  const stopIndex = useMemo(
    () => buildNameIndex(stops.map((s) => ({ id: s.dropId, name: s.locationName }))),
    [stops],
  );

  const orderImportColumns = [
    { header: t('deliveryAssign.order.seq'), hint: t('deliveryAssign.order.importSeqHint'), required: true },
    {
      header: t('deliveryAssign.order.outlet'),
      hint: t('deliveryAssign.order.importOutletHint'),
      required: true,
    },
  ];

  function mapOrderRow(
    row: CsvRecord,
  ): { ok: true; line: SeqImportRow } | { ok: false; error: string } {
    const outletText = row.get(t('deliveryAssign.order.outlet'));
    if (!outletText) return { ok: false, error: t('lineImport.missingItem') };
    const stop = resolveNamed(stopIndex, outletText);
    if (!stop) return { ok: false, error: t('lineImport.notInDocument') };

    const seqText = row.get(t('deliveryAssign.order.seq'));
    const seq = Number.parseInt(seqText, 10);
    if (!Number.isFinite(seq)) return { ok: false, error: t('deliveryAssign.order.importMissingSeq') };

    return { ok: true, line: { dropId: stop.id, seq } };
  }

  function applyOrder(imported: SeqImportRow[]) {
    setStops((current) => {
      // Sort by the sequence the file gave. A DUPLICATE number is not an error:
      // two stops both marked "3" simply keep their current relative order
      // between themselves, which is what a stable sort gives for free.
      const named = [...imported].sort((a, b) => a.seq - b.seq);
      const seen = new Set<string>();
      const ordered: Stop[] = [];
      for (const row of named) {
        if (seen.has(row.dropId)) continue;
        const stop = current.find((s) => s.dropId === row.dropId);
        if (stop) {
          ordered.push(stop);
          seen.add(row.dropId);
        }
      }
      for (const stop of current) if (!seen.has(stop.dropId)) ordered.push(stop);
      return ordered;
    });
    // Dirty, NOT saved. The reorder still goes through the same "Simpan Urutan"
    // button and the same `PUT :id/route`, so the locked-route and one-truck
    // rejections apply identically to an imported order — and the dispatcher
    // sees the new sequence before committing to it.
    setDirty(true);
    setError(null);
  }

  const exportColumns: CsvColumn<{ seq: number; locationName: string; city: string }>[] = [
    { key: 'seq', header: t('deliveryAssign.order.seq') },
    { key: 'locationName', header: t('deliveryAssign.order.outlet') },
    { key: 'city', header: t('deliveryAssign.order.city') },
  ];
  const exportRows = stops.map((stop, index) => ({
    seq: index + 1,
    locationName: stop.locationName,
    city: stop.city,
  }));

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
        <div className="flex flex-wrap items-center gap-2">
          <ExportButton
            rows={exportRows}
            columns={exportColumns}
            filenameBase="urutan-drop"
            pdfTitle={t('deliveryAssign.order.title')}
          />
          {editable && (
            <LineImportButton<SeqImportRow>
              title={t('deliveryAssign.order.title')}
              templateBase="urutan-drop"
              columns={orderImportColumns}
              mapRow={mapOrderRow}
              note={t('deliveryAssign.order.importNote')}
              onLines={applyOrder}
            />
          )}
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
