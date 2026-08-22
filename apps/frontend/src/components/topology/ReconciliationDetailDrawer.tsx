'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Scale } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { resolveReconciliation } from './lib/topology-api';
import type { ReconciliationRow } from './lib/types';

/**
 * One stock divergence, opened from the reconciliation queue (D-16).
 *
 * A row here says: for this item at this location, the tier-N store thinks
 * there is X and the cloud thinks there is Y. That is a statement about the
 * REAL WORLD being unknown, so what this drawer offers is deliberately narrow:
 *
 *  - Read the numbers, with the divergence signed and spelled out (a bare
 *    "-4.000" in a table does not say which side is short).
 *  - Go and count — the link to Gudang/Outlet's stock opname, because the only
 *    thing that establishes truth here is somebody looking at a shelf.
 *  - Record the resolution once it IS settled, with a mandatory note and an
 *    optional adjustment reference.
 *
 * What it deliberately does NOT do is write a stock adjustment itself. Closing
 * a divergence by silently moving the balance would make the ledger agree with
 * whichever number the operator clicked, which is exactly the failure D-07's
 * "never write stock_balances directly" rule exists to prevent. Resolution here
 * is bookkeeping ON the investigation; the stock change belongs to an opname
 * with its own approval trail.
 */
export function ReconciliationDetailDrawer({
  row,
  onClose,
  onResolved,
}: {
  row: ReconciliationRow;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useI18n();
  const [resolution, setResolution] = useState('');
  const [adjustmentId, setAdjustmentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Negative = the physical store holds LESS than the cloud believes, which is
  // the direction that usually means loss rather than a missed inbound.
  const divergence = Number(row.divergence);
  const short = divergence < 0;

  async function submit() {
    if (!resolution.trim()) {
      setError(t('validation.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveReconciliation(row.id, resolution.trim(), adjustmentId.trim() || undefined);
      toast({ title: t('topology.sync.reconResolveSuccess'), variant: 'success' });
      onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.genericError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title={t('topology.sync.reconDetailTitle')} size="lg">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <p className="font-display text-lg font-semibold text-text-primary">{row.itemName}</p>
          <p className="text-sm text-text-muted">
            {row.locationName}
            {row.storageAreaName ? ` · ${row.storageAreaName}` : ''}
          </p>
          <Badge variant="neutral" className="self-start">
            {t('topology.sync.tier', { tier: row.tier })}
          </Badge>
        </section>

        <section className="flex items-center gap-3 rounded-md bg-surface-sunken p-3">
          <Scale className="size-5 flex-none text-text-muted" aria-hidden />
          <div className="flex flex-col">
            <p
              className={`font-display text-xl font-bold tabular-nums ${
                short ? 'text-danger-600' : 'text-warning-700'
              }`}
            >
              {divergence > 0 ? `+${row.divergence}` : row.divergence}
            </p>
            {/* Says WHICH side is short, in words. */}
            <p className="text-xs text-text-secondary">
              {t(short ? 'topology.sync.divergenceShort' : 'topology.sync.divergenceOver')}
            </p>
          </div>
        </section>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-text-muted">{t('topology.sync.columnExpectedQty')}</dt>
          <dd className="tabular-nums text-text-primary">{row.expectedQty}</dd>
          <dt className="text-text-muted">{t('topology.sync.columnStoredQty')}</dt>
          <dd className="tabular-nums text-text-primary">{row.storedQty}</dd>
          <dt className="text-text-muted">{t('topology.sync.columnDetected')}</dt>
          <dd className="text-text-primary">{fmtDateTime(row.detectedAt)}</dd>
          <dt className="text-text-muted">{t('topology.sync.detailStatus')}</dt>
          <dd className="text-text-primary">{row.status}</dd>
        </dl>

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('topology.sync.reconResolveTitle')}
          </h3>
          <p className="text-sm text-text-secondary">{t('topology.sync.reconCountFirstHint')}</p>
          <Link
            href="/warehouse"
            className="inline-flex min-h-touch items-center gap-1.5 self-start text-sm font-medium text-brand-600 hover:underline"
          >
            <ExternalLink className="size-4" aria-hidden />
            {t('topology.sync.reconOpenOpname')}
          </Link>

          <PermissionGate permission="sync.conflict.resolve">
            <div className="flex flex-col gap-2 pt-1">
              {error && <p className="text-sm text-danger-600">{error}</p>}
              <Textarea
                label={t('topology.sync.reconResolutionLabel')}
                hint={t('topology.sync.reconResolutionHint')}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                required
              />
              <Input
                label={t('topology.sync.reconAdjustmentLabel')}
                hint={t('topology.sync.reconAdjustmentHint')}
                value={adjustmentId}
                onChange={(e) => setAdjustmentId(e.target.value)}
              />
              <Button
                onClick={submit}
                loading={busy}
                disabled={!resolution.trim()}
                className="self-start"
              >
                {t('topology.sync.reconResolveButton')}
              </Button>
            </div>
          </PermissionGate>
        </section>
      </div>
    </Drawer>
  );
}
