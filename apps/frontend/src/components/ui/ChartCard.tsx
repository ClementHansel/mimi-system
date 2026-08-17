import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card';
import { EmptyState } from './EmptyState';

/**
 * Chart chrome: title/description/action header + a fixed-height content
 * slot with loading/empty states. Wave 5 (F03 dashboard, F07 finance) drops
 * its charting library of choice into `children` — ChartCard itself renders
 * no chart, so it doesn't tie the design system to one.
 */
export interface ChartCardProps {
  title: string;
  description?: string;
  action?: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  height?: number | string;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, description, action, loading, empty, emptyMessage, height = 280, children, className }: ChartCardProps) {
  const { t } = useI18n();
  const style = { height: typeof height === 'number' ? `${height}px` : height };

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>
        <div style={style} className="relative w-full">
          {loading ? (
            <div className="h-full w-full animate-pulse rounded-md bg-surface-sunken" />
          ) : empty ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState title={emptyMessage ?? t('emptyState.genericTitle')} size="sm" />
            </div>
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}
