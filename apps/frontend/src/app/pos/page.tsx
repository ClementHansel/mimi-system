'use client';

import { useEffect, useState } from 'react';
import { LockKeyhole, Undo2, ShoppingBag, Store } from 'lucide-react';
import { calculateCartSummary } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { Button, Tabs, TabsList, TabsTrigger, TabsContent, Modal } from '@/components/ui';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import { PosStatusBar } from '@/components/pos/PosStatusBar';
import { ShiftOpenForm } from '@/components/pos/ShiftOpenForm';
import { ShiftCloseModal } from '@/components/pos/ShiftCloseModal';
import { ProductGrid } from '@/components/pos/ProductGrid';
import { Cart } from '@/components/pos/Cart';
import { PaymentPanel } from '@/components/pos/PaymentPanel';
import { VoidRefundModal } from '@/components/pos/VoidRefundModal';
import { OnlineOrderForm } from '@/components/pos/OnlineOrderForm';
import { useSessionStore } from '@/stores/session-store';
import { useActorMeta, usePosLocation, loadCatalog } from '@/components/pos/pos-runtime';
import { usePosCartStore } from '@/components/pos/cart-store';
import { usePosShiftStore } from '@/components/pos/shift-store';
import type { PosCatalog } from '@/components/pos/types';

/**
 * POS (F02) — the cashier's tablet. See `docs/CONTRACTS.md` §4.13 and
 * `docs/SYNC-PROTOCOL.md` §8 rows 1-3, 16-17 for the contract this screen
 * implements; `src/components/pos/*` holds every piece, this file only
 * wires them to the runtime and gates by shift state.
 */
export default function PosPage() {
  const { t } = useI18n();
  const actor = useActorMeta();
  const location = usePosLocation();
  const kasirName = useSessionStore((s) => s.user?.name ?? '');
  const currentShift = usePosShiftStore((s) => s.current);
  const cartLines = usePosCartStore((s) => s.lines);
  const saleDiscount = usePosCartStore((s) => s.saleDiscount);
  const setSaleDiscount = usePosCartStore((s) => s.setSaleDiscount);
  const addProduct = usePosCartStore((s) => s.addProduct);

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [catalog, setCatalog] = useState<PosCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);

  useEffect(() => {
    getBrowserLocalRuntime().then(setRuntime);
  }, []);

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

  if (!actor || !location) {
    return <div className="flex min-h-[40vh] items-center justify-center text-text-muted">{t('common.loading')}</div>;
  }

  if (!runtime) {
    return <div className="flex min-h-[40vh] items-center justify-center text-text-muted">{t('common.loading')}</div>;
  }

  if (!currentShift) {
    return <ShiftOpenForm runtime={runtime} actor={actor} locationId={location.id} kasirName={kasirName} />;
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <PosStatusBar locationName={location.name} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs defaultValue="kasir">
          <TabsList>
            <TabsTrigger value="kasir">
              <span className="flex items-center gap-1.5"><Store className="size-4" aria-hidden />{t('pos.tabKasir')}</span>
            </TabsTrigger>
            <TabsTrigger value="online">
              <span className="flex items-center gap-1.5"><ShoppingBag className="size-4" aria-hidden />{t('pos.tabOnlineOrder')}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="kasir">
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
              </div>
            </div>
          </TabsContent>

          <TabsContent value="online">
            <OnlineOrderForm runtime={runtime} actor={actor} locationId={location.id} />
          </TabsContent>
        </Tabs>
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Button variant="outline" leftIcon={<Undo2 className="size-4" />} onClick={() => setVoidOpen(true)} disabled={!lastSaleId}>
          {t('pos.voidLastSale')}
        </Button>
        <Button variant="outline" leftIcon={<LockKeyhole className="size-4" />} onClick={() => setCloseShiftOpen(true)}>
          {t('pos.closeShift')}
        </Button>
      </div>

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

      <ShiftCloseModal open={closeShiftOpen} onClose={() => setCloseShiftOpen(false)} runtime={runtime} actor={actor} shift={currentShift} />

      {voidOpen && lastSaleId && (
        <VoidRefundModal open={voidOpen} onClose={() => setVoidOpen(false)} runtime={runtime} actor={actor} saleId={lastSaleId} />
      )}
    </div>
  );
}
