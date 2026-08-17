'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, Card, CardContent, Textarea } from '@/components/ui';

export interface ApprovalActionPanelProps {
  /** `false` for the 2 document types (void_refund, payment_verification) whose real decide action isn't a plain note/reason POST — see `document-types.ts`. */
  approveSupported: boolean;
  /** i18n-resolved explanation shown in place of the approve button when `approveSupported` is `false`. */
  approveUnsupportedMessage?: string;
  /** cash_variance_proposal (§5.9): a reason is required on approve too, not just reject. */
  reasonRequiredOnApprove?: boolean;
  submitting?: boolean;
  onApprove: (note?: string) => void;
  onReject: (reason: string) => void;
}

/**
 * The generic approve/reject action bar for the 10 document types whose
 * owning-module decide endpoint is a plain `{note?}`/`{reason}` POST
 * (`replenishment_request`'s per-line amend case gets its own richer form,
 * `ReplenishmentApproveForm`, reused as-is from `components/warehouse`).
 *
 * FR-LOG-13's mandatory-reason rule is the whole reason this is its own
 * component rather than inline JSX: reject always requires a non-blank
 * reason before "Konfirmasi Tolak" is enabled, and for
 * `cash_variance_proposal` (Amendment 2, §5.9) approve requires one too — the
 * button stays disabled, not just validated on submit, so there is no path
 * to firing either action without a reason already typed in.
 */
export function ApprovalActionPanel({
  approveSupported,
  approveUnsupportedMessage,
  reasonRequiredOnApprove,
  submitting,
  onApprove,
  onReject,
}: ApprovalActionPanelProps) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const approveBlocked = reasonRequiredOnApprove && note.trim() === '';

  return (
    <div className="flex flex-col gap-3">
      {approveSupported ? (
        <Textarea
          label={t('approvalDetail.note')}
          required={reasonRequiredOnApprove}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={reasonRequiredOnApprove && note.trim() === '' ? t('validation.reasonRequired') : undefined}
          disabled={submitting}
        />
      ) : (
        approveUnsupportedMessage && (
          <Card className="border-info-600/30 bg-info-50/40">
            <CardContent className="flex items-start gap-2 p-3 text-sm text-info-700">
              <Info className="mt-0.5 size-4 flex-none" aria-hidden />
              <span>{approveUnsupportedMessage}</span>
            </CardContent>
          </Card>
        )
      )}

      {rejecting && (
        <Textarea
          label={t('approvalDetail.rejectReason')}
          required
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          error={rejectReason.trim() === '' ? t('validation.reasonRequired') : undefined}
          disabled={submitting}
        />
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {!rejecting ? (
          <Button type="button" variant="outline" disabled={submitting} onClick={() => setRejecting(true)}>
            {t('approvalDetail.reject')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="danger"
            loading={submitting}
            disabled={rejectReason.trim() === ''}
            onClick={() => onReject(rejectReason.trim())}
          >
            {t('approvalDetail.confirmReject')}
          </Button>
        )}
        {approveSupported && (
          <Button
            type="button"
            loading={submitting}
            disabled={approveBlocked || rejecting}
            onClick={() => onApprove(note.trim() || undefined)}
          >
            {t('approvalDetail.approve')}
          </Button>
        )}
      </div>
    </div>
  );
}
