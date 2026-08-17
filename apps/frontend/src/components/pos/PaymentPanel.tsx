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
import { mintClientId } from './pos-runtime';
import { usePosCartStore } from './cart-store';
import { usePosShiftStore, type OpenShift } from './shift-store';
import { printReceipt, buildReceiptText } from './receipt-printer';
import type { PosPaymentMethod } from './types';

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
  onCompleted,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  shift: OpenShift;
  locationId: UUID;
  locationName: string;
  summary: CartSummary;
  onCompleted: (saleId: string) => void;
}) {
  const { t } = useI18n();
  const lines = usePosCartStore((s) => s.lines);
  const saleDiscount = usePosCartStore((s) => s.saleDiscount);
  const clearCart = usePosCartStore((s) => s.clear);
  const recordSale = usePosShiftStore((s) => s.recordSale);

  const [method, setMethod] = useState<PosPaymentMethod>('cash');
  const [cashReceived, setCashReceived] = useState<Money | null>(null);
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saleId] = useState<string>(() => mintClientId());

  const amount = method === 'cash' ? cashReceived : summary.total;
  const change = method === 'cash' && cashReceived ? calculateChange(cashReceived, summary.total) : ZERO_MONEY;
  const insufficientCash = method === 'cash' && (!cashReceived || compareMoney(cashReceived, summary.total) < 0);
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
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })),
        payments: [{ method, amount, reference: reference || null }],
        discount: saleDiscount,
      };

      await runtime.commitSale({ saleId, data: saleData, actor });

      recordSale({ total: summary.total, cashPortion: method === 'cash' ? summary.total : ZERO_MONEY });

      const receiptData = {
        outletName: locationName,
        receiptNumber: saleId.slice(0, 8).toUpperCase(),
        kasirName: shift.kasirName,
        occurredAt,
        lines: summary.lines.map((l, i) => ({ productName: lines[i]?.productName ?? l.productId, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
        subtotal: summary.subtotal,
        discount: summary.discount,
        total: summary.total,
        paidAmount: amount,
        changeAmount: change,
        paymentMethodLabel: t(METHOD_META[method].labelKey),
        paperWidth: 58 as const,
      };
      const printResult = await printReceipt(receiptData);
      if (!printResult.ok) {
        toast({ title: t('pos.printUnavailable'), description: buildReceiptText(receiptData).slice(0, 120), variant: 'warning' });
      }

      toast({ title: t('pos.saleCompletedTitle'), variant: 'success' });
      clearCart();
      onCompleted(saleId);
    } catch (err) {
      toast({ title: t('pos.saleFailed'), description: err instanceof Error ? err.message : undefined, variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(METHOD_META) as PosPaymentMethod[]).map((m) => {
          const Icon = METHOD_META[m].icon;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={`flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-lg border-2 p-3 text-sm font-medium transition-colors ${
                method === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-border-strong text-text-secondary'
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
      {method === 'qris' && (
        <p className="text-sm text-text-muted">{t('pos.qrisSettleNote')}</p>
      )}

      {method === 'cash' ? (
        <>
          <MoneyInput label={t('pos.cashReceived')} value={cashReceived} onChange={setCashReceived} size="touch" required />
          <div className="flex items-center justify-between text-lg font-semibold">
            <span>{t('pos.change')}</span>
            <span className="tabular-nums">{formatMoney(change)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>{t('pos.amountDue')}</span>
            <span className="tabular-nums font-semibold text-text-primary">{formatMoney(summary.total)}</span>
          </div>
          <Input
            label={t('pos.paymentReference')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t('pos.paymentReferencePlaceholder')}
          />
        </>
      )}

      <Button size="touch-lg" fullWidth leftIcon={<Printer className="size-5" />} loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
        {t('pos.completeSale')}
      </Button>
    </div>
  );
}
