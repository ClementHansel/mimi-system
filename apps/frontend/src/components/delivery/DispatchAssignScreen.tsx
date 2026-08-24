'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { Card, CardContent, Select, StatusBadge, EmptyState } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { SuratJalanStatus, type SuratJalan } from '@/lib/shared-types';
import type { Driver, Vehicle } from './lib/types';
import { getDrivers, getSuratJalan, getVehicles, listSuratJalan } from './lib/delivery-api';
import { AssignDriverVehicleForm } from './AssignDriverVehicleForm';
import { DropOrderEditor } from './DropOrderEditor';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Only draft/ready SJs are worth picking here — `loading`/`in_transit`/
// `completed`/`cancelled` can neither have their driver/vehicle reassigned
// nor their route reordered (`SuratJalanService.update`/`RouteService.planRoute`
// both gate on exactly this pair of statuses), so listing them would just be
// a picker full of dead ends. Shared with the "still editable?" check below
// so the picker's filter and the form's disabled state never disagree.
function isEditableStatus(status: string): boolean {
  return status === SuratJalanStatus.DRAFT || status === SuratJalanStatus.READY;
}

/**
 * `/delivery/assign` — the dispatcher's single-purpose screen for picking a
 * Surat Jalan, assigning its driver + truck, and reordering its drops.
 *
 * A dedicated page rather than another tab inside `SuratJalanDetailDrawer`
 * (which already offers both, buried inside the full detail view) because
 * this ticket asked for a focused screen gudang staff go to specifically for
 * dispatch planning — same reasoning `DeliveryShell`'s own doc comment gives
 * for splitting the live board from the SJ list.
 */
export function DispatchAssignScreen() {
  const { t } = useI18n();
  const [options, setOptions] = useState<SuratJalan[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [sj, setSj] = useState<SuratJalan | null>(null);
  const [sjLoading, setSjLoading] = useState(false);
  const [sjError, setSjError] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);

  function reloadOptions() {
    setOptionsLoading(true);
    setOptionsError(null);
    // Two calls, not one: the list endpoint filters on a single `status`
    // value (CONTRACTS §4.10), and this picker needs BOTH editable statuses.
    Promise.all([
      listSuratJalan({ status: SuratJalanStatus.DRAFT }),
      listSuratJalan({ status: SuratJalanStatus.READY }),
    ])
      .then(([draft, ready]) => {
        const merged = [...draft.rows, ...ready.rows].sort((a, b) =>
          a.plannedDate < b.plannedDate ? 1 : a.plannedDate > b.plannedDate ? -1 : 0,
        );
        setOptions(merged);
      })
      .catch((err: unknown) => setOptionsError(errMsg(err, t('table.error'))))
      .finally(() => setOptionsLoading(false));
  }

  useEffect(reloadOptions, []);

  useEffect(() => {
    getDrivers()
      .then(setDrivers)
      .catch(() => {});
    getVehicles()
      .then(setVehicles)
      .catch(() => {});
  }, []);

  function loadSj(id: string) {
    if (!id) {
      setSj(null);
      return;
    }
    setSjLoading(true);
    setSjError(null);
    getSuratJalan(id)
      .then(setSj)
      .catch((err: unknown) => setSjError(errMsg(err, t('table.error'))))
      .finally(() => setSjLoading(false));
  }

  function handleSelect(id: string) {
    setSelectedId(id);
    loadSj(id);
  }

  // After a driver/vehicle save or a reorder save, re-fetch this SJ (its
  // status may not have changed but its driver/vehicle/drop-sequence has)
  // AND the picker list (a driver reassignment can change which SJs collide
  // with which — the picker's own labels below show driver names).
  function handleChanged() {
    if (selectedId) loadSj(selectedId);
    reloadOptions();
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="font-display text-2xl font-semibold text-text-primary">
          {t('deliveryAssign.title')}
        </h1>
        <p className="text-sm text-text-muted">{t('deliveryAssign.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <Select
            label={t('deliveryAssign.picker.label')}
            placeholder={t('deliveryAssign.picker.placeholder')}
            value={selectedId}
            onValueChange={handleSelect}
            disabled={optionsLoading}
            options={options.map((row) => ({
              value: row.id,
              label: `${row.sjNumber} — ${row.driver.name} — ${fmtDate(row.plannedDate)}`,
            }))}
          />
          {optionsError && <p className="text-sm text-danger-600">{optionsError}</p>}
          {!optionsLoading && options.length === 0 && !optionsError && (
            <p className="text-sm text-text-muted">{t('deliveryAssign.picker.empty')}</p>
          )}
        </CardContent>
      </Card>

      {sjError && <p className="text-sm text-danger-600">{sjError}</p>}

      {!selectedId && !sjLoading && (
        <EmptyState title={t('deliveryAssign.picker.noneSelected')} size="lg" />
      )}

      {sj && !sjLoading && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-text-primary">{sj.sjNumber}</span>
                <StatusBadge domain="suratJalan" status={sj.status} />
              </div>
              <AssignDriverVehicleForm
                sj={sj}
                drivers={drivers}
                vehicles={vehicles}
                onSaved={handleChanged}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <DropOrderEditor
                sjId={sj.id}
                drops={sj.drops}
                editable={isEditableStatus(sj.status)}
                onSaved={handleChanged}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
