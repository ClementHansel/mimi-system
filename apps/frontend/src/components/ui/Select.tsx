'use client';

import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label?: string;
  error?: string;
  hint?: string;
  placeholder?: string;
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  size?: 'sm' | 'md' | 'lg' | 'touch';
  required?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  wrapperClassName?: string;
}

const SIZE_CLASSES: Record<NonNullable<SelectProps['size']>, string> = {
  sm: 'h-8 text-sm pl-2.5 pr-8',
  md: 'h-10 text-sm pl-3 pr-9',
  lg: 'h-11 text-base pl-3.5 pr-9',
  touch: 'h-touch text-base pl-4 pr-10',
};

/**
 * A native `<select>` under the hood — deliberately not a custom listbox.
 * Native select gives correct keyboard/screen-reader behavior for free and
 * works flawlessly on POS tablets; `onValueChange(value)` keeps the call site
 * ergonomic (Radix-style) without reimplementing ARIA.
 */
export function Select({
  label,
  error,
  hint,
  placeholder,
  options,
  value,
  onValueChange,
  size = 'md',
  required,
  disabled,
  id,
  name,
  className,
  wrapperClassName,
}: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          name={name}
          value={value}
          disabled={disabled}
          required={required}
          aria-invalid={!!error || undefined}
          aria-describedby={cn(hintId, errorId) || undefined}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            'w-full appearance-none rounded-md border bg-surface-raised text-text-primary',
            'transition-colors focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error ? 'border-danger-600' : 'border-border-strong',
            SIZE_CLASSES[size],
            className,
          )}
        >
          {placeholder && (
            <option value="" disabled hidden>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
          aria-hidden
        />
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-danger-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
