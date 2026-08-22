'use client';

import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button, Card, CardContent } from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';

/**
 * B-15 — the approver's half of the one-time approval code (owner decision Q8,
 * 2026-08-22).
 *
 * This panel IS the authorization act. Pressing the button is what approves the
 * document; the six digits it returns are only the proof that travels to
 * whoever is holding the document open at the till. The decision is recorded
 * against the approver the moment the code is redeemed, never against the
 * person who types it.
 *
 * ## Two things this screen deliberately does NOT do
 *
 * It does not keep the code around. There is no copy-to-clipboard, no history,
 * and it disappears with the page — a code is meant to be read out once and
 * spent within five minutes, and a UI that made it convenient to store would
 * quietly recreate the standing secret this whole change removed.
 *
 * It does not claim the document is approved. Until the code is redeemed the
 * document is still pending, and saying otherwise would leave the approver
 * believing a void went through when the cashier never finished it. The copy
 * says "waiting to be entered", which is the truth.
 */
export interface IssueApprovalCodePanelProps {
  documentType: string;
  documentId: string;
}

interface IssuedCodeResponse {
  code: string;
  expiresAt: string;
  redeemableByUserId: string;
}

export function IssueApprovalCodePanel({ documentType, documentId }: IssueApprovalCodePanelProps) {
  const { t } = useI18n();
  const [issued, setIssued] = useState<IssuedCodeResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleIssue() {
    setSubmitting(true);
    try {
      const res = await api.post<IssuedCodeResponse>(
        `/api/approvals/${documentType}/${documentId}/code`,
        {},
      );
      setIssued(res);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : undefined;
      toast({ title: t('approvalCode.issueFailed'), description: message, variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  if (issued) {
    const expiresAt = new Date(issued.expiresAt);
    return (
      <Card className="border-success-600/30 bg-success-50/40">
        <CardContent className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-success-700">
            <ShieldCheck className="size-4 flex-none" aria-hidden />
            {t('approvalCode.issuedTitle')}
          </div>
          {/* Wide tracking and a monospace face because this gets read aloud over a
              phone line in a noisy kitchen — the digits have to be unambiguous. */}
          <div
            className="font-mono text-4xl font-bold tracking-[0.3em] text-fg"
            data-testid="approval-code"
          >
            {issued.code}
          </div>
          <p className="text-sm text-fg-muted">
            {t('approvalCode.issuedDescription', {
              time: expiresAt.toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </p>
          <p className="text-xs text-fg-subtle">{t('approvalCode.stillPending')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            loading={submitting}
            onClick={handleIssue}
          >
            {t('approvalCode.reissue')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-muted">{t('approvalCode.explainer')}</p>
      <Button type="button" className="w-fit" loading={submitting} onClick={handleIssue}>
        <KeyRound className="size-4" aria-hidden />
        {t('approvalCode.issue')}
      </Button>
    </div>
  );
}
