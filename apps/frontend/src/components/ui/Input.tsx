'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  /** Validation message — also flips the field to the danger border and sets aria-invalid. */
  error?: string;
  hint?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'touch';
  wrapperClassName?: string;
}

const SIZE_CLASSES: Record<NonNullable<InputProps['size']>, string> = {
  sm: 'h-8 text-sm px-2.5',
  md: 'h-10 text-sm px-3',
  lg: 'h-11 text-base px-3.5',
  touch: 'h-touch text-base px-4',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, leftIcon, rightIcon, size = 'md', required, id, className, wrapperClassName, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && <span className="pointer-events-none absolute left-3 text-text-muted">{leftIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={!!error || undefined}
          aria-describedby={cn(hintId, errorId) || undefined}
          className={cn(
            'w-full rounded-md border bg-surface-raised text-text-primary placeholder:text-text-muted',
            'transition-colors focus-visible:border-brand-500',
            'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
            error ? 'border-danger-600' : 'border-border-strong',
            SIZE_CLASSES[size],
            leftIcon && 'pl-9',
            rightIcon && 'pr-9',
            className,
          )}
          {...rest}
        />
        {rightIcon && <span className="pointer-events-none absolute right-3 text-text-muted">{rightIcon}</span>}
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-danger-600">{error}</p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
});
