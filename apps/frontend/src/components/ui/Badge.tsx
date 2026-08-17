import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-stone-100 text-stone-700',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
  info: 'bg-info-50 text-info-700',
  neutral: 'bg-stone-100 text-stone-600',
};

/** Generic tag/count pill. For document/entity lifecycle states, use `StatusBadge` instead. */
export function Badge({ variant = 'default', size = 'md', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    />
  );
}
