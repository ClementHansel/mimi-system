'use client';

import { useState } from 'react';
import { subMoney } from '@mimi/shared';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, MoneyInput, Textarea } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { toast } from '@/components/ui/Toast';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money } from '@/lib/shared-types';
import { usePosShiftStore, type OpenShift } from './shift-store';
import { apiErrorDetail } from '@/lib/api-error';

/**
 * "Tutup Kasir" (FR-POS-02). The counted-vs-expected comparison shown here
 * is a DEVICE-LOCAL ESTIMATE (`shift.cashCollected`, accumulated sale-by-sale
 * on this tablet) — the brief is explicit that on close we "show the cashier
 * what was counted vs expected without editorialising," and SYNC-PROTOCOL §8
 * row 16 is explicit that the real number is "recomputed at cloud (R7)": a
 * shortfall proposal (Amendment 2 `cash_variance_proposals`) is decided
 * server-side, never implied or pre-judged here. Copy says exactly that.
 */
export function ShiftCloseModal({
  open,
  onClose,
  runtime,
  actor,
  shift,
}: {
  open: boolean;
  onClose: () => void;
  runtime: LocalRuntime;
  actor: ActorMeta;
  shift: OpenShift;
}) {
  const { t } = useI18n();
  const [closingCash, setClosingCash] = useState<Money | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const closeShift = usePosShiftStore((s) => s.close);

  const localExpected = shift.cashCollected
    ? (parseFloat(shift.openingCash) + parseFloat(shift.cashCollected)).toFixed(2)
    : shift.openingCash;
  const localVariance: Money | null = closingCash
    ? subMoney(closingCash, localExpected as Money)
    : null;

  async function handleSubmit() {
    if (!closingCash) return;
    setSubmitting(true);
    try {
      await runtime.commitShiftClosed(
        shift.shiftId,
        {
          closingCashCounted: closingCash,
          notes: notes || undefined,
          closedAt: new Date().toISOString(),
        },
        actor,
      );
      closeShift();
      toast({
        title: t('pos.shiftClosedTitle'),
        description: t('pos.shiftClosedDescription'),
        variant: 'success',
      });
      onClose();
    } catch (err) {
      toast({
        title: t('pos.shiftCloseFailed'),
        description: apiErrorDetail(err),
        variant: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pos.closeShiftTitle')}
      description={t('pos.closeShiftDescription')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!closingCash}>
            {t('pos.closeShiftSubmit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-surface-sunken p-3 text-sm">
          <span className="text-text-muted">{t('pos.openingCash')}</span>
          <span className="text-right tabular-nums">{formatMoney(shift.openingCash)}</span>
          <span className="text-text-muted">{t('pos.localCashEstimate')}</span>
          <span className="text-right tabular-nums">{formatMoney(localExpected as Money)}</span>
          <span className="text-text-muted">{t('pos.salesCount')}</span>
          <span className="text-right tabular-nums">{shift.salesCount}</span>
        </div>
        <MoneyInput
          label={t('pos.closingCashCounted')}
          value={closingCash}
          onChange={setClosingCash}
          required
          size="touch"
        />
        {localVariance && localVariance !== '0.00' && (
          <p className="text-sm text-warning-700">
            {t('pos.localVarianceNote', { amount: formatMoney(localVariance) })}
          </p>
        )}
        <Textarea
          label={t('common.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
        <p className="text-xs text-text-muted">{t('pos.closeShiftFinalNote')}</p>
      </div>
    </Modal>
  );
}
