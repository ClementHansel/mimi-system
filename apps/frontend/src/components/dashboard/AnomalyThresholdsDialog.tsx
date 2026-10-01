'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { errMsg } from '@/lib/api-error';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { dashboardApi } from './lib/dashboard-api';
import type { ThresholdField, ThresholdsResponse } from './lib/anomaly-types';

export interface AnomalyThresholdsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save, so the panel can re-run against the new numbers. */
  onSaved: () => void;
}

const fieldId = (f: ThresholdField) => `${f.detector}.${f.key}`;

/**
 * The owner's thresholds dialog. The fields, their defaults and their allowed
 * ranges all come from `GET /dashboard/anomalies/thresholds` — the server is
 * the one place that knows them, so a parameter added there appears here
 * without a frontend change (its label is the only thing this app supplies,
 * as `dashboard.anomaly.params.<detector>.<key>`).
 *
 * A number outside its range is refused here with its own message, and again
 * by the server (which is the one that counts — the error CODE is what a
 * rejected save shows, via `errMsg`).
 */
export function AnomalyThresholdsDialog({ open, onClose, onSaved }: AnomalyThresholdsDialogProps) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<ThresholdsResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(null);
    setLoadError(undefined);
    setSaveError(undefined);
    dashboardApi
      .getAnomalyThresholds()
      .then((res) => {
        if (cancelled) return;
        setLoaded(res);
        const v: Record<string, string> = {};
        for (const f of res.fields)
          v[fieldId(f)] = String(res.thresholds[f.detector]?.[f.key] ?? f.default);
        setValues(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errMsg(err, t('table.error')));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const fields = loaded?.fields ?? [];
  const detectors = [...new Set(fields.map((f) => f.detector))];

  function fieldError(f: ThresholdField): string | undefined {
    const raw = values[fieldId(f)];
    const n = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) {
      return t('dashboard.anomaly.thresholds.invalid');
    }
    if (n < f.min || n > f.max) {
      return t('dashboard.anomaly.thresholds.range', { min: f.min, max: f.max });
    }
    if (f.integer && !Number.isInteger(n)) return t('dashboard.anomaly.thresholds.integer');
    return undefined;
  }

  const hasErrors = fields.some((f) => fieldError(f) !== undefined);

  async function save() {
    if (!loaded || hasErrors) return;
    setSaving(true);
    setSaveError(undefined);
    const body: Record<string, Record<string, number>> = {};
    for (const f of fields) (body[f.detector] ??= {})[f.key] = Number(values[fieldId(f)]);
    try {
      await dashboardApi.putAnomalyThresholds(body);
      toast({ title: t('dashboard.anomaly.thresholds.saved'), variant: 'success' });
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(errMsg(err, t('dashboard.anomaly.thresholds.saveFailed')));
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    if (!loaded) return;
    const v: Record<string, string> = {};
    for (const f of fields) v[fieldId(f)] = String(f.default);
    setValues(v);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('dashboard.anomaly.thresholds.title')}
      description={t('dashboard.anomaly.thresholds.description')}
      footer={
        <>
          <Button variant="ghost" onClick={resetToDefaults} disabled={!loaded || saving}>
            {t('dashboard.anomaly.thresholds.reset')}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save} loading={saving} disabled={!loaded || hasErrors}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {loadError && <p className="text-sm text-danger-600">{loadError}</p>}
      {!loaded && !loadError && <p className="text-sm text-text-secondary">{t('table.loading')}</p>}
      {loaded && (
        <div className="flex flex-col gap-5">
          {detectors.map((detector) => (
            <fieldset key={detector} className="flex flex-col gap-3">
              <legend className="font-display text-base font-semibold text-text-primary">
                {t(`dashboard.anomaly.detectors.${detector}.label`)}
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {fields
                  .filter((f) => f.detector === detector)
                  .map((f) => (
                    <Input
                      key={fieldId(f)}
                      type="number"
                      step="any"
                      inputMode="decimal"
                      label={t(`dashboard.anomaly.params.${f.detector}.${f.key}`)}
                      hint={t('dashboard.anomaly.thresholds.default', { value: f.default })}
                      value={values[fieldId(f)] ?? ''}
                      error={fieldError(f)}
                      onChange={(e) => setValues((v) => ({ ...v, [fieldId(f)]: e.target.value }))}
                    />
                  ))}
              </div>
            </fieldset>
          ))}
          {saveError && (
            <p role="alert" className="text-sm text-danger-600">
              {saveError}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
