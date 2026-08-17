'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  label?: string;
  error?: string;
  options: RadioOption[];
  value: string;
  onValueChange: (value: string) => void;
  name?: string;
  orientation?: 'vertical' | 'horizontal';
  disabled?: boolean;
  className?: string;
}

export function RadioGroup({
  label, error, options, value, onValueChange, name, orientation = 'vertical', disabled, className,
}: RadioGroupProps) {
  const autoName = useId();
  const groupName = name ?? autoName;

  return (
    <div className={cn('flex flex-col gap-2', className)} role="radiogroup" aria-label={label}>
      {label && <span className="text-sm font-medium text-text-primary">{label}</span>}
      <div className={cn('flex gap-3', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap')}>
        {options.map((opt) => {
          const optId = `${groupName}-${opt.value}`;
          const isDisabled = disabled || opt.disabled;
          return (
            <label
              key={opt.value}
              htmlFor={optId}
              className={cn('flex cursor-pointer items-start gap-2.5', isDisabled && 'cursor-not-allowed opacity-60')}
            >
              <span className="relative mt-0.5 flex-none">
                <input
                  id={optId}
                  type="radio"
                  name={groupName}
                  value={opt.value}
                  checked={value === opt.value}
                  disabled={isDisabled}
                  onChange={() => onValueChange(opt.value)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full border-2 border-border-strong bg-surface-raised',
                    'transition-colors peer-checked:border-brand-500',
                    'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500',
                  )}
                >
                  {value === opt.value && <span className="size-2.5 rounded-full bg-brand-500" />}
                </span>
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-medium text-text-primary">{opt.label}</span>
                {opt.description && <span className="text-sm text-text-muted">{opt.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
}
