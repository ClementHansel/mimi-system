'use client';

import { useEffect, useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/formatters';
import { Button, EmptyState } from '@/components/ui';
import type { PosChannel, PosProduct } from './types';
import { priceForChannel } from './channel-pricing';
import { getProductPhotoUrl } from './product-photo-cache';

/**
 * The sale-entry product grid (FR-POS-01) — "built for speed and fat
 * fingers, not density": large touch targets (`--spacing-touch-lg`), one tap
 * per add, category filter as a horizontal chip row rather than a dropdown
 * (fewer taps, always visible).
 *
 * F-POS-3: the price on every tile is `priceForChannel(product, channel)`,
 * never `product.price` directly — a cashier reads the price off THIS
 * screen before tapping, so the tile is where a stale walk-in price would
 * first be noticed (or, worse, not noticed).
 */
export function ProductGrid({
  products,
  categories,
  channel,
  onAdd,
}: {
  products: PosProduct[];
  categories: string[];
  channel: PosChannel;
  onAdd: (p: PosProduct) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<string>('all');

  const visible = useMemo(
    () => products.filter((p) => p.isActive && (category === 'all' || p.category === category)),
    [products, category],
  );

  if (products.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title={t('pos.catalogEmptyTitle')}
        description={t('pos.catalogEmptyDescription')}
        size="lg"
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('pos.categoryFilter')}>
        <Button
          size="sm"
          variant={category === 'all' ? 'primary' : 'outline'}
          onClick={() => setCategory('all')}
        >
          {t('common.all')}
        </Button>
        {categories.map((c) => (
          <Button
            key={c}
            size="sm"
            variant={category === c ? 'primary' : 'outline'}
            onClick={() => setCategory(c)}
          >
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
            <ProductTileImage product={p} />
            <span className="line-clamp-2 font-medium text-text-primary">{p.name}</span>
            {/* What is inside a bundle, so the cashier can answer "what do I get
                with that?" without leaving the sale screen. One line, truncated:
                the tile is a touch target during a queue, not a spec sheet. */}
            {p.kind === 'package' && (p.packageLines?.length ?? 0) > 0 && (
              <span className="line-clamp-1 text-xs text-text-secondary">
                {p.packageLines!.map((l) => l.memberName).join(' + ')}
              </span>
            )}
            <span className="mt-auto text-sm font-semibold tabular-nums text-brand-700">
              {formatMoney(priceForChannel(p, channel))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A menu photo on a tile, resolved from the offline photo cache.
 *
 * Renders NOTHING (not a spinner, not a grey box) while resolving and falls back
 * to an icon when there is no photo: the grid is the sale-entry surface, so a
 * tile must never change height or shift position under a cashier's finger
 * mid-tap. The image box is a fixed aspect ratio for the same reason.
 */
function ProductTileImage({ product }: { product: PosProduct }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!product.photoPath) {
      setUrl(null);
      return;
    }
    let alive = true;
    void getProductPhotoUrl(product.photoPath).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [product.photoPath]);

  return (
    <div className="mb-1 flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md bg-surface-2">
      {url ? (
        // A plain <img>: this src is a blob: url from the offline photo cache,
        // which next/image cannot serve.
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <Package className="size-6 text-text-tertiary" aria-hidden />
      )}
    </div>
  );
}
