'use client';

import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money } from '@/lib/shared-types';
import { ShiftCloseModal } from './ShiftCloseModal';
import type { OpenShift } from './shift-store';

/**
 * F-POS-2 "Shift" tab. Every number here already lived in `shift-store.ts`
 * (accumulated by `PaymentPanel.recordSale`/`recordVoid` as sales/voids are
 * rung up) — this only gives it a permanent home instead of surfacing solely
 * inside `ShiftCloseModal` at the moment of closing. `ShiftCloseModal` itself
 * is reused unchanged for the actual close action (CONTRACTS §4.13's
 * `POST /api/pos/shifts/:id/close`); this tab never re-implements it.
 */
export function ShiftPanel({
  runtime,
  actor,
  shift,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  shift: OpenShift;
}) {
  const { t } = useI18n();
  const [closeOpen, setCloseOpen] = useState(false);

  // Mirrors `ShiftCloseModal`'s own device-local estimate exactly (same
  // deliberate approximation, same caveat) — never the authoritative number,
  // which the cloud recomputes at close/sync (R7, SYNC-PROTOCOL §8 row 16).
  const localExpected = shift.cashCollected
    ? ((parseFloat(shift.openingCash) + parseFloat(shift.cashCollected)).toFixed(2) as Money)
    : shift.openingCash;

  const rows: [string, string][] = [
    [t('pos.shiftKasirLabel'), shift.kasirName],
    [t('pos.shiftOpenedAtLabel'), fmtDateTime(shift.openedAt)],
    [t('pos.openingCash'), formatMoney(shift.openingCash)],
    [t('pos.localCashEstimate'), formatMoney(localExpected)],
    [t('pos.grossSalesLabel'), formatMoney(shift.grossSales)],
    [t('pos.salesCount'), String(shift.salesCount)],
    [t('pos.voidCountLabel'), String(shift.voidCount)],
  ];

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockKeyhole className="size-5 text-brand-600" aria-hidden />
            {t('pos.shiftPanelTitle')}
          </CardTitle>
          <CardDescription>{t('pos.shiftPanelDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-muted">{label}</dt>
                <dd className="text-right font-medium tabular-nums text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Button size="touch-lg" fullWidth variant="outline" onClick={() => setCloseOpen(true)}>
        {t('pos.closeShift')}
      </Button>

      <ShiftCloseModal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        runtime={runtime}
        actor={actor}
        shift={shift}
      />
    </div>
  );
}
