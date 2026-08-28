'use client';

import { useState } from 'react';
import { Banknote, QrCode, Landmark, Printer } from 'lucide-react';
import { calculateChange, compareMoney, ZERO_MONEY } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/formatters';
import { Button, MoneyInput, Input, StatusBadge } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money, UUID } from '@/lib/shared-types';
import type { CartSummary } from '@mimi/shared';
import { usePermissions } from '@/lib/permissions';
import { mintClientId } from './pos-runtime';
import { usePosCartStore } from './cart-store';
import { usePosShiftStore, type OpenShift } from './shift-store';
import { printReceipt, buildReceiptText } from './receipt-printer';
import { CHANNEL_META } from './channel-meta';
import { VoucherEntry } from './VoucherEntry';
import type { PosChannel, PosPaymentMethod } from './types';

const METHOD_META: Record<PosPaymentMethod, { icon: typeof Banknote; labelKey: string }> = {
  cash: { icon: Banknote, labelKey: 'pos.paymentCash' },
  qris: { icon: QrCode, labelKey: 'pos.paymentQris' },
  bank_transfer: { icon: Landmark, labelKey: 'pos.paymentTransfer' },
};

/** Maps device-side capture to the same status the online endpoint assigns (CONTRACTS §4.13): cash→paid, qris→verified, transfer→pending. Never shown as more final than that — the brief: "transfer stays pending until Finance verifies and the UI must not imply otherwise." */
function statusForMethod(method: PosPaymentMethod): 'paid' | 'verified' | 'pending' {
  if (method === 'cash') return 'paid';
  if (method === 'qris') return 'verified';
  return 'pending';
}

export function PaymentPanel({
  runtime,
  actor,
  shift,
  locationId,
  locationName,
  summary,
  channel,
  onCompleted,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  shift: OpenShift;
  locationId: UUID;
  locationName: string;
  summary: CartSummary;
  /** F-POS-3 — which channel this sale rings into; must reach BOTH the committed sale fact and the printed receipt (see the contract note on `handleSubmit` below). */
  channel: PosChannel;
  onCompleted: (saleId: string) => void;
}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const lines = usePosCartStore((s) => s.lines);
  const saleDiscount = usePosCartStore((s) => s.saleDiscount);
  const appliedVoucher = usePosCartStore((s) => s.appliedVoucher);
  const setAppliedVoucher = usePosCartStore((s) => s.setAppliedVoucher);
  const clearCart = usePosCartStore((s) => s.clear);
  const recordSale = usePosShiftStore((s) => s.recordSale);

  const [method, setMethod] = useState<PosPaymentMethod>('cash');
  const [cashReceived, setCashReceived] = useState<Money | null>(null);
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saleId] = useState<string>(() => mintClientId());

  const amount = method === 'cash' ? cashReceived : summary.total;
  const change =
    method === 'cash' && cashReceived ? calculateChange(cashReceived, summary.total) : ZERO_MONEY;
  const insufficientCash =
    method === 'cash' && (!cashReceived || compareMoney(cashReceived, summary.total) < 0);
  const canSubmit = summary.lines.length > 0 && !insufficientCash && !submitting;

  async function handleSubmit() {
    if (!amount) return;
    setSubmitting(true);
    try {
      const occurredAt = new Date().toISOString();
      const saleData = {
        clientId: saleId,
        shiftId: shift.shiftId,
        locationId,
        occurredAt,
        // F-POS-3 — `channel` rides in the COMMITTED FACT, not just this
        // screen's UI state (CONTRACTS: `channel: 'walk_in'|'gofood'|
        // 'shopeefood'` on sale creation). `commitSale`'s `data` is opaque
        // to `LocalRuntime` (`unknown`, see `local-runtime.ts`) and goes
        // straight into the offline outbox exactly as built here — so an
        // offline GoFood sale carries its channel through reconnect and
        // sync, and never lands on the server re-labelled walk-in just
        // because nothing but a React state variable remembered it.
        channel,
        lines: lines.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
        payments: [{ method, amount, reference: reference || null }],
        discount: saleDiscount,
        // Carried the same way `channel` is, and for the same reason: an
        // offline sale sits in the local outbox until it syncs, and by then
        // the cashier's screen and this closure are both long gone — the
        // ONLY place the voucher's code survives to reach the server is
        // inside this committed fact. Without it, an offline redemption
        // would apply the discount on the receipt the customer walked away
        // with but never mark the coupon as spent server-side, leaving it
        // usable again at the next till. `discount` here is the till's own
        // PREVIEW figure (from `/vouchers/check`, potentially against a
        // subtotal that has since moved) — the server recomputes and is
        // authoritative when it processes the synced sale, exactly as
        // `VoucherEntry`'s preview note tells the cashier.
        //
        // THE SHAPE IS EXACTLY `{ code, discount, offlineAccepted }` and the
        // voucher amount is deliberately NOT folded into `discount` above.
        // `discount` is the SALE-LEVEL discount the cashier typed; the server
        // adds the coupon itself from `voucher.code` when the sale lands
        // (documented on `CreateSaleDto.discount` and on the `sales.completed`
        // sync schema). Folding the coupon in here would discount the customer
        // twice — once by the till, once by the server — and the second one
        // would be invisible until somebody reconciled the ledger.
        //
        // `offlineAccepted` is ALWAYS false from this screen, and that is a
        // statement about what this till can do rather than a placeholder: a
        // voucher only becomes `appliedVoucher` after `/vouchers/check`
        // ANSWERED, which requires the network. There is no offline redemption
        // path here, which matches `DEFAULT_VOUCHER_OFFLINE_POLICY`'s
        // `'reject'` — an offline till cannot know the coupon was not already
        // spent at the next outlet an hour ago (see the shared voucher
        // module's header). If `pos.voucher_offline` is ever set to `accept`,
        // THIS is the field that has to start being true, and the sale that
        // carries it is what turns a double-spend into a reconciliation
        // exception rather than silent lost margin.
        voucher: appliedVoucher
          ? {
              code: appliedVoucher.code,
              discount: appliedVoucher.discount,
              offlineAccepted: false,
            }
          : null,
      };

      await runtime.commitSale({ saleId, data: saleData, actor });

      recordSale({
        total: summary.total,
        cashPortion: method === 'cash' ? summary.total : ZERO_MONEY,
      });

      const receiptData = {
        outletName: locationName,
        receiptNumber: saleId.slice(0, 8).toUpperCase(),
        kasirName: shift.kasirName,
        occurredAt,
        // F-POS-3 — printed on every receipt (owner's requirement: "the choice
        // must be visible on the payment screen and the receipt") so a
        // GoFood/ShopeeFood order stapled to a delivery bag is unmistakable
        // from a walk-in one, and a mispriced sale is traceable after the
        // fact.
        channelLabel: t(CHANNEL_META[channel].labelKey),
        lines: summary.lines.map((l, i) => ({
          productName: lines[i]?.productName ?? l.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        subtotal: summary.subtotal,
        discount: summary.discount,
        voucherCode: appliedVoucher?.code ?? null,
        voucherDiscount: appliedVoucher?.discount ?? null,
        total: summary.total,
        paidAmount: amount,
        changeAmount: change,
        paymentMethodLabel: t(METHOD_META[method].labelKey),
        paperWidth: 58 as const,
      };
      const printResult = await printReceipt(receiptData);
      if (!printResult.ok) {
        toast({
          title: t('pos.printUnavailable'),
          description: buildReceiptText(receiptData).slice(0, 120),
          variant: 'warning',
        });
      }

      toast({ title: t('pos.saleCompletedTitle'), variant: 'success' });
      clearCart();
      onCompleted(saleId);
    } catch (err) {
      toast({
        title: t('pos.saleFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  const activeChannelMeta = CHANNEL_META[channel];
  const ChannelIcon = activeChannelMeta.icon;

  return (
    <div className="flex flex-col gap-4">
      {/* F-POS-3 — "the choice must be visible on the payment screen": the
          last thing a cashier sees before tapping "Selesaikan" restates
          which channel this sale is charging at, in the same colour as the
          toggle it came from. Not editable here — channel belongs to the
          till (`PosTopBar`), not to a single payment attempt. */}
      <div
        className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${activeChannelMeta.badgeClass}`}
      >
        <ChannelIcon className="size-4" aria-hidden />
        {t('pos.channelActiveLabel', { channel: t(activeChannelMeta.labelKey) })}
      </div>

      {/*
          `can('voucher.redeem')` is a UI-visibility check only, same as
          every other `can()` gate in this codebase (see `permissions.ts`'s
          header) — it hides the entry field from a role that has no reason
          to see it, it is not the enforcement boundary. The server's own
          `voucher.redeem` check on `/vouchers/check` (and again wherever the
          synced sale is finally processed) is what actually stops a
          redemption; hiding this component changes nothing about what a
          crafted request against the API could do.
      */}
      {can('voucher.redeem') && (
        <VoucherEntry
          subtotal={summary.subtotal}
          locationId={locationId}
          applied={appliedVoucher}
          onApplied={setAppliedVoucher}
        />
      )}

      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(METHOD_META) as PosPaymentMethod[]).map((m) => {
          const Icon = METHOD_META[m].icon;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={`flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-lg border-2 p-3 text-sm font-medium transition-colors ${
                method === m
                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                  : 'border-border-strong text-text-secondary'
              }`}
            >
              <Icon className="size-5" aria-hidden />
              {t(METHOD_META[m].labelKey)}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-md bg-surface-sunken p-3">
        <span className="text-sm text-text-muted">{t('pos.paymentStatusLabel')}</span>
        <StatusBadge domain="payment" status={statusForMethod(method)} />
      </div>
      {method === 'bank_transfer' && (
        <p className="text-sm text-warning-700">{t('pos.transferPendingNote')}</p>
      )}
      {method === 'qris' && <p className="text-sm text-text-muted">{t('pos.qrisSettleNote')}</p>}

      {method === 'cash' ? (
        <>
          <MoneyInput
            label={t('pos.cashReceived')}
            value={cashReceived}
            onChange={setCashReceived}
            size="touch"
            required
          />
          <div className="flex items-center justify-between text-lg font-semibold">
            <span>{t('pos.change')}</span>
            <span className="tabular-nums">{formatMoney(change)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>{t('pos.amountDue')}</span>
            <span className="tabular-nums font-semibold text-text-primary">
              {formatMoney(summary.total)}
            </span>
          </div>
          <Input
            label={t('pos.paymentReference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t('pos.paymentReferencePlaceholder')}
          />
        </>
      )}

      <Button
        size="touch-lg"
        fullWidth
        leftIcon={<Printer className="size-5" />}
        loading={submitting}
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        {t('pos.completeSale')}
      </Button>
    </div>
  );
}
