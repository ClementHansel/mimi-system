'use client';

import type { ReactNode } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Paginated } from '@/lib/api';
import { EmptyState } from './EmptyState';
import { Select } from './Select';

/**
 * The one table for every list screen. `data` is CONTRACTS.md §0's
 * `Paginated<T>` shape directly (`{ rows, total, page, pageSize }`) — no
 * adapter needed between an `/api/...` list response and this component.
 *
 * Fully controlled: sorting and pagination are driven by props and reported
 * back via callbacks, so the caller (which owns the actual list query) is
 * always the single source of truth — DataTable never fetches or holds a
 * competing copy of "what page am I on".
 */
export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** Custom cell renderer. Falls back to `String(row[key])` when omitted. */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  width?: string;
}

export interface DataTableSort {
  key: string;
  direction: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: Paginated<T>;
  keyField: (row: T) => string;
  loading?: boolean;
  error?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  sort?: DataTableSort;
  /** Called with the clicked column's key; caller decides/toggles the direction. */
  onSortChange?: (key: string) => void;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

export function DataTable<T>({
  columns, data, keyField, loading, error, emptyTitle, emptyDescription,
  onRowClick, sort, onSortChange, onPageChange, onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100], className,
}: DataTableProps<T>) {
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));
  const showingFrom = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const showingTo = Math.min(data.page * data.pageSize, data.total);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              {columns.map((col) => {
                const isSorted = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    style={{ width: col.width }}
                    aria-sort={col.sortable ? (isSorted ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                    className={cn(
                      'px-3 py-2.5 font-medium text-text-secondary',
                      col.align === 'right' && 'text-right',
                      col.align === 'center' && 'text-center',
                      !col.align && 'text-left',
                    )}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        onClick={() => onSortChange?.(col.key)}
                        title={isSorted && sort?.direction === 'asc' ? t('table.sortDescending') : t('table.sortAscending')}
                        className="inline-flex items-center gap-1 hover:text-text-primary"
                      >
                        {col.header}
                        {isSorted ? (
                          sort?.direction === 'asc' ? (
                            <ArrowUp className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowDown className="size-3.5" aria-hidden />
                          )
                        ) : (
                          <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: Math.min(data.pageSize, 5) }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-border last:border-0">
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-3">
                      <div className="h-4 animate-pulse rounded bg-surface-sunken" />
                    </td>
                  ))}
                </tr>
              ))}

            {!loading && error && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8">
                  <div className="flex flex-col items-center gap-2 text-center text-danger-600">
                    <AlertCircle className="size-6" aria-hidden />
                    <p className="text-sm">{error || t('table.error')}</p>
                  </div>
                </td>
              </tr>
            )}

            {!loading && !error && data.rows.length === 0 && (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title={emptyTitle ?? t('table.empty')} description={emptyDescription} size="sm" />
                </td>
              </tr>
            )}

            {!loading &&
              !error &&
              data.rows.map((row) => (
                <tr
                  key={keyField(row)}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    'border-b border-border last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-surface-sunken',
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-3 py-2.5 text-text-primary',
                        col.align === 'right' && 'text-right tabular-nums',
                        col.align === 'center' && 'text-center',
                      )}
                    >
                      {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {!loading && !error && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-secondary">
          <span>{t('table.showingRows', { from: showingFrom, to: showingTo, total: data.total })}</span>
          <div className="flex items-center gap-3">
            {onPageSizeChange && (
              <Select
                value={String(data.pageSize)}
                onValueChange={(v) => onPageSizeChange(Number(v))}
                options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
                size="sm"
                wrapperClassName="w-20"
              />
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => onPageChange?.(data.page - 1)}
                aria-label={t('common.back')}
                className="rounded p-1.5 hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span>{t('table.pageInfo', { page: data.page, totalPages })}</span>
              <button
                type="button"
                disabled={data.page >= totalPages}
                onClick={() => onPageChange?.(data.page + 1)}
                aria-label={t('common.next')}
                className="rounded p-1.5 hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
