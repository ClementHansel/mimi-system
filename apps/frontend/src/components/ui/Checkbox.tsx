'use client';

import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'type' | 'size'
> {
  label?: string;
  description?: string;
  error?: string;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, error, onCheckedChange, id, className, checked, disabled, ...rest },
  ref,
) {
  const autoId = useId();
  const boxId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={boxId}
        className={cn(
          'flex cursor-pointer items-start gap-2.5',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span className="relative mt-0.5 flex-none">
          <input
            ref={ref}
            id={boxId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onCheckedChange?.(e.target.checked)}
            className="peer sr-only"
            {...rest}
          />
          <span
            aria-hidden
            className={cn(
              'flex size-5 items-center justify-center rounded-[0.3rem] border-2 border-border-strong bg-surface-raised',
              'transition-colors peer-checked:border-brand-500 peer-checked:bg-brand-500',
              'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500',
              className,
            )}
          >
            {checked && <Check className="size-3.5 text-white" strokeWidth={3} />}
          </span>
        </span>
        {(label || description) && (
          <span className="flex flex-col">
            {label && <span className="text-sm font-medium text-text-primary">{label}</span>}
            {description && <span className="text-sm text-text-muted">{description}</span>}
          </span>
        )}
      </label>
      {error && <p className="pl-7 text-sm text-danger-600">{error}</p>}
    </div>
  );
});
