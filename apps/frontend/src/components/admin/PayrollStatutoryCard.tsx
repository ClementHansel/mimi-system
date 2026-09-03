'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import type { StatutoryStatus } from './types';
import { errMsg } from '@/lib/api-error';

/**
 * F10 admin — Settings → "Mode Payroll Statutori" (Amendment 1 / D-18).
 *
 * SCOPE NOTE for the orchestrator: CONTRACTS §8.3 files the full §4.15 payroll
 * module (including this wizard's endpoints) under F08 `hr/` (W4-10), and the
 * RBAC matrix backs that up unevenly — `payroll.statutory.config` (the BPJS
 * rate table / PPh21 TER-PTKP-Article17 / employee tax-profile editors) is
 * held by `finance`/`hr_admin`, NOT `owner`/`manager`. This card therefore
 * does NOT build those editors (they belong in F08, and I don't hold the
 * files or the permission model to justify duplicating them here). What IS
 * `owner`/`manager`-permissioned — `payroll.statutory.read` and
 * `.enable` — squarely matches F10's Owner/Manager audience, so this card
 * covers exactly that slice: show the wizard's own readiness check
 * (`GET .../status`, the `missing[]` array) and drive the final
 * enable/disable step. `ERR_USE_WIZARD` (raw `PUT /api/settings/payroll.statutory`
 * is rejected) is why there is no plain settings-table row for this key —
 * enabling MUST go through `POST /api/payroll/statutory/enable`.
 */
const MISSING_LABELS: Record<string, string> = {
  bpjs_configs: 'admin.settings.payrollStatutory.missing.bpjs_configs',
  pph21_ter_rates: 'admin.settings.payrollStatutory.missing.pph21_ter_rates',
  pph21_ptkp: 'admin.settings.payrollStatutory.missing.pph21_ptkp',
  pph21_article17_brackets: 'admin.settings.payrollStatutory.missing.pph21_article17_brackets',
  employee_tax_profiles: 'admin.settings.payrollStatutory.missing.employee_tax_profiles',
};

export function PayrollStatutoryCard() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [status, setStatus] = useState<StatutoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableReason, setDisableReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    api
      .get<StatutoryStatus>('/payroll/statutory/status')
      .then(setStatus)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<StatutoryStatus>('/payroll/statutory/enable', {
        confirm: true,
      });
      setStatus(updated);
      setConfirmEnableOpen(false);
      toast({ title: t('admin.settings.payrollStatutory.enableSuccess'), variant: 'success' });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'ERR_STATUTORY_NOT_READY'
          ? t('admin.settings.payrollStatutory.notReadyError')
          : // Was `err.message` — the developer string — for every other
            // ApiError. `errMsg` maps the code, then the status class, and only
            // then falls back.
            errMsg(err, t('errors.generic')),
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<StatutoryStatus>('/payroll/statutory/disable', {
        reason: disableReason,
      });
      setStatus(updated);
      setDisableOpen(false);
      setDisableReason('');
      toast({ title: t('admin.settings.payrollStatutory.disableSuccess'), variant: 'success' });
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.settings.payrollStatutory.title')}</CardTitle>
        <CardDescription>{t('admin.settings.payrollStatutory.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading || !status ? (
          <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {status.enabled ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success-50 px-2.5 py-1 text-sm font-medium text-success-700">
                  <CheckCircle2 className="size-3.5" aria-hidden />{' '}
                  {t('admin.settings.payrollStatutory.statusEnabled')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-sm font-medium text-stone-600">
                  <ShieldCheck className="size-3.5" aria-hidden />{' '}
                  {t('admin.settings.payrollStatutory.statusDisabled')}
                </span>
              )}
              {status.ready ? (
                <Badge variant="success" size="sm">
                  {t('admin.settings.payrollStatutory.readyBadge')}
                </Badge>
              ) : (
                <Badge variant="warning" size="sm">
                  {t('admin.settings.payrollStatutory.notReadyBadge')}
                </Badge>
              )}
            </div>

            {status.enabled && status.enabledAt && (
              <p className="text-sm text-text-muted">
                {t('admin.settings.payrollStatutory.enabledAt', {
                  when: fmtDateTime(status.enabledAt),
                })}
                {status.enabledBy &&
                  ` ${t('admin.settings.payrollStatutory.enabledBy', { name: status.enabledBy })}`}
              </p>
            )}

            <p className="text-sm text-text-secondary">
              {t('admin.settings.payrollStatutory.profileCoverage', {
                withProfile: status.profileCoverage.withProfile,
                total: status.profileCoverage.total,
              })}
            </p>

            {status.missing.length > 0 && (
              <div className="rounded-md border border-warning-600/30 bg-warning-50 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-warning-700">
                  <AlertTriangle className="size-4" aria-hidden />{' '}
                  {t('admin.settings.payrollStatutory.missingTitle')}
                </p>
                <ul className="list-inside list-disc text-sm text-warning-700">
                  {status.missing.map((m) => (
                    <li key={m}>{t(MISSING_LABELS[m] ?? m)}</li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-text-muted">
                  {t('admin.settings.payrollStatutory.configureHint')}
                </p>
              </div>
            )}

            {error && <p className="text-sm text-danger-600">{error}</p>}

            {can('payroll.statutory.enable') && (
              <div>
                {status.enabled ? (
                  <Button variant="outline" onClick={() => setDisableOpen(true)}>
                    {t('admin.settings.payrollStatutory.disableButton')}
                  </Button>
                ) : (
                  <Button onClick={() => setConfirmEnableOpen(true)} disabled={!status.ready}>
                    {t('admin.settings.payrollStatutory.enableButton')}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      {confirmEnableOpen && (
        <Modal
          open
          onClose={() => setConfirmEnableOpen(false)}
          title={t('admin.settings.payrollStatutory.confirmEnableTitle')}
          description={t('admin.settings.payrollStatutory.confirmEnableDescription')}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmEnableOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={enable} loading={busy}>
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-secondary">
            {t('admin.settings.payrollStatutory.confirmEnableDescription')}
          </p>
        </Modal>
      )}

      {disableOpen && (
        <Modal
          open
          onClose={() => setDisableOpen(false)}
          title={t('admin.settings.payrollStatutory.disableTitle')}
          footer={
            <>
              <Button variant="outline" onClick={() => setDisableOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" onClick={disable} loading={busy} disabled={!disableReason}>
                {t('common.confirm')}
              </Button>
            </>
          }
        >
          <Textarea
            label={t('admin.settings.payrollStatutory.disableReasonLabel')}
            placeholder={t('admin.settings.payrollStatutory.disableReasonPlaceholder')}
            value={disableReason}
            onChange={(e) => setDisableReason(e.target.value)}
            required
          />
        </Modal>
      )}
    </Card>
  );
}
