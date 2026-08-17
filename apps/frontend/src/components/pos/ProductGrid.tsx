'use client';

import { useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/formatters';
import { Button, EmptyState } from '@/components/ui';
import type { PosProduct } from './types';

/**
 * The sale-entry product grid (FR-POS-01) — "built for speed and fat
 * fingers, not density": large touch targets (`--spacing-touch-lg`), one tap
 * per add, category filter as a horizontal chip row rather than a dropdown
 * (fewer taps, always visible).
 */
export function ProductGrid({
  products,
  categories,
  onAdd,
}: {
  products: PosProduct[];
  categories: string[];
  onAdd: (p: PosProduct) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<string>('all');

  const visible = useMemo(
    () => products.filter((p) => p.isActive && (category === 'all' || p.category === category)),
    [products, category],
  );

  if (products.length === 0) {
    return <EmptyState icon={Package} title={t('pos.catalogEmptyTitle')} description={t('pos.catalogEmptyDescription')} size="lg" />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('pos.categoryFilter')}>
        <Button size="sm" variant={category === 'all' ? 'primary' : 'outline'} onClick={() => setCategory('all')}>
          {t('common.all')}
        </Button>
        {categories.map((c) => (
          <Button key={c} size="sm" variant={category === c ? 'primary' : 'outline'} onClick={() => setCategory(c)}>
            {c}
          </Button>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
        {visible.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onAdd(p)}
            className="flex min-h-touch-lg flex-col items-start gap-1 rounded-lg border border-border-strong bg-surface-raised p-3 text-left shadow-xs transition-colors hover:border-brand-500 hover:bg-brand-50 active:bg-brand-100"
          >
            <span className="line-clamp-2 font-medium text-text-primary">{p.name}</span>
            <span className="mt-auto text-sm font-semibold tabular-nums text-brand-700">{formatMoney(p.price)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
