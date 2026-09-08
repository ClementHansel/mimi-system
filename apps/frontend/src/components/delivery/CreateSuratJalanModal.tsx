'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Modal, Card, CardContent, EmptyState, Button, toast } from '@/components/ui';
import { SjCreateForm, type CreateSjPayload } from '@/components/warehouse/SjCreateForm';
import type { Replenishment, Driver, Vehicle } from './lib/types';
import {
  createSuratJalan,
  getDrivers,
  getVehicles,
  listApprovedRequests,
} from './lib/delivery-api';
import { errMsg } from '@/lib/api-error';

/**
 * The dispatcher's Surat Jalan builder. Deliberately REUSES
 * `components/warehouse/SjCreateForm.tsx` rather than reimplementing the
 * FR-LOG-02 truck-split picker a third time — that form already makes
 * mixing frozen/dry goods structurally impossible to build (filters
 * incompatible request lines per chosen `shipmentType`, blocks a
 * non-freezer vehicle for a `frozen` SJ) with its own doc comment tracing
 * that rule back to the owner's 2026-08-17 ruling. Only the surrounding
 * data-fetch/submit plumbing is new here (`components/delivery/lib`,
 * distinct wire client per this surface's ownership).
 *
 * `Replenishment`/`Driver`/`Vehicle` (`./lib/types`) are re-exports of
 * `components/warehouse/lib/types`'s identical CONTRACTS §4.9/§4.10 shapes —
 * `SjCreateForm`'s own props are typed against those exact interfaces, so
 * this call site stays checked against the form's real contract rather than
 * an assumed-compatible duplicate.
 *
 * ── THE LOAD STATE IS PART OF THE FEATURE ──────────────────────────────────
 *
 * All three fetches used to end in `.catch(() => {})`. So whenever the
 * approved-request call failed — an expired token, a 403, a 500, a dropped
 * connection — this modal opened with `requests` still `[]`, `SjCreateForm`
 * printed "Belum ada permintaan yang disetujui dan siap dikirim", and that was
 * the whole story the dispatcher got: a screen calmly reporting that the
 * request they had just approved does not exist. Nothing distinguished "the
 * queue is genuinely empty" from "we never managed to ask", not even in the
 * console, and there was no way to retry short of closing and reopening.
 *
 * So: `loading` renders as loading, a failure renders as a failure WITH a
 * retry, and only a completed fetch is allowed to say the queue is empty.
 *
 * The failure is split by what it costs. A failed REQUEST QUEUE replaces the
 * form outright — there is nothing to build a Surat Jalan out of, and
 * `SjCreateForm` would otherwise print «Belum ada permintaan yang disetujui»
 * underneath the error message, which is the original lie restated one line
 * lower. A failed driver or vehicle list only gets a banner: the picker is real
 * and worth showing, the truck selects are just empty until the retry.
 *
 * `loadError` is kept separate from `submitError` on purpose — a rejected
 * create must not overwrite the reason the picker is short, and vice versa.
 */
export function CreateSuratJalanModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [requests, setRequests] = useState<Replenishment[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestsFailed, setRequestsFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setRequestsFailed(false);
    // Settled, not `all`: drivers loading while the request queue 500s is worth
    // showing — the dispatcher sees the truck pickers populate and one honest
    // message about what is missing, instead of three empty selects.
    Promise.allSettled([listApprovedRequests(), getDrivers(), getVehicles()])
      .then(([requestsResult, driversResult, vehiclesResult]) => {
        if (cancelled) return;
        if (requestsResult.status === 'fulfilled') setRequests(requestsResult.value.rows);
        else setRequestsFailed(true);
        if (driversResult.status === 'fulfilled') setDrivers(driversResult.value);
        if (vehiclesResult.status === 'fulfilled') setVehicles(vehiclesResult.value);

        const firstFailure = [requestsResult, driversResult, vehiclesResult].find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        if (firstFailure) setLoadError(errMsg(firstFailure.reason, t('delivery.createLoadFailed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadToken]);

  const retry = useCallback(() => setReloadToken((n) => n + 1), []);

  async function handleSubmit(payload: CreateSjPayload) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createSuratJalan({
        shipmentType: payload.shipmentType,
        driverId: payload.driverId,
        vehicleId: payload.vehicleId,
        plannedDate: payload.plannedDate,
        notes: payload.notes,
        drops: payload.drops.map((d) => ({
          locationId: d.locationId,
          replenishmentRequestId: d.replenishmentRequestId,
          lines: d.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitId: l.unitId })),
        })),
      });
      toast({ title: t('delivery.createdSuccess'), variant: 'success' });
      onCreated();
    } catch (err) {
      setSubmitError(errMsg(err, t('table.error')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('delivery.new')} size="xl">
      <div className="flex flex-col gap-4">
        <Card className="border-info-600/30 bg-info-50/40">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-info-700">
            <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
            <span>{t('delivery.truckSplitNotice')}</span>
          </CardContent>
        </Card>

        {loadError && (
          <EmptyState
            size={requestsFailed ? 'lg' : 'sm'}
            title={loadError}
            action={
              <Button variant="outline" size="sm" onClick={retry} disabled={loading}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {submitError && <p className="text-sm text-danger-600">{submitError}</p>}

        {/* The form owns the "no approved requests" line, so it may only render
            once the queue has actually been read — an in-flight or failed load
            must not reach the screen as an empty warehouse queue. */}
        {loading ? (
          <EmptyState size="lg" title={t('delivery.createLoading')} />
        ) : requestsFailed ? null : (
          <SjCreateForm
            requests={requests}
            drivers={drivers}
            vehicles={vehicles}
            submitting={submitting}
            onSubmit={handleSubmit}
          />
        )}
      </div>
    </Modal>
  );
}
