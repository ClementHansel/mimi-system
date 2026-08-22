'use client';

import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatQty, parseQtyInput } from '@/lib/formatters';
import type { Qty } from '@/lib/shared-types';

/**
 * Quantity input for NUMERIC(14,3) columns — decimal-string safe (CONTRACTS
 * §0). Accepts up to 3 decimals, comma or period while typing (id-ID users
 * type both); always emits the canonical period-decimal `Qty` string.
 */
export interface QtyInputProps {
  label?: string;
  error?: string;
  hint?: string;
  value: Qty | null;
  onChange: (value: Qty | null) => void;
  /** Unit code shown as a suffix, e.g. "kg", "pcs" (from `units.code`). */
  unitCode?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'touch';
  id?: string;
  wrapperClassName?: string;
}

const SIZE_CLASSES: Record<NonNullable<QtyInputProps['size']>, string> = {
  sm: 'h-8 text-sm px-2.5',
  md: 'h-10 text-sm px-3',
  lg: 'h-11 text-base px-3.5',
  touch: 'h-touch text-lg px-4',
};

export function QtyInput({
  label,
  error,
  hint,
  value,
  onChange,
  unitCode,
  placeholder = '0',
  required,
  disabled,
  size = 'md',
  id,
  wrapperClassName,
}: QtyInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!focused) return;
    setDraft(value ?? '');
  }, [focused, value]);

  const display = focused ? draft : formatQty(value);

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        <input
          id={inputId}
          inputMode="decimal"
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          aria-invalid={!!error || undefined}
          value={display}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9,.-]/g, ''))}
          onBlur={() => {
            setFocused(false);
            onChange(parseQtyInput(draft));
          }}
          className={cn(
            'w-full rounded-md border bg-surface-raised text-right tabular-nums text-text-primary',
            'placeholder:text-text-muted transition-colors focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error ? 'border-danger-600' : 'border-border-strong',
            // ORDER MATTERS HERE. `cn()` is tailwind-merge: when two classes set
            // the same property, the LAST one wins and the earlier is dropped.
            // `SIZE_CLASSES` carries `px-*`, which sets padding on BOTH sides —
            // so a side-specific padding listed BEFORE it (the room reserved for
            // the affix below) was silently deleted, the value rendered flush to
            // the edge, and the absolutely-positioned affix sat on top of it.
            // That is the garbled "2,6"/"kg" overlap the owner reported in the
            // recipe modal. Size first, affix padding after.
            SIZE_CLASSES[size],
            unitCode && 'pr-12',
          )}
        />
        {unitCode && (
          <span className="pointer-events-none absolute right-3 text-sm text-text-muted">
            {unitCode}
          </span>
        )}
      </div>
      {error ? (
        <p className="text-sm text-danger-600">{error}</p>
      ) : hint ? (
        <p className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
