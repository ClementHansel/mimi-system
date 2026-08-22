'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Textarea';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { dismissSyncConflict } from './lib/topology-api';
import type { SyncConflictRow } from './lib/types';

/**
 * One sync conflict, opened from the queue — what happened, and what can be
 * done about it.
 *
 * Owner, 2026-08-21: "all these need to be clickable and show the details. and
 * able to do something related to that to resolve it." The queue was
 * deliberately read-only when it shipped (F12 scoped resolution out), so an
 * operator could see that `duplicate_receipt` on `goods_receipts` needed a human
 * and had nowhere to go with it.
 *
 * THE TWO OUTCOMES ARE NOT INTERCHANGEABLE, which is the whole design here:
 *
 *  - `double_count`, `duplicate_receipt` and `decision_race` have PHYSICAL or
 *    financial consequences that only the owning screen can settle — you fix a
 *    double-counted opname by recounting, not by ticking a box in a device
 *    console. The server refuses to dismiss those (`ERR_RESOLVE_IN_DOMAIN`), so
 *    this drawer does not offer it: it sends you to the document instead, with
 *    the reason stated. Offering a button the server will reject is how a
 *    console teaches people to distrust it.
 *  - Everything else is a bookkeeping race the engine already settled
 *    (last-write-wins with both event ids kept). A human confirming "yes, the
 *    winner is right" is a dismissal WITH A REASON, which the audit log keeps.
 *
 * `detail` is rendered as formatted JSON rather than prose. It is engine
 * output whose shape varies per conflict kind, and inventing a friendly
 * summary per kind would either be wrong for the kinds nobody anticipated or
 * hide the one field that mattered.
 */
const DOMAIN_RESOLVED_KINDS = new Set(['double_count', 'duplicate_receipt', 'decision_race']);

export function ConflictDetailDrawer({
  conflict,
  onClose,
  onResolved,
}: {
  conflict: SyncConflictRow;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domainOnly = DOMAIN_RESOLVED_KINDS.has(conflict.kind);

  async function dismiss() {
    if (!reason.trim()) {
      setError(t('validation.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await dismissSyncConflict(conflict.id, reason.trim());
      toast({ title: t('topology.sync.dismissSuccess'), variant: 'success' });
      onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title={t('topology.sync.detailTitle')} size="lg">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{conflict.queue}</Badge>
            {conflict.physicalEffectSuspected && (
              <Badge variant="danger">{t('topology.sync.physicalEffectYes')}</Badge>
            )}
          </div>
          <p className="font-display text-lg font-semibold text-text-primary">
            {t(`topology.sync.kind.${conflict.kind}`)}
          </p>
          {conflict.physicalEffectSuspected && (
            // The one fact that changes urgency: stock may already have moved
            // in the real world, so this is not a paperwork tidy-up.
            <p className="flex items-start gap-1.5 rounded-md bg-danger-50 px-2.5 py-2 text-sm text-danger-700">
              <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden />
              <span>{t('topology.sync.physicalEffectHint')}</span>
            </p>
          )}
        </section>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-text-muted">{t('topology.sync.columnEntity')}</dt>
          <dd className="text-text-primary">{conflict.entity}</dd>
          <dt className="text-text-muted">{t('topology.sync.detailEntityId')}</dt>
          <dd className="break-all font-mono text-xs text-text-primary">{conflict.entityId}</dd>
          <dt className="text-text-muted">{t('topology.sync.columnDetected')}</dt>
          <dd className="text-text-primary">{fmtDateTime(conflict.createdAt)}</dd>
          <dt className="text-text-muted">{t('topology.sync.detailStatus')}</dt>
          <dd className="text-text-primary">{conflict.status}</dd>
          {conflict.winnerEventId && (
            <>
              <dt className="text-text-muted">{t('topology.sync.detailWinnerEvent')}</dt>
              <dd className="break-all font-mono text-xs text-text-primary">
                {conflict.winnerEventId}
              </dd>
            </>
          )}
          {conflict.loserEventId && (
            <>
              <dt className="text-text-muted">{t('topology.sync.detailLoserEvent')}</dt>
              <dd className="break-all font-mono text-xs text-text-primary">
                {conflict.loserEventId}
              </dd>
            </>
          )}
        </dl>

        {conflict.detail && Object.keys(conflict.detail).length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('topology.sync.detailPayload')}
            </h3>
            <pre className="max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs text-text-secondary">
              {JSON.stringify(conflict.detail, null, 2)}
            </pre>
          </section>
        )}

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('topology.sync.resolveTitle')}
          </h3>

          {/* Always offered: the document itself is where the facts are. */}
          <Link
            href={conflict.resolveInUrl}
            className="inline-flex min-h-touch items-center gap-1.5 self-start text-sm font-medium text-brand-600 hover:underline"
          >
            <ExternalLink className="size-4" aria-hidden />
            {t('topology.sync.openOwningScreen')}
          </Link>

          {domainOnly ? (
            <p className="rounded-md bg-surface-sunken px-2.5 py-2 text-sm text-text-secondary">
              {t('topology.sync.domainOnlyHint')}
            </p>
          ) : (
            <PermissionGate permission="sync.conflict.resolve">
              <div className="flex flex-col gap-2">
                {error && <p className="text-sm text-danger-600">{error}</p>}
                <Textarea
                  label={t('topology.sync.dismissReason')}
                  hint={t('topology.sync.dismissReasonHint')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                />
                <Button
                  variant="danger"
                  onClick={dismiss}
                  loading={busy}
                  disabled={!reason.trim()}
                  className="self-start"
                >
                  {t('topology.sync.dismissButton')}
                </Button>
              </div>
            </PermissionGate>
          )}
        </section>
      </div>
    </Drawer>
  );
}
