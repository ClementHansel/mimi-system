'use client';

import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatMoney, parseMoneyInput } from '@/lib/formatters';
import type { Money } from '@/lib/shared-types';

/**
 * IDR money input, decimal-string safe (CONTRACTS §0). `value`/`onChange`
 * ALWAYS deal in the canonical `Money` wire string ("125000.00") — this
 * component owns the only place a user's keystrokes get translated into
 * that string (`parseMoneyInput`); it never hands a caller a JS number.
 *
 * UX: shows the raw digit-grouped value while focused (so the caret behaves
 * predictably while typing) and the fully formatted "Rp125.000" once blurred.
 */
export interface MoneyInputProps {
  label?: string;
  error?: string;
  hint?: string;
  value: Money | null;
  onChange: (value: Money | null) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'touch';
  id?: string;
  className?: string;
  wrapperClassName?: string;
}

const SIZE_CLASSES: Record<NonNullable<MoneyInputProps['size']>, string> = {
  sm: 'h-8 text-sm px-2.5',
  md: 'h-10 text-sm px-3',
  lg: 'h-11 text-base px-3.5',
  touch: 'h-touch text-lg px-4',
};

export function MoneyInput({
  label, error, hint, value, onChange, placeholder = '0',
  required, disabled, size = 'md', id, className, wrapperClassName,
}: MoneyInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!focused) return;
    setDraft(value ? (value.split('.')[0] ?? '') : '');
  }, [focused, value]);

  const display = focused ? draft : formatMoney(value, { withSymbol: false });

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3 text-sm font-medium text-text-muted">Rp</span>
        <input
          id={inputId}
          inputMode="numeric"
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          aria-invalid={!!error || undefined}
          value={display}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => {
            setFocused(false);
            onChange(parseMoneyInput(draft));
          }}
          className={cn(
            'w-full rounded-md border bg-surface-raised pl-8 text-right tabular-nums text-text-primary',
            'placeholder:text-text-muted transition-colors focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error ? 'border-danger-600' : 'border-border-strong',
            SIZE_CLASSES[size],
            className,
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
