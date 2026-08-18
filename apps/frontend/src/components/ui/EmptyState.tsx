import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /** 'sm' fits inside a DataTable/Card; 'lg' fills a whole placeholder route. */
  size?: 'sm' | 'lg';
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  size = 'sm',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        size === 'lg' ? 'gap-4 px-6 py-16' : 'px-4 py-10',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full bg-surface-sunken text-text-muted',
          size === 'lg' ? 'size-16' : 'size-10',
        )}
      >
        <Icon className={size === 'lg' ? 'size-8' : 'size-5'} aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <p
          className={cn(
            'font-medium text-text-primary',
            size === 'lg' ? 'font-display text-xl' : 'text-sm',
          )}
        >
          {title}
        </p>
        {description && (
          <p
            className={cn(
              'text-text-muted',
              size === 'lg' ? 'mx-auto max-w-md text-base' : 'text-sm',
            )}
          >
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
