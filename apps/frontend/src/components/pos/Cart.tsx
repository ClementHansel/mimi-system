'use client';

import { Minus, Plus, Trash2, ShoppingCart, Ticket } from 'lucide-react';
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
  // Read straight from the store rather than via a prop: `appliedVoucher` is
  // applied/removed from `PaymentPanel` (inside the payment modal), and this
  // component only ever displays it — the same "derive, don't thread" split
  // `summary` already follows for the rest of the cart's numbers.
  const appliedVoucher = usePosCartStore((s) => s.appliedVoucher);

  function step(productId: string, currentQty: string, delta: number) {
    const next = Math.max(0, parseFloat(currentQty) + delta);
    setQty(productId, next === 0 ? '0' : next.toString());
  }

  if (lines.length === 0) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title={t('pos.cartEmptyTitle')}
        description={t('pos.cartEmptyDescription')}
      />
    );
  }

  const lineTotalsById = new Map(summary.lines.map((l) => [l.productId, l.lineTotal]));

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex-1 overflow-y-auto">
        <ul className="flex flex-col divide-y divide-border">
          {lines.map((line) => (
            /*
              TWO ROWS PER LINE, BECAUSE ONE DOES NOT FIT.
              MA-192: "Nama dan harga item terpotong dan overlapping di cart
              POS". Arithmetic, not styling taste. The cart is a fixed
              `360px` column (`app/pos/page.tsx`'s
              `lg:grid-cols-[1fr_360px]`) with `p-4`, so 328px of content —
              and this row's FIXED columns claimed 296px of it: the stepper
              (44 + 6 + 40 + 6 + 44 = 140), the line total (`w-24` = 96), the
              delete button (`size-9` = 36) and three `gap-2`s (24). That left
              32px for `flex-1`, which truncated every product name to a
              character or two, and the unit price underneath it carried no
              truncation at all — so it spilled sideways under the stepper.
              Exactly the overlap in the screenshot.
              Name on its own row, priced line beneath it: nothing competes
              for width with a product name any more, and the name can use two
              lines (`line-clamp-2`, as `ProductGrid` already does for the
              same reason) instead of being cut mid-word.
            */
            <li key={line.productId} className="flex flex-col gap-2 py-3">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 line-clamp-2 font-medium leading-snug text-text-primary">
                  {line.productName}
                </p>
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  disabled={disabled}
                  onClick={() => removeLine(line.productId)}
                  className="-mr-1 flex size-8 flex-none items-center justify-center rounded-md text-danger-600 hover:bg-danger-50 disabled:opacity-40"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex flex-none items-center gap-1.5">
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
                {/* Unit price above the line total, right-aligned and free to
                    size itself — no `w-24` cap, which is what made a
                    six-figure rupiah total clip. */}
                <div className="min-w-0 flex-1 text-right leading-tight">
                  <span className="block text-xs text-text-muted tabular-nums">
                    {formatMoney(line.unitPrice)}
                  </span>
                  <span className="block font-medium tabular-nums text-text-primary">
                    {formatMoney(lineTotalsById.get(line.productId) ?? '0.00')}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="flex items-center justify-between text-sm text-text-muted">
          <span>
            {t('common.total')} ({t('pos.subtotal')})
          </span>
          <span className="tabular-nums">{formatMoney(summary.subtotal)}</span>
        </div>
        <MoneyInput
          label={t('pos.saleDiscount')}
          value={saleDiscount === '0.00' ? null : saleDiscount}
          onChange={(v) => onSaleDiscountChange(v ?? ('0.00' as Money))}
          disabled={disabled}
          size="sm"
        />
        {/* The voucher's own line, visually distinct from the manual
            `saleDiscount` field above it — a coupon is a server-decided,
            code-attached figure, not something typed on this screen, and
            keeping it out of the `MoneyInput` (rather than summing it in) is
            exactly what makes "Hapus Voucher" in `VoucherEntry` able to
            remove only its own amount. See `cart-store.ts`'s
            `appliedVoucher` doc for why the two are never merged. */}
        {appliedVoucher && (
          <div className="flex items-center justify-between text-sm text-brand-700">
            <span className="flex items-center gap-1">
              <Ticket className="size-3.5" aria-hidden />
              {appliedVoucher.code}
            </span>
            <span className="tabular-nums">-{formatMoney(appliedVoucher.discount)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-lg font-semibold text-text-primary">
          <span>{t('common.total')}</span>
          <span className="tabular-nums">{formatMoney(summary.total)}</span>
        </div>
      </div>
    </div>
  );
}
