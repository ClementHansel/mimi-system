'use client';

import { Minus, Plus, Trash2, ShoppingCart } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/formatters';
import { MoneyInput, EmptyState } from '@/components/ui';
import type { Money } from '@/lib/shared-types';
import type { CartSummary } from '@mimi/shared';
import type { PosCartLine } from './types';
import { usePosCartStore } from './cart-store';

/**
 * The running cart (FR-POS-01/04). `summary` is always the caller-computed
 * `@mimi/shared` `CartSummary` (see `cart-store.ts`'s `summarizeCart`) — this
 * component never re-derives a total itself, only renders one. `lines` is
 * the raw draft (carries `productName`, which the pure calculator's
 * `CartLineResult` doesn't) — zipped with `summary.lines` by `productId` for
 * the computed `lineTotal`.
 */
export function Cart({
  lines,
  summary,
  saleDiscount,
  onSaleDiscountChange,
  disabled,
}: {
  lines: PosCartLine[];
  summary: CartSummary;
  saleDiscount: Money;
  onSaleDiscountChange: (v: Money) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const setQty = usePosCartStore((s) => s.setQty);
  const removeLine = usePosCartStore((s) => s.removeLine);

  function step(productId: string, currentQty: string, delta: number) {
    const next = Math.max(0, parseFloat(currentQty) + delta);
    setQty(productId, next === 0 ? '0' : next.toString());
  }

  if (lines.length === 0) {
    return <EmptyState icon={ShoppingCart} title={t('pos.cartEmptyTitle')} description={t('pos.cartEmptyDescription')} />;
  }

  const lineTotalsById = new Map(summary.lines.map((l) => [l.productId, l.lineTotal]));

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex-1 overflow-y-auto">
        <ul className="flex flex-col divide-y divide-border">
          {lines.map((line) => (
            <li key={line.productId} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-text-primary">{line.productName}</p>
                <p className="text-sm text-text-muted tabular-nums">{formatMoney(line.unitPrice)}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t('pos.decreaseQty')}
                  disabled={disabled}
                  onClick={() => step(line.productId, line.qty, -1)}
                  className="flex size-touch items-center justify-center rounded-md border border-border-strong text-text-primary disabled:opacity-40"
                >
                  <Minus className="size-4" aria-hidden />
                </button>
                <span className="w-10 text-center tabular-nums">{line.qty}</span>
                <button
                  type="button"
                  aria-label={t('pos.increaseQty')}
                  disabled={disabled}
                  onClick={() => step(line.productId, line.qty, 1)}
                  className="flex size-touch items-center justify-center rounded-md border border-border-strong text-text-primary disabled:opacity-40"
                >
                  <Plus className="size-4" aria-hidden />
                </button>
              </div>
              <span className="w-24 text-right font-medium tabular-nums text-text-primary">
                {formatMoney(lineTotalsById.get(line.productId) ?? '0.00')}
              </span>
              <button
                type="button"
                aria-label={t('common.delete')}
                disabled={disabled}
                onClick={() => removeLine(line.productId)}
                className="flex size-9 items-center justify-center rounded-md text-danger-600 hover:bg-danger-50 disabled:opacity-40"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between text-sm text-text-muted">
          <span>{t('common.total')} ({t('pos.subtotal')})</span>
          <span className="tabular-nums">{formatMoney(summary.subtotal)}</span>
        </div>
        <MoneyInput
          label={t('pos.saleDiscount')}
          value={saleDiscount === '0.00' ? null : saleDiscount}
          onChange={(v) => onSaleDiscountChange(v ?? ('0.00' as Money))}
          disabled={disabled}
          size="sm"
        />
        <div className="flex items-center justify-between text-lg font-semibold text-text-primary">
          <span>{t('common.total')}</span>
          <span className="tabular-nums">{formatMoney(summary.total)}</span>
        </div>
      </div>
    </div>
  );
}
