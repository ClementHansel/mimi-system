'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, PenSquare } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  QtyInput,
  Textarea,
  Checkbox,
  ApprovalTimeline,
} from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import type { Replenishment } from './lib/types';
import type { Qty } from '@/lib/shared-types';

export interface AmendmentInput {
  lineId: string;
  qtyApproved: Qty;
  reason: string;
}

interface LineDraft {
  amend: boolean;
  qtyApproved: Qty | null;
  reason: string;
}

export interface ReplenishmentApproveFormProps {
  replenishment: Replenishment;
  submitting?: boolean;
  onApprove: (amendments: AmendmentInput[], note?: string) => void;
  onReject: (reason: string) => void;
}

/**
 * The Kepala Gudang approval step for a replenishment request — FR-LOG-13's
 * mandatory amend-reason gate lives here, pulled out of `ApprovalQueuePanel`
 * as its own component so the gate is unit-testable without mocking the
 * queue fetch (mirrors `ReceiveDropForm`'s split from `ReceivingPanel`).
 *
 * Amending a line's quantity is opt-in per line (`Checkbox` "Ubah jumlah"):
 * leaving it unchecked ships the requested quantity unchanged. The moment a
 * line IS amended, its reason field is required and the button that submits
 * the approval stays disabled until every amended line has a non-blank
 * reason — a silently reduced order is exactly the thing FR-LOG-13 exists to
 * prevent, so there is no path to approve an amendment without one.
 */
export function ReplenishmentApproveForm({
  replenishment,
  submitting,
  onApprove,
  onReject,
}: ReplenishmentApproveFormProps) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(
      replenishment.lines.map((l) => [
        l.id,
        { amend: false, qtyApproved: l.qtyRequested, reason: '' },
      ]),
    ),
  );
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  function updateLine(lineId: string, patch: Partial<LineDraft>) {
    setDrafts((prev) => ({ ...prev, [lineId]: { ...prev[lineId]!, ...patch } }));
  }

  const amendedLines = useMemo(
    () => replenishment.lines.filter((l) => drafts[l.id]?.amend),
    [replenishment.lines, drafts],
  );

  const canApprove =
    amendedLines.every((l) => {
      const d = drafts[l.id]!;
      return d.qtyApproved !== null && d.reason.trim() !== '';
    }) && replenishment.lines.every((l) => drafts[l.id]?.qtyApproved !== null);

  function submitApprove() {
    const amendments: AmendmentInput[] = amendedLines.map((l) => ({
      lineId: l.id,
      qtyApproved: drafts[l.id]!.qtyApproved as string,
      reason: drafts[l.id]!.reason.trim(),
    }));
    onApprove(amendments, note.trim() || undefined);
  }

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
            <th className="px-3 py-2">{t('warehouse.approvalQueue.item')}</th>
            <th className="px-3 py-2 text-right">{t('warehouse.approvalQueue.qtyRequested')}</th>
            <th className="px-3 py-2">{t('warehouse.approvalQueue.amend')}</th>
            <th className="px-3 py-2 text-right">{t('warehouse.approvalQueue.qtyApproved')}</th>
            <th className="px-3 py-2">{t('warehouse.approvalQueue.amendReason')}</th>
          </tr>
        </thead>
        <tbody>
          {replenishment.lines.map((l) => {
            const d = drafts[l.id]!;
            return (
              <tr key={l.id} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-2.5 font-medium text-text-primary">{l.itemName}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {formatQty(l.qtyRequested, l.unitCode)}
                </td>
                <td className="px-3 py-2.5">
                  <Checkbox
                    label={t('warehouse.approvalQueue.amendThisLine')}
                    checked={d.amend}
                    onCheckedChange={(checked) =>
                      updateLine(l.id, {
                        amend: checked,
                        qtyApproved: checked ? d.qtyApproved : l.qtyRequested,
                        reason: checked ? d.reason : '',
                      })
                    }
                    disabled={submitting}
                  />
                </td>
                <td className="px-3 py-2.5">
                  {d.amend ? (
                    <QtyInput
                      value={d.qtyApproved}
                      onChange={(v) => updateLine(l.id, { qtyApproved: v })}
                      unitCode={l.unitCode}
                      wrapperClassName="w-32 ml-auto"
                      disabled={submitting}
                    />
                  ) : (
                    <span className="block text-right tabular-nums">
                      {formatQty(l.qtyRequested, l.unitCode)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {d.amend ? (
                    <Textarea
                      rows={1}
                      value={d.reason}
                      onChange={(e) => updateLine(l.id, { reason: e.target.value })}
                      placeholder={t('common.reasonPlaceholder')}
                      error={d.reason.trim() === '' ? t('validation.reasonRequired') : undefined}
                      disabled={submitting}
                      wrapperClassName="w-56"
                    />
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {amendedLines.length > 0 && (
        <Card className="border-warning-600/30 bg-warning-50/40">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-warning-700">
            <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
            <span>{t('warehouse.approvalQueue.amendWarning', { count: amendedLines.length })}</span>
          </CardContent>
        </Card>
      )}

      {replenishment.approval && <ApprovalTimeline steps={replenishment.approval.steps} />}

      <Textarea
        label={t('warehouse.approvalQueue.note')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={submitting}
      />

      {rejecting && (
        <Textarea
          label={t('warehouse.approvalQueue.rejectReason')}
          required
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          error={rejectReason.trim() === '' ? t('validation.reasonRequired') : undefined}
          disabled={submitting}
        />
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {!rejecting ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setRejecting(true)}
            disabled={submitting}
          >
            {t('warehouse.approvalQueue.reject')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="danger"
            loading={submitting}
            disabled={rejectReason.trim() === ''}
            onClick={() => onReject(rejectReason.trim())}
          >
            {t('warehouse.approvalQueue.confirmReject')}
          </Button>
        )}
        <Button
          type="button"
          leftIcon={amendedLines.length > 0 ? <PenSquare className="size-4" /> : undefined}
          loading={submitting}
          disabled={!canApprove || rejecting}
          onClick={submitApprove}
        >
          {t('warehouse.approvalQueue.approve')}
        </Button>
      </div>
    </div>
  );
}
