'use client';

import { useEffect, useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Card, CardContent, Button, EmptyState, Select } from '@/components/ui';
import { formatMoney } from '@/lib/formatters';
import { getMySlips } from './lib/me-api';
import type { Payslip } from '@/components/hr/lib/types';

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 4 }, (_, i) => String(currentYear - i));

/** F11 `me` — Slip Gaji: the employee's own approved payslips (§4.15, 8.3.3). Money renders exactly as computed, never re-derived client-side. */
export function SlipGajiPanel() {
  const { t } = useI18n();
  const [year, setYear] = useState(String(currentYear));
  const [slips, setSlips] = useState<Payslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getMySlips(year)
      .then(setSlips)
      .finally(() => setLoading(false));
  }, [year]);

  return (
    <div className="flex flex-col gap-4">
      <Select
        value={year}
        onValueChange={setYear}
        options={YEARS.map((y) => ({ value: y, label: y }))}
        wrapperClassName="w-32"
      />

      {loading ? (
        <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
      ) : slips.length === 0 ? (
        <EmptyState icon={FileText} title={t('me.slip.empty')} size="lg" />
      ) : (
        <div className="flex flex-col gap-3">
          {slips.map((slip) => {
            const isOpen = expanded === slip.periodCode;
            return (
              <Card key={slip.periodCode}>
                <CardContent
                  className="flex cursor-pointer flex-col gap-2"
                  onClick={() => setExpanded(isOpen ? null : slip.periodCode)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">{slip.periodCode}</span>
                    <span className="text-lg font-semibold tabular-nums text-success-700">
                      {formatMoney(slip.net)}
                    </span>
                  </div>
                  <p className="text-sm text-text-muted">
                    {t('me.slip.grossDeductions', {
                      gross: formatMoney(slip.gross),
                      deductions: formatMoney(slip.deductions),
                    })}
                  </p>

                  {isOpen && (
                    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                      {slip.lines.map((line, i) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span
                            className={
                              line.type === 'employer_cost'
                                ? 'text-text-muted'
                                : 'text-text-secondary'
                            }
                          >
                            {line.componentName}
                            {line.isStatutory && (
                              <span className="ml-1 text-xs text-info-600">
                                ({t('me.slip.statutory')})
                              </span>
                            )}
                          </span>
                          <span
                            className={`tabular-nums ${line.type === 'deduction' ? 'text-danger-600' : 'text-text-primary'}`}
                          >
                            {line.type === 'deduction' ? '-' : ''}
                            {formatMoney(line.amount)}
                          </span>
                        </div>
                      ))}
                      {slip.slipPdfUrl && (
                        <a
                          href={slip.slipPdfUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            leftIcon={<Download className="size-4" />}
                            fullWidth
                            className="mt-2"
                          >
                            {t('me.slip.downloadPdf')}
                          </Button>
                        </a>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
