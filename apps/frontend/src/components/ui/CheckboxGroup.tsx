'use client';

import { type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Checkbox } from './Checkbox';

export interface CheckboxGroupOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/**
 * A set of checkboxes over one list, with a "select all" (MA-193:
 * "Tambahkan Check All untuk form - form yang memiliki multiple Checkbox").
 *
 * Built as a shared component rather than a select-all pasted into each form,
 * because the request is about forms in the plural and the two that need it
 * most — the user-create modal and the user drawer in `admin/UsersPanel` —
 * already carried the same twenty-two-checkbox block twice, character for
 * character. Twenty-two branches on production means assigning a Manager or
 * Finance to the whole company was twenty-two clicks, in two places.
 *
 * SELECT-ALL DOES NOT TOUCH A DISABLED OPTION. A disabled checkbox is
 * disabled for a reason the group knows nothing about (a location the caller
 * may not assign, a component already locked by the system), so a bulk
 * control must not reach past that gate — otherwise "check all" becomes a way
 * to set exactly what the individual control refuses.
 *
 * The all-checkbox is a plain `Checkbox`, not a tri-state one: the shared
 * primitive renders `checked` from `peer-checked` CSS plus its own `<Check>`
 * glyph, and an indeterminate third visual would change that contract for
 * every checkbox in the app. The selected count beside the label carries the
 * partial state instead, which says more than a dash in a box does.
 */
export function CheckboxGroup({
  label,
  hint,
  options,
  value,
  onChange,
  selectAllLabel,
  scrollable = true,
  className,
  disabled,
}: {
  label?: string;
  hint?: ReactNode;
  options: CheckboxGroupOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Overrides the default "Pilih Semua" wording. */
  selectAllLabel?: string;
  /** Caps the list height and scrolls it — the default, and what the callers had. */
  scrollable?: boolean;
  className?: string;
  /** Disables the whole group, select-all included. */
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const selectable = options.filter((o) => !o.disabled);
  const selectableValues = selectable.map((o) => o.value);
  const allSelected =
    selectableValues.length > 0 && selectableValues.every((v) => value.includes(v));
  const selectedCount = options.filter((o) => value.includes(o.value)).length;

  function toggleAll() {
    if (allSelected) {
      // Clears only what select-all could have set; a disabled option that was
      // already selected stays selected.
      onChange(value.filter((v) => !selectableValues.includes(v)));
    } else {
      onChange(Array.from(new Set([...value, ...selectableValues])));
    }
  }

  function toggleOne(option: CheckboxGroupOption, checked: boolean) {
    onChange(checked ? [...value, option.value] : value.filter((v) => v !== option.value));
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-sm font-medium text-text-primary">{label}</span>}
      {hint && <span className="text-sm text-text-muted">{hint}</span>}

      {/* Only worth the row when there is more than one thing to check. */}
      {options.length > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-2.5 py-1.5">
          <Checkbox
            label={selectAllLabel ?? t('common.selectAll')}
            checked={allSelected}
            disabled={disabled || selectable.length === 0}
            onCheckedChange={toggleAll}
          />
          <span className="flex-none text-sm tabular-nums text-text-muted">
            {t('common.selectedOfTotal', { n: selectedCount, total: options.length })}
          </span>
        </div>
      )}

      <div
        className={cn(
          'flex flex-col gap-1 rounded-md border border-border-strong p-2',
          scrollable && 'max-h-40 overflow-y-auto',
        )}
      >
        {options.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            description={option.description}
            checked={value.includes(option.value)}
            disabled={disabled || option.disabled}
            onCheckedChange={(checked) => toggleOne(option, checked)}
          />
        ))}
      </div>
    </div>
  );
}
