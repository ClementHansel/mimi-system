'use client';

import { use, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { EmptyState } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { PrintFrame } from '@/components/print/PrintFrame';
import { getMySlips } from '@/components/me/lib/me-api';
import type { Payslip, PayslipLine } from '@/components/hr/lib/types';

/**
 * W5-05 — the printable slip gaji.
 *
 * `SlipGajiPanel` already had a "Download PDF" button, but it rendered only
 * when `slip.slipPdfUrl` was set and the backend hardcodes that to `null`
 * (`runs.service.ts`) — so no employee has ever been able to obtain a
 * payslip. This route is the missing half, built the same way as every other
 * document here: the browser's own print, which gives paper AND print-to-PDF
 * without shipping a PDF generator to a phone on mobile data.
 *
 * Keyed by PERIOD rather than by run id because that is what an employee
 * knows ("slip for 2026-08") and what `/payroll/my-slips` returns — and
 * because `my-slips` is inherently scoped to the caller, an employee cannot
 * reach someone else's payslip by editing the URL. Guarding a payslip on the
 * client would be no guard at all; the endpoint is the boundary.
 *
 * `employer_cost` lines are deliberately EXCLUDED. They are what the company
 * pays on top (BPJS employer portions) — real, but not part of the
 * employee's gross, and printing them on a payslip invites the reading that
 * the employee was paid more than they were.
 */
export default function PrintSlipGajiPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = use(params);
  const { t } = useI18n();
  const [slip, setSlip] = useState<Payslip | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const year = period.slice(0, 4);
    getMySlips(year)
      .then((slips) => {
        const found = slips.find((s) => s.periodCode === period);
        if (!found) {
          setError(t('print.slip.notFound', { period }));
          return;
        }
        setSlip(found);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : t('table.error')),
      );
  }, [period, t]);

  const earnings = slip?.lines.filter((l) => l.type === 'earning') ?? [];
  const deductions = slip?.lines.filter((l) => l.type === 'deduction') ?? [];

  return (
    <PrintFrame
      title={t('print.slip.title')}
      documentNumber={slip ? `SLIP-${slip.periodCode}-${slip.employee.name}` : null}
      ready={!!slip}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!slip && !error && <p className="text-sm">{t('common.loading')}</p>}

      {slip && (
        <div className="flex flex-col gap-5 text-sm">
          <section className="print-keep grid grid-cols-2 gap-x-8 gap-y-1">
            <p>
              <span className="font-semibold">{t('print.slip.employee')}:</span>{' '}
              {slip.employee.name}
            </p>
            <p>
              <span className="font-semibold">{t('print.slip.period')}:</span> {slip.periodCode}
            </p>
            <p>
              <span className="font-semibold">{t('print.slip.position')}:</span>{' '}
              {slip.employee.position}
            </p>
            <p>
              <span className="font-semibold">{t('print.slip.location')}:</span>{' '}
              {slip.employee.locationName}
            </p>
          </section>

          <div className="grid grid-cols-2 gap-8">
            <LineTable title={t('print.slip.earnings')} lines={earnings} total={slip.gross} totalLabel={t('print.slip.gross')} />
            <LineTable
              title={t('print.slip.deductions')}
              lines={deductions}
              total={slip.deductions}
              totalLabel={t('print.slip.totalDeductions')}
            />
          </div>

          <section className="print-keep flex items-baseline justify-between border-y-2 border-black py-2">
            <p className="font-display text-base font-bold uppercase">{t('print.slip.net')}</p>
            <p className="font-display text-lg font-bold">{formatMoney(slip.net)}</p>
          </section>

          <p className="print-keep text-[10px]">{t('print.slip.footer')}</p>
        </div>
      )}
    </PrintFrame>
  );
}

function LineTable({
  title,
  lines,
  total,
  totalLabel,
}: {
  title: string;
  lines: PayslipLine[];
  total: string;
  totalLabel: string;
}) {
  return (
    <section className="print-keep">
      <p className="mb-1 font-semibold uppercase">{title}</p>
      <table className="w-full border-collapse text-xs">
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td className="py-1 text-stone-500">—</td>
            </tr>
          )}
          {lines.map((line) => (
            <tr key={line.componentCode} className="border-b border-stone-300">
              <td className="py-1">{line.componentName}</td>
              <td className="py-1 text-right font-mono">{formatMoney(line.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-black">
            <td className="py-1 font-semibold">{totalLabel}</td>
            <td className="py-1 text-right font-mono font-semibold">{formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
