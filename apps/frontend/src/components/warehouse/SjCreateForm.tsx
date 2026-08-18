'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Snowflake, Package } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  Select,
  Input,
  Checkbox,
  Badge,
  Textarea,
} from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import type { Replenishment, Driver, Vehicle } from './lib/types';

export interface CreateSjPayload {
  shipmentType: 'frozen' | 'dry';
  driverId: string;
  vehicleId: string;
  plannedDate: string;
  notes?: string;
  drops: {
    locationId: string;
    locationName: string;
    replenishmentRequestId?: string;
    lines: { itemId: string; itemName: string; unitCode: string; qty: string; unitId: string }[];
  }[];
}

export interface SjCreateFormProps {
  requests: Replenishment[];
  drivers: Driver[];
  vehicles: Vehicle[];
  submitting?: boolean;
  onSubmit: (payload: CreateSjPayload) => void;
}

/**
 * The multi-drop Surat Jalan builder core (FR-LOG-01/02/03). FR-LOG-02's
 * hard rule — ayam mentah berbumbu (frozen) must never travel with sembako
 * (dry) — is enforced here on the CLIENT before the backend's own
 * `ERR_SHIPMENT_TYPE_MIX` check ever fires: choosing a `shipmentType` first
 * filters every request/line down to only the compatible `storageType`, so
 * mixing is structurally impossible to build rather than merely rejected
 * after the fact.
 *
 * Assumption flagged for the architect: CONTRACTS §4.10's `shipmentType` is
 * a strict `'frozen'|'dry'` (no separate `'chilled'` shipment type), while
 * `Item.storageType`/`DropLine.storageType` is a three-way
 * `'frozen'|'chilled'|'dry'`. This form treats `chilled` items as riding
 * under the `frozen` shipment (cold-chain / freezer-truck requirement,
 * consistent with `vehicle.hasFreezer` gating `frozen` SJs) rather than
 * under `dry` — the safer reading of FR-LOG-02, but a genuine three-way vs
 * two-way enum mismatch the contract doesn't resolve explicitly.
 */
export function SjCreateForm({
  requests,
  drivers,
  vehicles,
  submitting,
  onSubmit,
}: SjCreateFormProps) {
  const { t } = useI18n();
  const [shipmentType, setShipmentType] = useState<'frozen' | 'dry'>('frozen');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [driverId, setDriverId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [plannedDate, setPlannedDate] = useState('');
  const [notes, setNotes] = useState('');

  function isCompatible(storageType: string | undefined): boolean {
    if (!storageType) return true;
    return shipmentType === 'frozen'
      ? storageType === 'frozen' || storageType === 'chilled'
      : storageType === 'dry';
  }

  const requestRows = useMemo(
    () =>
      requests.map((r) => {
        const compatibleLines = r.lines.filter((l) => isCompatible(l.storageType));
        const excludedCount = r.lines.length - compatibleLines.length;
        return {
          request: r,
          compatibleLines,
          excludedCount,
          selectable: compatibleLines.length > 0,
        };
      }),
    [requests, shipmentType],
  );

  const selectedRows = requestRows.filter((row) => selected[row.request.id] && row.selectable);

  const drops = useMemo(() => {
    const byLocation = new Map<string, CreateSjPayload['drops'][number]>();
    for (const row of selectedRows) {
      const key = row.request.locationId;
      const existing = byLocation.get(key) ?? {
        locationId: row.request.locationId,
        locationName: row.request.locationName,
        replenishmentRequestId: row.request.id,
        lines: [],
      };
      for (const l of row.compatibleLines) {
        existing.lines.push({
          itemId: l.itemId,
          itemName: l.itemName,
          unitCode: l.unitCode,
          qty: (l.qtyApproved ?? l.qtyRequested) as string,
          unitId: l.itemId,
        });
      }
      byLocation.set(key, existing);
    }
    return Array.from(byLocation.values());
  }, [selectedRows]);

  const freezerRequired = shipmentType === 'frozen';
  const chosenVehicle = vehicles.find((v) => v.id === vehicleId);
  const vehicleOk = !!chosenVehicle && (!freezerRequired || chosenVehicle.hasFreezer);

  const canSubmit = drops.length > 0 && !!driverId && !!vehicleId && vehicleOk && !!plannedDate;

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      shipmentType,
      driverId,
      vehicleId,
      plannedDate,
      notes: notes.trim() || undefined,
      drops,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-text-primary">
          {t('warehouse.sj.shipmentType')}
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={shipmentType === 'frozen' ? 'primary' : 'outline'}
            leftIcon={<Snowflake className="size-4" />}
            onClick={() => setShipmentType('frozen')}
            disabled={submitting}
          >
            {t('warehouse.sj.frozen')}
          </Button>
          <Button
            type="button"
            variant={shipmentType === 'dry' ? 'primary' : 'outline'}
            leftIcon={<Package className="size-4" />}
            onClick={() => setShipmentType('dry')}
            disabled={submitting}
          >
            {t('warehouse.sj.dry')}
          </Button>
        </div>
      </div>

      <Card className="border-warning-600/30 bg-warning-50/40">
        <CardContent className="flex items-start gap-2 p-3 text-sm text-warning-700">
          <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
          <span>{t('warehouse.sj.mixWarning')}</span>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-text-primary">
          {t('warehouse.sj.pickRequests')}
        </span>
        {requestRows.length === 0 && (
          <p className="text-sm text-text-muted">{t('warehouse.sj.noApprovedRequests')}</p>
        )}
        {requestRows.map(({ request, compatibleLines, excludedCount, selectable }) => (
          <Card key={request.id} className={!selectable ? 'opacity-50' : undefined}>
            <CardContent className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <Checkbox
                  label={`${request.requestNumber} — ${request.locationName}`}
                  checked={!!selected[request.id]}
                  disabled={!selectable || submitting}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => ({ ...prev, [request.id]: checked }))
                  }
                />
                <Badge variant={selectable ? 'info' : 'default'} size="sm">
                  {compatibleLines.length} item
                </Badge>
              </div>
              {excludedCount > 0 && (
                <p className="pl-6 text-xs text-warning-700">
                  {t('warehouse.sj.excludedLines', { count: excludedCount })}
                </p>
              )}
              {!selectable && (
                <p className="pl-6 text-xs text-text-muted">
                  {t('warehouse.sj.noCompatibleLines')}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {drops.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-text-primary">
            {t('warehouse.sj.routePreview')}
          </span>
          {drops.map((d, idx) => (
            <Card key={d.locationId}>
              <CardContent className="p-3 text-sm">
                <p className="font-medium text-text-primary">
                  {t('warehouse.sj.dropSeq', { seq: idx + 1 })} — {d.locationName}
                </p>
                <ul className="mt-1 list-disc pl-5 text-text-secondary">
                  {d.lines.map((l) => (
                    <li key={l.itemId}>
                      {l.itemName}: {formatQty(l.qty, l.unitCode)}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('warehouse.sj.driver')}
          value={driverId}
          onValueChange={setDriverId}
          options={drivers.map((d) => ({ value: d.id, label: d.name }))}
          placeholder={t('common.selectPlaceholder')}
          disabled={submitting}
        />
        <Select
          label={t('warehouse.sj.vehicle')}
          value={vehicleId}
          onValueChange={setVehicleId}
          options={vehicles.map((v) => ({
            value: v.id,
            label: `${v.plateNumber}${v.hasFreezer ? ' ❄' : ''}`,
          }))}
          placeholder={t('common.selectPlaceholder')}
          error={vehicleId && !vehicleOk ? t('warehouse.sj.vehicleNeedsFreezer') : undefined}
          disabled={submitting}
        />
        <Input
          type="date"
          label={t('warehouse.sj.plannedDate')}
          value={plannedDate}
          onChange={(e) => setPlannedDate(e.target.value)}
          disabled={submitting}
        />
      </div>

      <Textarea
        label={t('common.notes')}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={submitting}
      />

      <div className="flex justify-end">
        <Button type="button" loading={submitting} disabled={!canSubmit} onClick={submit}>
          {t('warehouse.sj.create')}
        </Button>
      </div>
    </div>
  );
}
