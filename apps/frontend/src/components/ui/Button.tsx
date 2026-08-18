'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
/** 'touch'/'touch-lg' are the tablet-first POS/outlet sizes (56px+) — NFR-04 large hit targets. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'touch' | 'touch-lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button — use for in-flight submits. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 disabled:bg-stone-300',
  secondary:
    'bg-stone-100 text-stone-900 hover:bg-stone-200 active:bg-stone-300 disabled:text-stone-400',
  outline:
    'border border-border-strong bg-surface-raised text-text-primary hover:bg-stone-50 disabled:text-stone-400',
  ghost: 'text-text-primary hover:bg-stone-100 disabled:text-stone-400',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 disabled:bg-stone-300',
  link: 'text-brand-600 underline-offset-4 hover:underline disabled:text-stone-400 p-0 h-auto',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
  touch: 'h-touch px-5 text-base gap-2',
  'touch-lg': 'h-touch-lg px-6 text-lg gap-2.5 font-semibold',
};

/**
 * The one button in the system. Every action across every surface should be
 * this component with a `variant`/`size`, not a bespoke `<button>` — keeps
 * touch targets, focus rings, and disabled/loading states consistent from
 * POS tablets to the finance back office.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium',
        'transition-colors disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
