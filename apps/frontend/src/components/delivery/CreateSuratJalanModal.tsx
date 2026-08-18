'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { Modal, Card, CardContent, toast } from '@/components/ui';
import { SjCreateForm, type CreateSjPayload } from '@/components/warehouse/SjCreateForm';
import type { Replenishment, Driver, Vehicle } from './lib/types';
import {
  createSuratJalan,
  getDrivers,
  getVehicles,
  listApprovedRequests,
} from './lib/delivery-api';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listApprovedRequests()
      .then((res) => setRequests(res.rows))
      .catch(() => {});
    getDrivers()
      .then(setDrivers)
      .catch(() => {});
    getVehicles()
      .then(setVehicles)
      .catch(() => {});
  }, []);

  async function handleSubmit(payload: CreateSjPayload) {
    setSubmitting(true);
    setError(null);
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
      setError(errMsg(err, t('table.error')));
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
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <SjCreateForm
          requests={requests}
          drivers={drivers}
          vehicles={vehicles}
          submitting={submitting}
          onSubmit={handleSubmit}
        />
      </div>
    </Modal>
  );
}
