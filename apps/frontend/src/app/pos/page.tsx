'use client';

import { useEffect, useState } from 'react';
import { Undo2, AlertTriangle, Printer } from 'lucide-react';
import { calculateCartSummary } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { Button, TabsContent, Modal, EmptyState } from '@/components/ui';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import { ShiftOpenForm } from '@/components/pos/ShiftOpenForm';
import { ProductGrid } from '@/components/pos/ProductGrid';
import { Cart } from '@/components/pos/Cart';
import { PaymentPanel } from '@/components/pos/PaymentPanel';
import { VoidRefundModal } from '@/components/pos/VoidRefundModal';
import { ShiftPanel } from '@/components/pos/ShiftPanel';
import { usePosShell } from '@/components/pos/PosShellContext';
import { PosLocationPicker } from '@/components/pos/PosLocationPicker';
import { releaseProductPhotoUrls } from '@/components/pos/product-photo-cache';
import { usePosCartStore, applyVoucherToSummary } from '@/components/pos/cart-store';
import { usePosShiftStore } from '@/components/pos/shift-store';
import { usePosChannelStore } from '@/components/pos/channel-store';
import { priceForChannel } from '@/components/pos/channel-pricing';
import { useSessionStore } from '@/stores/session-store';

/**
 * POS (F02) — the cashier's tablet. See `docs/CONTRACTS.md` §4.13 and
 * `docs/SYNC-PROTOCOL.md` §8 rows 1-3, 16-17 for the contract this screen
 * implements; `src/components/pos/*` holds every piece, this file only
 * wires them to the runtime and gates by shift state.
 *
 * F-POS-2: POS is now a standalone full-screen app — `app/pos/layout.tsx`
 * supplies the top bar/tab nav/branch line (`PosTopBar`/`PosStatusBar`), and
 * this file supplies the matching `<TabsContent>` panels once an outlet is
 * resolved and a shift is open. `actor`/`posLocation`/`catalog` come from
 * `usePosShell()` (a context the layout also reads) instead of calling
 * `useActorMeta()`/`usePosLocation()`/`loadCatalog()` again here — one
 * resolution, shared, so the header and this page can never disagree about
 * which outlet is active, which prices are on screen, or race each other's
 * `/locations`/`/pos/catalog` fetch.
 *
 * F-POS-3: GoFood/ShopeeFood are no longer a separate tab/form — they're a
 * CHANNEL of the same sale, toggled from `PosTopBar` (`ChannelToggle`,
 * global `usePosChannelStore`) and applied here to grid/cart pricing and to
 * the committed sale. See `channel-pricing.ts` for the null->walk-in
 * fallback and `ChannelToggle.tsx` for what happens when the channel is
 * switched mid-cart.
 */
export default function PosPage() {
  const { t } = useI18n();
  const { actor, posLocation, catalog, catalogError } = usePosShell();
  const kasirName = useSessionStore((s) => s.user?.name ?? '');
  const currentShift = usePosShiftStore((s) => s.current);
  const cartLines = usePosCartStore((s) => s.lines);
  const saleDiscount = usePosCartStore((s) => s.saleDiscount);
  const setSaleDiscount = usePosCartStore((s) => s.setSaleDiscount);
  const addProduct = usePosCartStore((s) => s.addProduct);
  const appliedVoucher = usePosCartStore((s) => s.appliedVoucher);
  const channel = usePosChannelStore((s) => s.channel);

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [voidOpen, setVoidOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  /**
   * D-26 (accepted for v1) — the ONLY sale this till can void is the last one
   * rung on this device, and only while the tab is alive: this is component
   * state, so a refresh clears it and the void button goes dead.
   *
   * There is no searchable sales history in v1, so a customer returning an
   * hour later, or after the browser reloaded, cannot be handled at the till
   * at all — that is a supervisor/finance correction, not a POS action.
   * Recorded here because the constraint lives in this one `useState` and is
   * invisible from anywhere else; the backend's void endpoint imposes no such
   * limit.
   */
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);

  useEffect(() => {
    setRuntimeError(false);
    getBrowserLocalRuntime()
      .then(setRuntime)
      .catch(() => setRuntimeError(true));
  }, [runtimeAttempt]);

  const location = posLocation.status === 'ready' ? posLocation.location : null;

  // Menu photos are resolved to `blob:` urls that live as long as this surface
  // does (the grid re-mounts tiles constantly as the cashier flicks between
  // categories, so revoking per tile would re-decode the same images every
  // time). They are released together when the till page goes away — the cached
  // BYTES survive in the Cache API, so a return visit costs no re-download.
  useEffect(() => releaseProductPhotoUrls, []);

  // `applyVoucherToSummary` composes the voucher's server-checked discount
  // ON TOP of the shared calculator's own total, rather than being folded
  // into `saleDiscount` — see that function's doc in `cart-store.ts` for why
  // (the short version: `@mimi/shared` is frozen for this ticket, and the
  // voucher must stay distinguishable from the cashier's own discount all
  // the way to the receipt and the sync payload).
  const summary = applyVoucherToSummary(
    calculateCartSummary(
      cartLines.map((l) => ({
        productId: l.productId,
        unitPrice: l.unitPrice,
        qty: l.qty,
        discount: l.discount,
      })),
      saleDiscount,
    ),
    appliedVoucher,
  );

  if (posLocation.status === 'error') {
    return (
      <EmptyState
        size="lg"
        icon={AlertTriangle}
        title={t('pos.outletLoadFailedTitle')}
        description={t('pos.outletLoadFailedDescription')}
        action={<Button onClick={posLocation.retry}>{t('common.retry')}</Button>}
      />
    );
  }

  if (posLocation.status === 'choose') {
    return <PosLocationPicker options={posLocation.options} onSelect={posLocation.select} />;
  }

  if (!actor || posLocation.status === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-text-muted">
        {t('common.loading')}
      </div>
    );
  }

  if (runtimeError) {
    return (
      <EmptyState
        size="lg"
        icon={AlertTriangle}
        title={t('pos.runtimeLoadFailedTitle')}
        description={t('pos.runtimeLoadFailedDescription')}
        action={
          <Button onClick={() => setRuntimeAttempt((a) => a + 1)}>{t('common.retry')}</Button>
        }
      />
    );
  }

  if (!runtime || !location) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-text-muted">
        {t('common.loading')}
      </div>
    );
  }

  if (!currentShift) {
    return (
      <ShiftOpenForm
        runtime={runtime}
        actor={actor}
        locationId={location.id}
        kasirName={kasirName}
      />
    );
  }

  return (
    <>
      <TabsContent value="kasir" className="pt-0">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <div className="min-h-[50vh]">
            {catalogError && !catalog && (
              <p className="mb-2 text-sm text-warning-700">{t('pos.catalogOfflineNote')}</p>
            )}
            <ProductGrid
              products={catalog?.products ?? []}
              categories={catalog?.categories ?? []}
              channel={channel}
              onAdd={(p) =>
                addProduct({
                  productId: p.id,
                  productName: p.name,
                  unitPrice: priceForChannel(p, channel),
                })
              }
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
            <Cart
              lines={cartLines}
              summary={summary}
              saleDiscount={saleDiscount}
              onSaleDiscountChange={setSaleDiscount}
            />
            <Button
              size="touch-lg"
              fullWidth
              disabled={cartLines.length === 0}
              onClick={() => setPayOpen(true)}
            >
              {t('pos.goToPayment')}
            </Button>
            <Button
              variant="outline"
              leftIcon={<Undo2 className="size-4" />}
              onClick={() => setVoidOpen(true)}
              disabled={!lastSaleId}
            >
              {t('pos.voidLastSale')}
            </Button>
            {/*
              `lastSaleId` is a CLIENT-MINTED id (`mintClientId()` in
              `pos-runtime.ts`) — the sale it names may not have reached the
              server yet (offline, or synced but not yet processed), so
              `/print/receipt/:saleId` (`getReceiptDocument`, `doc-api.ts`)
              can 404 while this till is still offline. That is expected, not
              a bug to guard against here: the print route already renders
              its own load-failure state for a missing document rather than a
              blank tab (see `app/print/receipt/[id]/page.tsx`), so a cashier
              who taps "Cetak" moments after an offline sale sees an honest
              "not available yet" instead of a stale/blank page, and can
              retry once the till reconnects and syncs. Same idiom as the
              Surat Jalan print link in `SuratJalanDetailDrawer.tsx` — an `<a
              target="_blank">` to the print route, not a fetch-then-render
              here.
            */}
            <a
              href={lastSaleId ? `/print/receipt/${lastSaleId}` : undefined}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!lastSaleId}
              onClick={(e) => {
                if (!lastSaleId) e.preventDefault();
              }}
            >
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Printer className="size-4" />}
                disabled={!lastSaleId}
              >
                {t('doc.print.receiptTitle')}
              </Button>
            </a>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="shift" className="pt-0">
        <ShiftPanel runtime={runtime} actor={actor} shift={currentShift} />
      </TabsContent>

      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title={t('pos.paymentTitle')}
        size="sm"
      >
        <PaymentPanel
          runtime={runtime}
          actor={actor}
          shift={currentShift}
          locationId={location.id}
          locationName={location.name}
          summary={summary}
          channel={channel}
          onCompleted={(saleId) => {
            setLastSaleId(saleId);
            setPayOpen(false);
          }}
        />
      </Modal>

      {voidOpen && lastSaleId && (
        <VoidRefundModal
          open={voidOpen}
          onClose={() => setVoidOpen(false)}
          runtime={runtime}
          actor={actor}
          saleId={lastSaleId}
        />
      )}
    </>
  );
}
