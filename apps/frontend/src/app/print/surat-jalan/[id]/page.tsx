'use client';

import { use, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { EmptyState } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import { formatQty, formatTemp } from '@/lib/formatters';
import { PrintFrame } from '@/components/print/PrintFrame';
import { getSuratJalan } from '@/components/delivery/lib/delivery-api';
import type { SuratJalan } from '@/lib/shared-types';

/**
 * W5-05 — the printable Surat Jalan.
 *
 * This is the one document in the system that is a LEGAL shipping record
 * (D-14): it travels with the goods, the receiving outlet signs it, and a
 * dispute later is settled by what it says. It had no print path at all —
 * dispatchers were reading a drawer on screen.
 *
 * Deliberate content choices, each because a paper delivery note is used
 * differently from a screen:
 *
 *  - Every drop prints its OWN item table with a signature block, because
 *    each stop is signed separately by a different person at a different
 *    outlet. One combined table would be unsignable.
 *  - `qtyReceived` prints as a blank ruled cell when the drop has not been
 *    received yet — the driver writes it in. Printing "0" would be a claim
 *    that nothing arrived.
 *  - Seals and cold-chain readings print for frozen shipments, since the
 *    seal number is the evidence the chain was unbroken (FR-LOG-08).
 */
export default function PrintSuratJalanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const [sj, setSj] = useState<SuratJalan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSuratJalan(id)
      .then(setSj)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : t('delivery.detail.loadError')),
      );
  }, [id, t]);

  const drops = sj ? [...sj.drops].sort((a, b) => a.dropSeq - b.dropSeq) : [];
  const isFrozen = sj?.shipmentType === 'frozen';

  return (
    <PrintFrame title={t('print.sj.title')} documentNumber={sj?.sjNumber ?? null} ready={!!sj}>
      {error && <EmptyState title={error} size="sm" />}
      {!sj && !error && <p className="text-sm">{t('common.loading')}</p>}

      {sj && (
        <div className="flex flex-col gap-5 text-sm">
          <section className="print-keep grid grid-cols-2 gap-x-8 gap-y-1">
            <Field label={t('print.sj.driver')} value={sj.driver.name} />
            <Field label={t('print.sj.vehicle')} value={sj.vehicle.plateNumber} />
            <Field label={t('print.sj.plannedDate')} value={sj.plannedDate} />
            <Field
              label={t('print.sj.shipmentType')}
              value={isFrozen ? t('driver.shipmentType.frozen') : t('driver.shipmentType.dry')}
            />
            <Field
              label={t('print.sj.dispatchedAt')}
              value={sj.dispatchedAt ? fmtDateTime(sj.dispatchedAt) : '—'}
            />
            <Field label={t('print.sj.status')} value={t(`status.suratJalan.${sj.status}`)} />
          </section>

          {sj.seals.length > 0 && (
            <section className="print-keep">
              <p className="font-semibold">{t('print.sj.seals')}</p>
              <p className="font-mono">{sj.seals.map((s) => s.sealNumber).join(' · ')}</p>
            </section>
          )}

          {drops.map((drop) => {
            const received = drop.status === 'completed' || drop.status === 'completed_discrepancy';
            return (
              <section key={drop.id} className="print-keep border-t border-black pt-3">
                <div className="mb-1 flex items-baseline justify-between">
                  <p className="font-semibold">
                    {t('driver.dropSeq', { seq: drop.dropSeq })} — {drop.locationName}
                  </p>
                  <p className="text-xs">{drop.city}</p>
                </div>
                {drop.address && <p className="mb-2 text-xs">{drop.address}</p>}
                {drop.deliveryInstructions && (
                  <p className="mb-2 text-xs italic">
                    {t('driver.nav.instructions')}: {drop.deliveryInstructions}
                  </p>
                )}

                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-y border-black">
                      <th className="py-1 text-left">{t('print.sj.item')}</th>
                      <th className="py-1 text-right">{t('print.sj.qtySent')}</th>
                      <th className="py-1 text-right">{t('print.sj.qtyReceived')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drop.lines.map((line) => (
                      <tr key={line.id} className="border-b border-stone-300">
                        <td className="py-1">{line.itemName}</td>
                        <td className="py-1 text-right">
                          {formatQty(line.qty)} {line.unitCode}
                        </td>
                        <td className="py-1 text-right">
                          {/* Blank ruled cell until it is actually received —
                              printing 0 would assert nothing arrived. */}
                          {received && line.qtyReceived !== null ? (
                            `${formatQty(line.qtyReceived)} ${line.unitCode}`
                          ) : (
                            <span className="inline-block w-20 border-b border-stone-500">&nbsp;</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {isFrozen && (
                  <p className="mt-1 text-xs">
                    {t('print.sj.tempAtDrop')}:{' '}
                    {sj.tempLogs
                      .filter((l) => l.dropId === drop.id)
                      .map((l) => formatTemp(l.tempC))
                      .join(' · ') || '__________'}
                  </p>
                )}

                <SignatureBlock
                  driverLabel={t('print.sj.signDriver')}
                  receiverLabel={t('print.sj.signReceiver')}
                  receiverName={drop.receivedBy}
                />
              </section>
            );
          })}

          <p className="print-keep pt-2 text-[10px]">{t('print.sj.footer')}</p>
        </div>
      )}
    </PrintFrame>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-semibold">{label}:</span> {value}
    </p>
  );
}

function SignatureBlock({
  driverLabel,
  receiverLabel,
  receiverName,
}: {
  driverLabel: string;
  receiverLabel: string;
  receiverName: string | null;
}) {
  return (
    <div className="print-keep mt-4 grid grid-cols-2 gap-8">
      {[driverLabel, receiverLabel].map((label, i) => (
        <div key={label} className="text-xs">
          <p>{label}</p>
          <div className="mt-8 border-b border-black" />
          <p className="mt-1">{i === 1 && receiverName ? receiverName : '(_______________)'}</p>
        </div>
      ))}
    </div>
  );
}
