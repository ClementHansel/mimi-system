'use client';

import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  wrapperClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, required, id, className, wrapperClassName, rows = 3, ...rest },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const hintId = hint ? `${areaId}-hint` : undefined;
  const errorId = error ? `${areaId}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      {label && (
        <label htmlFor={areaId} className="text-sm font-medium text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        required={required}
        aria-invalid={!!error || undefined}
        aria-describedby={cn(hintId, errorId) || undefined}
        className={cn(
          'w-full resize-y rounded-md border bg-surface-raised px-3 py-2 text-sm text-text-primary',
          'placeholder:text-text-muted transition-colors focus-visible:border-brand-500',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-muted',
          error ? 'border-danger-600' : 'border-border-strong',
          className,
        )}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="text-sm text-danger-600">{error}</p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
});
