'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2, Truck, Ban, AlertTriangle, Thermometer } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import type { Drop, TempLog, Temp, SuratJalan } from '@/lib/shared-types';
import {
  Drawer, Modal, Button, StatusBadge, Badge, Input, Textarea, TempInput, EmptyState, PermissionGate, toast,
} from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import { formatQty, formatTemp } from '@/lib/formatters';
import { getSuratJalan, readySuratJalan, loadSuratJalan, dispatchSuratJalan, cancelSuratJalan } from './lib/delivery-api';
import { TruckTypeBadge } from './TruckTypeLegend';
import { routeCompletion, isDropTerminal } from './lib/drop-progress';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const CANCELLABLE_STATUSES = new Set(['draft', 'ready', 'loading']);

/**
 * F-DELIVERY detail view — one Surat Jalan's full timeline: drops in
 * sequence with live status + departed/arrived/received timestamps, line
 * items (sent vs. received qty, discrepancy reason), the seal set, and every
 * cold-chain temperature log (including which goods CLASS a breach hit,
 * `TempLog.breachedClasses` — available here because this surface reads the
 * `@mimi/shared` interface directly rather than the two pre-existing local
 * hand-rolled `TempLog` copies that drop that field). Status-walk actions
 * (`ready`/`load`/`dispatch`/`cancel`) are gated per CONTRACTS §4.10's
 * `delivery.sj.create`/`delivery.sj.dispatch`/`delivery.sj.cancel` — the
 * dispatcher builds and moves the SJ forward; per-drop
 * depart/arrive/receive stay driver/outlet-only actions this screen only
 * ever displays, never executes (D-14, `delivery.drop.execute`/`.receive`
 * are not in this surface's own permission set).
 */
export function SuratJalanDetailDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const [sj, setSj] = useState<SuratJalan | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const [loadOpen, setLoadOpen] = useState(false);
  const [seals, setSeals] = useState<string[]>(['']);
  const [loadTemp, setLoadTemp] = useState<Temp | null>(null);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  function load() {
    setLoading(true);
    setLoadError(null);
    getSuratJalan(id)
      .then(setSj)
      .catch((err: unknown) => setLoadError(errMsg(err, t('delivery.detail.loadError'))))
      .finally(() => setLoading(false));
  }
  useEffect(load, [id]);

  async function run(fn: () => Promise<SuratJalan>, successKey?: string) {
    setActing(true);
    try {
      const updated = await fn();
      setSj(updated);
      onChanged();
      if (successKey) toast({ title: t(successKey), variant: 'success' });
    } catch (err) {
      toast({ title: errMsg(err, t('table.error')), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  function openLoad() {
    setSeals(['']);
    setLoadTemp(null);
    setLoadOpen(true);
  }

  async function submitLoad() {
    const sealNumbers = seals.map((s) => s.trim()).filter(Boolean);
    if (sealNumbers.length === 0) {
      toast({ title: t('warehouse.sj.sealRequired'), variant: 'warning' });
      return;
    }
    if (sj?.shipmentType === 'frozen' && !loadTemp) {
      toast({ title: t('warehouse.sj.tempRequired'), variant: 'warning' });
      return;
    }
    await run(() => loadSuratJalan(id, { seals: sealNumbers.map((sealNumber) => ({ sealNumber })), tempC: loadTemp ?? undefined }), 'warehouse.sj.loaded');
    setLoadOpen(false);
  }

  async function submitCancel() {
    if (cancelReason.trim() === '') return;
    await run(() => cancelSuratJalan(id, { reason: cancelReason.trim() }), 'warehouse.sj.cancelled');
    setCancelOpen(false);
  }

  const completion = sj ? routeCompletion(sj.drops) : { done: 0, total: 0 };

  return (
    <Drawer open onClose={onClose} title={sj?.sjNumber ?? t('delivery.detail.title')} size="lg">
      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : loadError || !sj ? (
        <EmptyState title={loadError ?? t('delivery.detail.notFound')} size="sm" />
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge domain="suratJalan" status={sj.status} size="md" />
              <TruckTypeBadge shipmentType={sj.shipmentType} />
              <Badge variant={completion.done === completion.total && completion.total > 0 ? 'success' : 'neutral'} size="sm">
                {t('delivery.detail.dropOf', { done: completion.done, total: completion.total })}
              </Badge>
            </div>
            <p className="text-sm text-text-muted">
              {sj.vehicle.plateNumber} — {sj.driver.name} · {t('delivery.columnPlannedDate')}: {sj.plannedDate}
            </p>
          </section>

          <section className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-text-primary">{t('delivery.detail.drops')}</h3>
            {sj.drops.map((drop) => (
              <DropCard key={drop.id} drop={drop} tempLogs={sj.tempLogs.filter((l) => l.dropId === drop.id)} />
            ))}
          </section>

          {sj.seals.length > 0 && (
            <section className="border-t border-border pt-4 text-sm">
              <span className="font-medium text-text-primary">{t('delivery.detail.seals')}: </span>
              {sj.seals.map((s) => s.sealNumber).join(', ')}
            </section>
          )}

          {sj.tempLogs.filter((l) => l.dropId === null).length > 0 && (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                <Thermometer className="size-4" aria-hidden />{t('delivery.detail.coldChain')} — {t('warehouse.sj.stage.load')}
              </h3>
              {sj.tempLogs.filter((l) => l.dropId === null).map((log) => <TempLogRow key={log.id} log={log} />)}
            </section>
          )}

          <section className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <PermissionGate permission="delivery.sj.cancel">
              {CANCELLABLE_STATUSES.has(sj.status) && (
                <Button variant="danger" size="sm" leftIcon={<Ban className="size-4" />} onClick={() => { setCancelReason(''); setCancelOpen(true); }}>
                  {t('warehouse.sj.cancel')}
                </Button>
              )}
            </PermissionGate>
            <PermissionGate permission="delivery.sj.create">
              {sj.status === 'draft' && (
                <Button variant="outline" size="sm" loading={acting} onClick={() => run(() => readySuratJalan(id), undefined)}>
                  {t('warehouse.sj.markReady')}
                </Button>
              )}
            </PermissionGate>
            <PermissionGate permission="delivery.sj.dispatch">
              {sj.status === 'ready' && (
                <Button size="sm" leftIcon={<Truck className="size-4" />} onClick={openLoad}>{t('warehouse.sj.load')}</Button>
              )}
              {sj.status === 'loading' && (
                <Button size="sm" leftIcon={<Truck className="size-4" />} loading={acting} onClick={() => run(() => dispatchSuratJalan(id), 'warehouse.sj.dispatched')}>
                  {t('warehouse.sj.dispatch')}
                </Button>
              )}
            </PermissionGate>
          </section>
        </div>
      )}

      <Modal open={loadOpen} onClose={() => setLoadOpen(false)} title={t('warehouse.sj.load')} size="md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">{t('warehouse.sj.seals')}</span>
            {seals.map((s, idx) => (
              <div key={idx} className="flex gap-2">
                <Input
                  value={s}
                  onChange={(e) => setSeals((prev) => prev.map((v, i) => (i === idx ? e.target.value : v)))}
                  placeholder={t('warehouse.sj.sealNumber')}
                  wrapperClassName="flex-1"
                />
                {seals.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSeals((prev) => prev.filter((_, i) => i !== idx))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setSeals((prev) => [...prev, ''])}>
              {t('warehouse.sj.addSeal')}
            </Button>
          </div>
          {sj?.shipmentType === 'frozen' && <TempInput label={t('warehouse.sj.loadTemp')} required value={loadTemp} onChange={setLoadTemp} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setLoadOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={acting} onClick={submitLoad}>{t('common.submit')}</Button>
        </div>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('warehouse.sj.cancel')} size="md">
        <Textarea
          label={t('warehouse.sj.cancelReason')}
          required
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          error={cancelReason.trim() === '' ? t('validation.reasonRequired') : undefined}
          disabled={acting}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={acting} disabled={cancelReason.trim() === ''} onClick={submitCancel}>{t('warehouse.sj.confirmCancel')}</Button>
        </div>
      </Modal>
    </Drawer>
  );
}

function DropCard({ drop, tempLogs }: { drop: Drop; tempLogs: TempLog[] }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-text-primary">{t('delivery.detail.dropSeq', { seq: drop.dropSeq, location: drop.locationName })}</p>
        <StatusBadge domain="drop" status={drop.status} size="sm" />
      </div>

      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>{t('delivery.detail.dropDeparted')}: {drop.departedAt ? fmtDateTime(drop.departedAt) : '—'}</span>
        <span>{t('delivery.detail.dropArrived')}: {drop.arrivedAt ? fmtDateTime(drop.arrivedAt) : '—'}</span>
        <span>{t('delivery.detail.dropReceived')}: {drop.receivedBy ? `${drop.receivedBy} (${fmtDateTime(drop.receivedAt)})` : '—'}</span>
      </div>

      {drop.status === 'completed_discrepancy' && (
        <div className="mb-2 flex items-center gap-1.5 rounded bg-warning-50 px-2 py-1 text-xs text-warning-700">
          <AlertTriangle className="size-3.5" aria-hidden />
          {t('delivery.detail.dropDiscrepancy')}{drop.discrepancyNotes ? `: ${drop.discrepancyNotes}` : ''}
        </div>
      )}

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted">
            <th className="pb-1 font-normal">{t('delivery.detail.lineItem')}</th>
            <th className="pb-1 text-right font-normal">{t('delivery.detail.lineQty')}</th>
            {isDropTerminal(drop.status) && <th className="pb-1 text-right font-normal">{t('delivery.detail.lineQtyReceived')}</th>}
          </tr>
        </thead>
        <tbody>
          {drop.lines.map((l) => (
            <tr key={l.id} className="border-t border-border">
              <td className="py-1.5 text-text-primary">{l.itemName}</td>
              <td className="py-1.5 text-right tabular-nums">{formatQty(l.qty, l.unitCode)}</td>
              {isDropTerminal(drop.status) && (
                <td className={`py-1.5 text-right tabular-nums ${l.discrepancyReason ? 'text-warning-700' : ''}`}>
                  {l.qtyReceived !== null ? formatQty(l.qtyReceived, l.unitCode) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {tempLogs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
          <span className="flex items-center gap-1 text-xs font-medium text-text-secondary">
            <Thermometer className="size-3.5" aria-hidden />{t('delivery.detail.coldChain')}
          </span>
          {tempLogs.map((log) => <TempLogRow key={log.id} log={log} />)}
        </div>
      )}
    </div>
  );
}

function TempLogRow({ log }: { log: TempLog }) {
  const { t } = useI18n();
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${log.isBreach ? 'text-danger-600' : 'text-text-secondary'}`}>
      <span className="font-medium">{t(`warehouse.sj.stage.${log.stage}`)}</span>
      <span className="tabular-nums">{formatTemp(log.tempC)}</span>
      {log.isBreach && (
        <Badge variant="danger" size="sm">
          <AlertTriangle className="size-3 flex-none" aria-hidden />
          {t('delivery.detail.coldChainBreach', { class: (log.breachedClasses ?? []).join(', ') || '—' })}
        </Badge>
      )}
      <span className="text-text-muted">{fmtDateTime(log.loggedAt)}</span>
    </div>
  );
}
