'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { EmptyState } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import { formatQty, formatTemp } from '@/lib/formatters';
import { PrintFrame } from '@/components/print/PrintFrame';
import { getSuratJalan } from '@/components/delivery/lib/delivery-api';
import type { SuratJalan, Drop } from '@/lib/shared-types';

/**
 * W5-05 — the printable Surat Jalan.
 *
 * This is the one document in the system that is a LEGAL shipping record
 * (D-14): it travels with the goods, the receiving outlet signs it, and a
 * dispute later is settled by what it says. It had no print path at all —
 * dispatchers were reading a drawer on screen.
 *
 * THREE COPIES PER DELIVERY POINT (owner, 2026-08-21). The paper is printed in
 * GUDANG, and each drop needs three signed originals: one stays in gudang, one
 * stays at the outlet that receives the goods, one goes back to the office. So
 * a Surat Jalan with 3 drops prints 9 pages, and the standard Epson tray gives
 * every party its own paper next to the same online record. Each copy is a
 * COMPLETE one-drop note — own letterhead, own item table, own signature block
 * — because three parties cannot share one sheet, and a copy that referred to
 * "see page 1" would be worthless in a dispute.
 *
 * Other deliberate content choices, each because a paper delivery note is used
 * differently from a screen:
 *
 *  - One drop per copy, never a combined table: each stop is signed separately
 *    by a different person at a different outlet.
 *  - `qtyReceived` prints as a blank ruled cell when the drop has not been
 *    received yet — the driver writes it in. Printing "0" would be a claim
 *    that nothing arrived.
 *  - Seals and cold-chain readings print for frozen shipments, since the
 *    seal number is the evidence the chain was unbroken (FR-LOG-08).
 */

/** Who each printed copy belongs to, in the order they leave the printer. */
const COPY_HOLDERS = ['gudang', 'outlet', 'kantor'] as const;
type CopyHolder = (typeof COPY_HOLDERS)[number];

export default function PrintSuratJalanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const [sj, setSj] = useState<SuratJalan | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Captured once, not re-read per copy: every sheet in this print job should
  // carry the SAME "generated at" instant, not the moment each one happened
  // to render.
  const generatedAt = useMemo(() => new Date(), []);

  useEffect(() => {
    getSuratJalan(id)
      .then(setSj)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : t('delivery.detail.loadError')),
      );
  }, [id, t]);

  const drops = sj ? [...sj.drops].sort((a, b) => a.dropSeq - b.dropSeq) : [];
  const isFrozen = sj?.shipmentType === 'frozen';
  // Every `.print-copy` is deliberately exactly one printed page (see the
  // file header) — so, unlike a generic report, the page count here is known
  // exactly from the data instead of needing CSS running counters (which
  // browsers do not support consistently for `@page` margin boxes).
  const totalPages = drops.length * COPY_HOLDERS.length;

  return (
    <PrintFrame
      title={t('print.sj.title')}
      documentNumber={sj?.sjNumber ?? null}
      ready={!!sj}
      // Every copy carries its own letterhead, so the frame's single one at
      // the top of the sheet would duplicate the first page's.
      letterhead={false}
    >
      {error && <EmptyState title={error} size="sm" />}
      {!sj && !error && <p className="text-sm">{t('common.loading')}</p>}

      {sj && (
        <>
          {/* Screen-only: say up front how much paper this is, so nobody
              discovers 9 pages after hitting Cetak. */}
          <p className="print-hide mb-4 rounded-md bg-surface-sunken px-3 py-2 text-sm text-text-secondary">
            {t('print.sj.copyNotice', {
              drops: drops.length,
              copies: COPY_HOLDERS.length,
              pages: totalPages,
            })}
          </p>

          {drops.flatMap((drop, dropIdx) =>
            COPY_HOLDERS.map((holder, holderIdx) => (
              <CopySheet
                key={`${drop.id}-${holder}`}
                sj={sj}
                drop={drop}
                holder={holder}
                isFrozen={isFrozen}
                pageNumber={dropIdx * COPY_HOLDERS.length + holderIdx + 1}
                totalPages={totalPages}
                generatedAt={generatedAt}
              />
            )),
          )}
        </>
      )}
    </PrintFrame>
  );
}

/**
 * One printed page: one drop, one holder. Self-contained on purpose — see the
 * file header. `print-copy` is what `print.css` breaks pages on.
 */
function CopySheet({
  sj,
  drop,
  holder,
  isFrozen,
  pageNumber,
  totalPages,
  generatedAt,
}: {
  sj: SuratJalan;
  drop: Drop;
  holder: CopyHolder;
  isFrozen: boolean;
  /** 1-based position of this sheet in the whole print job (drops × holders). */
  pageNumber: number;
  totalPages: number;
  generatedAt: Date;
}) {
  const { t } = useI18n();
  const received = drop.status === 'completed' || drop.status === 'completed_discrepancy';
  // The outlet's copy names the outlet itself rather than a generic "Outlet",
  // so a stack of copies for four different drops can be sorted by hand.
  const holderLabel = holder === 'outlet' ? drop.locationName : t(`print.sj.copyHolder.${holder}`);

  return (
    <section className="print-copy flex flex-col gap-4 text-sm">
      <header className="print-keep flex items-start justify-between border-b-2 border-black pb-3">
        <div>
          <p className="font-display text-xl font-bold">Mimi Chicken OS</p>
          <p className="text-xs">{t('print.company')}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-lg font-bold uppercase">{t('print.sj.title')}</p>
          <p className="font-mono text-sm">{sj.sjNumber}</p>
          {/* The one line that makes three identical-looking sheets usable. */}
          <p className="mt-1 inline-block border border-black px-2 py-0.5 text-xs font-bold uppercase">
            {t('print.sj.copyFor', { holder: holderLabel })}
          </p>
        </div>
      </header>

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

      <section className="print-keep border-t border-black pt-3">
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

      <p className="print-keep pt-1 text-[10px]">{t('print.sj.footer')}</p>
      {/* Every sheet is a standalone, separately-signed legal copy (see file
          header) — so, unlike the on-screen `copyNotice`, this line has to be
          printed on EVERY page, not just shown once before printing. */}
      <p className="print-keep flex justify-between text-[10px] text-stone-600">
        <span>{t('print.sj.generatedAt', { date: fmtDateTime(generatedAt) })}</span>
        <span>{t('print.sj.pageOf', { page: pageNumber, total: totalPages })}</span>
      </p>
    </section>
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
