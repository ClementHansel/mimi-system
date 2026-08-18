'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  StatusBadge,
  ApprovalTimeline,
  EmptyState,
  toast,
} from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { fmtDateTime, fmtRelative } from '@/lib/dates';
import { ApiError } from '@/lib/api';
import { ApprovalDocumentType } from '@/lib/shared-types';
import { documentTypeConfig } from './lib/document-types';
import {
  getApprovalDetail,
  getPendingApprovals,
  approveDocument,
  rejectDocument,
  getReplenishmentForApproval,
  approveReplenishment,
  rejectReplenishment,
} from './lib/approvals-api';
import { ApprovalActionPanel } from './ApprovalActionPanel';
import {
  ReplenishmentApproveForm,
  type AmendmentInput,
} from '@/components/warehouse/ReplenishmentApproveForm';
import type { Replenishment } from '@/components/warehouse/lib/types';
import type { ApprovalDetail, PendingApprovalRow } from './lib/types';

export interface ApprovalDetailViewProps {
  documentType: string;
  documentId: string;
}

/**
 * `/approvals/:documentType/:documentId` — the notification deep-link target
 * (CONTRACTS §4.0, `ApprovalService.deepLinkFor`). Renders the approval
 * chain via `ApprovalTimeline` and, when the caller is eligible for the
 * CURRENT step, an approve/reject/amend action underneath it.
 *
 * The kernel detail read (`GET /api/approvals/:documentType/:documentId`)
 * only returns the approval bookkeeping — `approvalId/state/amount/
 * currentStep/steps`, never a document number, requester, or location
 * (those live on `PendingApprovalRow`, the "pending" list row, not the
 * detail row). So this view makes a best-effort second call to
 * `/approvals/pending` to find the matching row for that context; once a
 * document is decided it naturally drops out of that pending list, so the
 * header falls back to the raw document type + id — a documented and
 * expected degradation, not a bug, since the approval chain itself (the
 * thing this screen is actually for) is always present.
 */
export function ApprovalDetailView({ documentType, documentId }: ApprovalDetailViewProps) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [context, setContext] = useState<PendingApprovalRow | null>(null);
  const [replenishment, setReplenishment] = useState<Replenishment | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const config = documentTypeConfig(documentType);
  const isReplenishment = documentType === ApprovalDocumentType.REPLENISHMENT_REQUEST;

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const d = await getApprovalDetail(documentType, documentId);
      setDetail(d);

      try {
        const pending = await getPendingApprovals({ documentType, pageSize: 200 });
        setContext(pending.rows.find((r) => r.documentId === documentId) ?? null);
      } catch {
        setContext(null);
      }

      if (isReplenishment) {
        try {
          setReplenishment(await getReplenishmentForApproval(documentId));
        } catch {
          setReplenishment(null);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 404) setNotFound(true);
      else toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setLoading(false);
    }
  }, [documentType, documentId, isReplenishment, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleReplenishmentApprove(amendments: AmendmentInput[], note?: string) {
    setSubmitting(true);
    try {
      await approveReplenishment(documentId, {
        note,
        amendments: amendments.length ? amendments : undefined,
      });
      toast({ title: t('approvalDetail.approved'), variant: 'success' });
      load();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReplenishmentReject(reason: string) {
    setSubmitting(true);
    try {
      await rejectReplenishment(documentId, { reason });
      toast({ title: t('approvalDetail.rejected'), variant: 'success' });
      load();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGenericApprove(note?: string) {
    if (!config) return;
    setSubmitting(true);
    try {
      const body = config.reasonRequiredOnApprove ? { reason: note ?? '' } : { note };
      await approveDocument(config.basePath, documentId, body);
      toast({ title: t('approvalDetail.approved'), variant: 'success' });
      load();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGenericReject(reason: string) {
    if (!config) return;
    setSubmitting(true);
    try {
      await rejectDocument(config.basePath, documentId, { reason });
      toast({ title: t('approvalDetail.rejected'), variant: 'success' });
      load();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  if (!config) {
    return <EmptyState title={t('approvalDetail.unknownType')} size="lg" />;
  }

  if (notFound) {
    return <EmptyState title={t('approvalDetail.notFound')} size="lg" />;
  }

  const finished = detail?.currentStep === null;
  const currentStepDetail =
    detail && detail.currentStep !== null
      ? detail.steps.find((s) => s.stepNo === detail.currentStep)
      : undefined;
  const currentStepRoleLabel = currentStepDetail
    ? (() => {
        const key = `role.${currentStepDetail.approverRole}`;
        const label = t(key);
        return label === key ? currentStepDetail.approverRole : label;
      })()
    : null;

  // Gate on whichever permission actually governs this panel: for the 10
  // document types where this screen can approve, that's `approvePermission`
  // (an any-of covering every step's role, e.g. replenishment's supervisor
  // OR warehouse key); for the 2 where it can only reject (void_refund,
  // payment_verification — see `document-types.ts`), it's `rejectPermission`.
  // `usePermissions().can(undefined)` intentionally returns `true` ("no
  // permission required"), so falling through to `approvePermission` when
  // it's legitimately `undefined` would wrongly show the reject-only panel
  // to every caller regardless of role.
  const eligibilityPermission = config.approveSupported
    ? config.approvePermission
    : config.rejectPermission;
  const canApprove = !finished && can(eligibilityPermission);
  const documentLabel = t(config.labelKey);
  const title = context?.documentNumber ?? `${documentLabel} #${documentId.slice(0, 8)}`;

  return (
    <div className="flex flex-col gap-4 p-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        leftIcon={<ArrowLeft className="size-4" />}
        onClick={() => router.push('/approvals')}
        className="self-start"
      >
        {t('approvalDetail.backToInbox')}
      </Button>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-display text-2xl font-semibold text-text-primary">{title}</h1>
        <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-sm font-medium text-text-secondary">
          {documentLabel}
        </span>
        {detail && <StatusBadge domain="approval" status={detail.state} />}
      </div>

      {loading && <EmptyState title={t('common.loading')} size="lg" />}

      {!loading && detail && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('approvalDetail.summary')}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryField label={t('approvalDetail.amount')} value={formatMoney(detail.amount)} />
              <SummaryField
                label={t('approvalDetail.requestedBy')}
                value={context?.requestedBy ?? '—'}
              />
              <SummaryField
                label={t('approvalDetail.location')}
                value={context?.locationName ?? '—'}
              />
              <SummaryField
                label={t('approvalDetail.waiting')}
                value={
                  context
                    ? `${fmtRelative(context.requestedAt)} (${fmtDateTime(context.requestedAt)})`
                    : '—'
                }
              />
            </CardContent>
          </Card>

          {finished ? (
            <Card className="border-success-600/30 bg-success-50/40">
              <CardContent className="flex items-center gap-2 p-3 text-sm text-success-700">
                <CheckCircle2 className="size-4 flex-none" aria-hidden />
                <span>
                  {t('approvalDetail.chainFinished', {
                    state: t(`status.approval.${detail.state}`),
                  })}
                </span>
              </CardContent>
            </Card>
          ) : (
            currentStepRoleLabel && (
              <Card className="border-warning-600/30 bg-warning-50/40">
                <CardContent className="p-3 text-sm text-warning-700">
                  {t('approvalDetail.waitingOnStep', {
                    step: detail.currentStep ?? 0,
                    role: currentStepRoleLabel,
                  })}
                </CardContent>
              </Card>
            )
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('approvalTimeline.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ApprovalTimeline steps={detail.steps} />
            </CardContent>
          </Card>

          {!finished && canApprove && (
            <Card>
              <CardHeader>
                <CardTitle>{t('approvalDetail.actionTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                {isReplenishment && replenishment ? (
                  <ReplenishmentApproveForm
                    replenishment={replenishment}
                    submitting={submitting}
                    onApprove={handleReplenishmentApprove}
                    onReject={handleReplenishmentReject}
                  />
                ) : (
                  <ApprovalActionPanel
                    approveSupported={config.approveSupported}
                    approveUnsupportedMessage={
                      config.approveUnsupportedKey ? t(config.approveUnsupportedKey) : undefined
                    }
                    reasonRequiredOnApprove={config.reasonRequiredOnApprove}
                    submitting={submitting}
                    onApprove={handleGenericApprove}
                    onReject={handleGenericReject}
                  />
                )}
              </CardContent>
            </Card>
          )}

          {!finished && !canApprove && (
            <EmptyState title={t('approvalDetail.notYourTurn')} size="sm" />
          )}
        </>
      )}
    </div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}
