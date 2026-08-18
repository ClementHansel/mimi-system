'use client';

import { WifiOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';
import type { ISODateTime } from '@/lib/shared-types';

/**
 * Renders the approval chain for any of the 8 approvable document types
 * (D-08) from `GET /api/approvals/:documentType/:documentId` (CONTRACTS §4.0
 * `ApprovalDetail.steps`). One component for every document — callers just
 * pass the steps array; they never build their own timeline markup.
 *
 * Surfaces the D-17 offline-authorization provenance explicitly: a step
 * acted on via a cached offline credential shows the "Diotorisasi offline"
 * badge plus its `reverificationStatus` once the cloud has re-checked it —
 * `unprovable` renders as a warning, not a silent pass, because that's
 * exactly the finance-review case SYNC-PROTOCOL §7.5 exists for.
 */

export interface ApprovalStepView {
  stepNo: number;
  /** RoleKey of the approver this step is assigned to. */
  approverRole: string;
  state: 'pending' | 'approved' | 'rejected' | 'skipped';
  actedBy?: string | null;
  actedAt?: ISODateTime | null;
  reason?: string | null;
  offlineAuthorized?: boolean;
  reverificationStatus?: 'verified' | 'failed' | 'unprovable' | null;
}

export interface ApprovalTimelineProps {
  steps: ApprovalStepView[];
  className?: string;
}

const DOT_CLASSES: Record<ApprovalStepView['state'], string> = {
  pending: 'bg-warning-600',
  approved: 'bg-success-600',
  rejected: 'bg-danger-600',
  skipped: 'bg-stone-400',
};

export function ApprovalTimeline({ steps, className }: ApprovalTimelineProps) {
  const { t } = useI18n();

  if (steps.length === 0) {
    return <EmptyState title={t('approvalTimeline.empty')} size="sm" />;
  }

  return (
    <ol className={cn('flex flex-col', className)} aria-label={t('approvalTimeline.title')}>
      {steps.map((step, idx) => {
        const roleKey = `role.${step.approverRole}`;
        const roleLabel = t(roleKey) === roleKey ? step.approverRole : t(roleKey);
        const isLast = idx === steps.length - 1;
        return (
          <li key={step.stepNo} className="relative flex gap-3 pb-6 last:pb-0">
            {!isLast && (
              <span className="absolute left-[0.3rem] top-4 h-full w-px bg-border" aria-hidden />
            )}
            <span
              className={cn(
                'relative z-10 mt-1.5 size-2.5 flex-none rounded-full',
                DOT_CLASSES[step.state],
              )}
              aria-hidden
            />
            <div className="flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-text-primary">
                  {t('approvalTimeline.step', { step: step.stepNo })} — {roleLabel}
                </span>
                <StatusBadge domain="approvalStep" status={step.state} size="sm" />
                {step.offlineAuthorized && (
                  <Badge variant="warning" size="sm">
                    <WifiOff className="size-3" aria-hidden />
                    {t('approvalTimeline.offlineAuthorized')}
                  </Badge>
                )}
                {step.reverificationStatus && (
                  <Badge
                    variant={step.reverificationStatus === 'verified' ? 'success' : 'danger'}
                    size="sm"
                  >
                    {step.reverificationStatus === 'verified' &&
                      t('approvalTimeline.reverificationVerified')}
                    {step.reverificationStatus === 'failed' &&
                      t('approvalTimeline.reverificationFailed')}
                    {step.reverificationStatus === 'unprovable' &&
                      t('approvalTimeline.reverificationUnprovable')}
                  </Badge>
                )}
              </div>
              {step.state === 'pending' ? (
                <p className="mt-0.5 text-sm text-text-muted">
                  {t('approvalTimeline.pendingStep', { role: roleLabel })}
                </p>
              ) : (
                <>
                  {(step.actedBy || step.actedAt) && (
                    <p className="mt-0.5 text-sm text-text-muted">
                      {step.actedAt && fmtDateTime(step.actedAt)}
                      {step.actedBy && ` ${t('approvalTimeline.actedBy', { name: step.actedBy })}`}
                    </p>
                  )}
                  {step.reason && (
                    <p className="mt-1 text-sm text-text-secondary">&ldquo;{step.reason}&rdquo;</p>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
