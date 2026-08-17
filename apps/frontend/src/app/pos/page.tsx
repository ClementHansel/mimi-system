'use client';

import { useEffect, useState } from 'react';
import { Undo2, AlertTriangle } from 'lucide-react';
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
import { OnlineOrderForm } from '@/components/pos/OnlineOrderForm';
import { ShiftPanel } from '@/components/pos/ShiftPanel';
import { usePosShell } from '@/components/pos/PosShellContext';
import { PosLocationPicker } from '@/components/pos/PosLocationPicker';
import { loadCatalog } from '@/components/pos/pos-runtime';
import { usePosCartStore } from '@/components/pos/cart-store';
import { usePosShiftStore } from '@/components/pos/shift-store';
import { useSessionStore } from '@/stores/session-store';
import type { PosCatalog } from '@/components/pos/types';

/**
 * POS (F02) — the cashier's tablet. See `docs/CONTRACTS.md` §4.13 and
 * `docs/SYNC-PROTOCOL.md` §8 rows 1-3, 16-17 for the contract this screen
 * implements; `src/components/pos/*` holds every piece, this file only
 * wires them to the runtime and gates by shift state.
 *
 * F-POS-2: POS is now a standalone full-screen app — `app/pos/layout.tsx`
 * supplies the top bar/tab nav/branch line (`PosTopBar`/`PosStatusBar`), and
 * this file supplies the matching `<TabsContent>` panels once an outlet is
 * resolved and a shift is open. `actor`/`posLocation` come from
 * `usePosShell()` (a context the layout also reads) instead of calling
 * `useActorMeta()`/`usePosLocation()` again here — one resolution, shared,
 * so the header and this page can never disagree about which outlet is
 * active or race each other's `/locations` fetch.
 */
export default function PosPage() {
  const { t } = useI18n();
  const { actor, posLocation } = usePosShell();
  const kasirName = useSessionStore((s) => s.user?.name ?? '');
  const currentShift = usePosShiftStore((s) => s.current);
  const cartLines = usePosCartStore((s) => s.lines);
  const saleDiscount = usePosCartStore((s) => s.saleDiscount);
  const setSaleDiscount = usePosCartStore((s) => s.setSaleDiscount);
  const addProduct = usePosCartStore((s) => s.addProduct);

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState(false);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [catalog, setCatalog] = useState<PosCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);

  useEffect(() => {
    setRuntimeError(false);
    getBrowserLocalRuntime()
      .then(setRuntime)
      .catch(() => setRuntimeError(true));
  }, [runtimeAttempt]);

  const location = posLocation.status === 'ready' ? posLocation.location : null;

  useEffect(() => {
    if (!location) return;
    loadCatalog(location.id)
      .then(setCatalog)
      .catch(() => setCatalogError(true));
  }, [location]);

  const summary = calculateCartSummary(
    cartLines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice, qty: l.qty, discount: l.discount })),
    saleDiscount,
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
    return <div className="flex min-h-[40vh] items-center justify-center text-text-muted">{t('common.loading')}</div>;
  }

  if (runtimeError) {
    return (
      <EmptyState
        size="lg"
        icon={AlertTriangle}
        title={t('pos.runtimeLoadFailedTitle')}
        description={t('pos.runtimeLoadFailedDescription')}
        action={<Button onClick={() => setRuntimeAttempt((a) => a + 1)}>{t('common.retry')}</Button>}
      />
    );
  }

  if (!runtime || !location) {
    return <div className="flex min-h-[40vh] items-center justify-center text-text-muted">{t('common.loading')}</div>;
  }

  if (!currentShift) {
    return <ShiftOpenForm runtime={runtime} actor={actor} locationId={location.id} kasirName={kasirName} />;
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
              onAdd={(p) => addProduct({ productId: p.id, productName: p.name, unitPrice: p.price })}
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
            <Cart lines={cartLines} summary={summary} saleDiscount={saleDiscount} onSaleDiscountChange={setSaleDiscount} />
            <Button size="touch-lg" fullWidth disabled={cartLines.length === 0} onClick={() => setPayOpen(true)}>
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
          </div>
        </div>
      </TabsContent>

      <TabsContent value="online" className="pt-0">
        <OnlineOrderForm runtime={runtime} actor={actor} locationId={location.id} />
      </TabsContent>

      <TabsContent value="shift" className="pt-0">
        <ShiftPanel runtime={runtime} actor={actor} shift={currentShift} />
      </TabsContent>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title={t('pos.paymentTitle')} size="sm">
        <PaymentPanel
          runtime={runtime}
          actor={actor}
          shift={currentShift}
          locationId={location.id}
          locationName={location.name}
          summary={summary}
          onCompleted={(saleId) => {
            setLastSaleId(saleId);
            setPayOpen(false);
          }}
        />
      </Modal>

      {voidOpen && lastSaleId && (
        <VoidRefundModal open={voidOpen} onClose={() => setVoidOpen(false)} runtime={runtime} actor={actor} saleId={lastSaleId} />
      )}
    </>
  );
}
