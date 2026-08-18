'use client';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { toDateInput } from '@/lib/dates';
import type { ISODate } from '@/lib/shared-types';

/**
 * WITA-aware date range picker (D-11 — presets are computed in
 * `Asia/Makassar`, never the browser's local timezone). Two native
 * `<input type="date">` fields for the exact range, plus one-tap presets for
 * the ranges every back-office report actually asks for.
 */
export interface DateRangeValue {
  from: ISODate | null;
  to: ISODate | null;
}

export interface DateRangePickerProps {
  label?: string;
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  disabled?: boolean;
  className?: string;
}

function witaToday(): Date {
  // A Date constructed from the WITA calendar day's midnight, safe to feed
  // back into `toDateInput` for further offsetting below. `toDateInput`
  // always yields a well-formed `YYYY-MM-DD`, but the fallbacks keep this
  // type-safe under `noUncheckedIndexedAccess` without a non-null assertion.
  const [y, m, d] = toDateInput(new Date()).split('-').map(Number);
  const now = new Date();
  return new Date(y ?? now.getFullYear(), (m ?? now.getMonth() + 1) - 1, d ?? now.getDate());
}

function addDays(base: Date, days: number): ISODate {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return toDateInput(d);
}

export function DateRangePicker({
  label,
  value,
  onChange,
  disabled,
  className,
}: DateRangePickerProps) {
  const { t } = useI18n();
  const today = witaToday();

  const presets: { key: string; labelKey: string; range: DateRangeValue }[] = [
    {
      key: 'today',
      labelKey: 'dateRange.presetToday',
      range: { from: addDays(today, 0), to: addDays(today, 0) },
    },
    {
      key: 'yesterday',
      labelKey: 'dateRange.presetYesterday',
      range: { from: addDays(today, -1), to: addDays(today, -1) },
    },
    {
      key: 'last7',
      labelKey: 'dateRange.presetLast7',
      range: { from: addDays(today, -6), to: addDays(today, 0) },
    },
    {
      key: 'last30',
      labelKey: 'dateRange.presetLast30',
      range: { from: addDays(today, -29), to: addDays(today, 0) },
    },
    {
      key: 'thisMonth',
      labelKey: 'dateRange.presetThisMonth',
      range: {
        from: toDateInput(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: addDays(today, 0),
      },
    },
    {
      key: 'lastMonth',
      labelKey: 'dateRange.presetLastMonth',
      range: {
        from: toDateInput(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        to: toDateInput(new Date(today.getFullYear(), today.getMonth(), 0)),
      },
    },
  ];

  const activePreset = presets.find(
    (p) => p.range.from === value.from && p.range.to === value.to,
  )?.key;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {label && <span className="text-sm font-medium text-text-primary">{label}</span>}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('dateRange.label')}>
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.range)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              activePreset === p.key
                ? 'border-brand-500 bg-brand-50 text-brand-700'
                : 'border-border-strong text-text-secondary hover:bg-surface-sunken',
            )}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
          {t('common.from')}
          <input
            type="date"
            disabled={disabled}
            value={value.from ?? ''}
            onChange={(e) => onChange({ ...value, from: e.target.value || null })}
            className="rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm text-text-primary focus-visible:border-brand-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-text-secondary">
          {t('common.to')}
          <input
            type="date"
            disabled={disabled}
            value={value.to ?? ''}
            onChange={(e) => onChange({ ...value, to: e.target.value || null })}
            className="rounded-md border border-border-strong bg-surface-raised px-2 py-1.5 text-sm text-text-primary focus-visible:border-brand-500"
          />
        </label>
      </div>
    </div>
  );
}
