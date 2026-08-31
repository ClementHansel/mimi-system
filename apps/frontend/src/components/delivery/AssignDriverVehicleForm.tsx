'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, Select, toast } from '@/components/ui';
import type { SuratJalan } from '@/lib/shared-types';
import type { Driver, Vehicle } from './lib/types';
import { patchSuratJalan } from './lib/delivery-api';
import { errMsg } from '@/lib/api-error';

/**
 * Dispatch screen (`/delivery/assign`) driver + truck picker.
 *
 * Both selects go through the SAME `PATCH /delivery/surat-jalan/:id`
 * endpoint `SuratJalanDetailDrawer`'s edit form already uses (no new
 * endpoint invented) — the one substantive backend change for this ticket
 * was making sure `SuratJalanService.update()` re-runs the one-truck-
 * type-per-driver-per-day check (`assertNoTruckTypeClash`) whenever the
 * driver or planned date actually changes, exactly like `create()` already
 * did. Before that fix, reassigning a driver here was the one way to get a
 * driver holding a frozen route AND a dry route on the same day. The
 * rejection message that check throws is rendered verbatim below, not
 * replaced with a generic "failed to save" — a dispatcher needs to know
 * WHICH other Surat Jalan is blocking the change.
 */
export function AssignDriverVehicleForm({
  sj,
  drivers,
  vehicles,
  onSaved,
}: {
  sj: SuratJalan;
  drivers: Driver[];
  vehicles: Vehicle[];
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [driverId, setDriverId] = useState(sj.driver.id);
  const [vehicleId, setVehicleId] = useState(sj.vehicle.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever a different SJ is selected, or the server's own copy
  // changes after a save elsewhere on the page.
  useEffect(() => {
    setDriverId(sj.driver.id);
    setVehicleId(sj.vehicle.id);
    setError(null);
  }, [sj.id, sj.driver.id, sj.vehicle.id]);

  const editable = sj.status === 'draft' || sj.status === 'ready';
  const dirty = driverId !== sj.driver.id || vehicleId !== sj.vehicle.id;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await patchSuratJalan(sj.id, { driverId, vehicleId });
      toast({ title: t('deliveryAssign.form.saved'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(errMsg(err, t('deliveryAssign.form.saveError')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium text-text-primary">{t('deliveryAssign.form.title')}</h3>
        <p className="text-xs text-text-muted">{t('deliveryAssign.form.subtitle')}</p>
      </div>

      {!editable && <p className="text-xs text-warning-700">{t('deliveryAssign.form.locked')}</p>}
      {error && <p className="text-sm text-danger-600">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <Select
          label={t('deliveryAssign.form.driver')}
          value={driverId}
          onValueChange={setDriverId}
          disabled={!editable}
          options={drivers.map((d) => ({ value: d.id, label: d.name }))}
          wrapperClassName="w-56"
        />
        <Select
          label={t('deliveryAssign.form.vehicle')}
          value={vehicleId}
          onValueChange={setVehicleId}
          disabled={!editable}
          options={vehicles.map((v) => ({
            value: v.id,
            label: v.hasFreezer
              ? t('deliveryAssign.form.vehicleFreezer', { plate: v.plateNumber })
              : v.plateNumber,
          }))}
          wrapperClassName="w-56"
        />
        <Button
          size="sm"
          className="self-end"
          onClick={save}
          loading={saving}
          disabled={!editable || !dirty}
          leftIcon={<Save className="size-4" />}
        >
          {t('deliveryAssign.form.save')}
        </Button>
      </div>
    </section>
  );
}
