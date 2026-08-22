'use client';

import { useEffect, useId, useState } from 'react';
import { Snowflake } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTemp, parseTempInput } from '@/lib/formatters';
import type { Temp } from '@/lib/shared-types';

/**
 * Cold-chain temperature input for NUMERIC(4,1) columns — decimal-string
 * safe (CONTRACTS §0). One decimal place, negative allowed (frozen chicken
 * runs -25.0..-15.0, D-14). `belowRange`/`aboveRange` let the caller flag a
 * cold-chain breach (SJ temp log, storage area check) without this
 * component needing to know the item's own temp_min/temp_max.
 */
export interface TempInputProps {
  label?: string;
  error?: string;
  hint?: string;
  value: Temp | null;
  onChange: (value: Temp | null) => void;
  /** Highlight as a breach (SYNC-PROTOCOL cold-chain alert) — red border/icon instead of the neutral snowflake. */
  breach?: boolean;
  required?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'touch';
  id?: string;
  wrapperClassName?: string;
}

const SIZE_CLASSES: Record<NonNullable<TempInputProps['size']>, string> = {
  sm: 'h-8 text-sm px-2.5',
  md: 'h-10 text-sm px-3',
  lg: 'h-11 text-base px-3.5',
  touch: 'h-touch text-lg px-4',
};

export function TempInput({
  label,
  error,
  hint,
  value,
  onChange,
  breach = false,
  required,
  disabled,
  size = 'md',
  id,
  wrapperClassName,
}: TempInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!focused) return;
    setDraft(value ?? '');
  }, [focused, value]);

  const display = focused ? draft : formatTemp(value);

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        <Snowflake
          className={cn(
            'pointer-events-none absolute left-3 size-4',
            breach ? 'text-danger-600' : 'text-cold-600',
          )}
          aria-hidden
        />
        <input
          id={inputId}
          inputMode="decimal"
          disabled={disabled}
          required={required}
          placeholder="0,0"
          aria-invalid={!!error || breach || undefined}
          value={display}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9,.-]/g, ''))}
          onBlur={() => {
            setFocused(false);
            onChange(parseTempInput(draft));
          }}
          className={cn(
            'w-full rounded-md border bg-surface-raised text-right tabular-nums text-text-primary',
            'placeholder:text-text-muted transition-colors focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error || breach ? 'border-danger-600' : 'border-border-strong',
            // ORDER MATTERS HERE. `cn()` is tailwind-merge: when two classes set
            // the same property, the LAST one wins and the earlier is dropped.
            // `SIZE_CLASSES` carries `px-*`, which sets padding on BOTH sides —
            // so a side-specific padding listed BEFORE it (the room reserved for
            // the affix below) was silently deleted, the value rendered flush to
            // the edge, and the absolutely-positioned affix sat on top of it.
            // That is the garbled "2,6"/"kg" overlap the owner reported in the
            // recipe modal. Size first, affix padding after.
            SIZE_CLASSES[size],
            // Room for the thermometer icon / unit affix.
            'pl-9',
          )}
        />
      </div>
      {error ? (
        <p className="text-sm text-danger-600">{error}</p>
      ) : hint ? (
        <p className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
