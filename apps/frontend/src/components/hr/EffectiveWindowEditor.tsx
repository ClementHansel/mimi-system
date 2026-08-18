'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CalendarClock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  EmptyState,
  PermissionGate,
} from '@/components/ui';
import {
  isoToday,
  sortByEffectiveFromDesc,
  validateNewEffectiveFrom,
  windowState,
} from './lib/effective-window';
import type { EffectiveDatedRow } from './lib/types';

/**
 * ONE editor shell for every BPJS / PPh21 TER / PTKP / Article-17 rate table
 * (CONTRACTS §4.15 Amendment 1) — the part `PayrollStatutoryCard` (F10,
 * W4-05) deliberately left for `payroll.statutory.config` holders
 * (finance/hr_admin), since `owner`/`manager` never touch these editors.
 *
 * The one thing this screen must never let happen: submitting a new rate
 * vintage under the wrong `effectiveFrom` and silently mis-taxing/mis-BPJS-ing
 * everyone from that date forward. So the active/future/past vintage is
 * always labeled (never just a bare date list), and a same-day UX guard
 * (`validateNewEffectiveFrom`) blocks an ambiguous or backdated submission
 * before it ever reaches the server's own `ERR_EFFECTIVE_OVERLAP`/
 * `ERR_BRACKET_GAP` checks.
 *
 * Callers supply the row-shape-specific bits (history row renderer, new-row
 * form fields) since BPJS/TER/PTKP/Article-17 each have different columns —
 * this component owns only the effective-dating machinery common to all four.
 */
export interface EffectiveWindowEditorProps<T extends EffectiveDatedRow> {
  title: string;
  description?: string;
  rows: T[];
  loading?: boolean;
  /** Column headers for the history table. */
  historyColumns: string[];
  /** One `<tr>`'s worth of `<td>`s for a history row (caller owns cell markup). */
  renderHistoryRow: (row: T) => ReactNode;
  /** The new-vintage form fields (inputs for the row-shape-specific columns). */
  formFields: ReactNode;
  effectiveFrom: string;
  onEffectiveFromChange: (value: string) => void;
  onSubmit: () => void;
  submitting?: boolean;
  /** Disables submit beyond the effective-date guard (e.g. "add at least one row"). */
  submitDisabled?: boolean;
  error?: string;
}

export function EffectiveWindowEditor<T extends EffectiveDatedRow>({
  title,
  description,
  rows,
  loading,
  historyColumns,
  renderHistoryRow,
  formFields,
  effectiveFrom,
  onEffectiveFromChange,
  onSubmit,
  submitting,
  submitDisabled,
  error,
}: EffectiveWindowEditorProps<T>) {
  const { t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const today = useMemo(() => isoToday(), []);
  const sorted = useMemo(() => sortByEffectiveFromDesc(rows), [rows]);
  const dateWarning = useMemo(
    () => (effectiveFrom ? validateNewEffectiveFrom(rows, effectiveFrom) : null),
    [rows, effectiveFrom],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {/*
         * The tab itself now only requires `payroll.statutory.read`
         * (FIX-LOADS #3), so a read-only holder (e.g. Owner) can reach this
         * screen — but adding a new rate vintage is a write, and stays
         * behind `payroll.statutory.config` same as the backend's PUT
         * routes (`StatutoryController`).
         */}
        <PermissionGate permission="payroll.statutory.config">
          <Button
            size="sm"
            variant={showForm ? 'outline' : 'primary'}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? t('common.cancel') : t('hr.statutory.addVintage')}
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showForm && (
          <div className="flex flex-col gap-3 rounded-md border border-border-strong bg-surface-sunken p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
                {t('hr.statutory.effectiveFrom')}
                <input
                  type="date"
                  value={effectiveFrom}
                  min={today}
                  onChange={(e) => onEffectiveFromChange(e.target.value)}
                  className="h-10 rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-text-primary"
                />
              </label>
              {dateWarning === 'duplicate' && (
                <p className="text-sm text-danger-600">{t('hr.statutory.effectiveDuplicate')}</p>
              )}
              {dateWarning === 'beforeLatest' && (
                <p className="text-sm text-danger-600">{t('hr.statutory.effectiveBeforeLatest')}</p>
              )}
            </div>
            {formFields}
            <div>
              <Button
                onClick={onSubmit}
                loading={submitting}
                disabled={!effectiveFrom || dateWarning !== null || submitDisabled}
              >
                {t('hr.statutory.saveVintage')}
              </Button>
              {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
            </div>
          </div>
        )}

        {loading ? (
          <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
        ) : sorted.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t('hr.statutory.noVintages')} size="sm" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                  <th className="px-3 py-2">{t('hr.statutory.window')}</th>
                  {historyColumns.map((h) => (
                    <th key={h} className="px-3 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => {
                  const state = windowState(row, today);
                  return (
                    <tr key={i} className="border-b border-border last:border-0 align-top">
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <div className="flex flex-col gap-1">
                          <Badge
                            variant={
                              state === 'active'
                                ? 'success'
                                : state === 'future'
                                  ? 'info'
                                  : 'neutral'
                            }
                            size="sm"
                          >
                            {t(`hr.statutory.windowState.${state}`)}
                          </Badge>
                          <span className="text-xs text-text-muted">
                            {row.effectiveFrom}
                            {' – '}
                            {row.effectiveTo ?? t('hr.statutory.openEnded')}
                          </span>
                        </div>
                      </td>
                      {renderHistoryRow(row)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
