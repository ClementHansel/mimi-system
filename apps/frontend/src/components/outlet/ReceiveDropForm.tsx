'use client';

import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  PhotoCapture,
  SignaturePad,
  QtyInput,
  Select,
  Textarea,
  StatusBadge,
} from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import type { Drop, StorageArea } from './lib/types';
import type { Qty } from '@/lib/shared-types';

/**
 * The receiving fraud-control checkpoint (FR-LOG-14/15/16): photo is WAJIB
 * (≥1), signature is wajib, and any sent≠received quantity per line demands a
 * discrepancy reason before the "Konfirmasi Terima" button unlocks. Pulled out
 * of `ReceivingPanel` as its own component so the wajib-foto gate is testable
 * without mocking the surat-jalan list fetch.
 */
export interface ReceiveLineDraft {
  lineId: string;
  qtyReceived: Qty | null;
  receivedStorageAreaId: string;
  discrepancyReason: string;
}

export interface ReceiveDropFormProps {
  drop: Drop;
  storageAreas: StorageArea[];
  photoFile: File | null;
  onPhotoChange: (file: File | null) => void;
  signatureDataUrl: string | null;
  onSignatureChange: (dataUrl: string | null) => void;
  submitting?: boolean;
  onSubmit: (lines: ReceiveLineDraft[]) => void;
}

function lineNeedsReason(qtySent: Qty, draft: ReceiveLineDraft): boolean {
  if (draft.qtyReceived === null) return false;
  return draft.qtyReceived !== qtySent;
}

export function ReceiveDropForm({
  drop,
  storageAreas,
  photoFile,
  onPhotoChange,
  signatureDataUrl,
  onSignatureChange,
  submitting,
  onSubmit,
}: ReceiveDropFormProps) {
  const { t } = useI18n();
  const [lines, setLines] = useState<Record<string, ReceiveLineDraft>>(() =>
    Object.fromEntries(
      drop.lines.map((l) => [
        l.id,
        {
          lineId: l.id,
          qtyReceived: l.qty,
          receivedStorageAreaId: l.receivedStorageAreaId ?? '',
          discrepancyReason: '',
        },
      ]),
    ),
  );

  const areaOptions = storageAreas.map((a) => ({ value: a.id, label: a.name }));

  function updateLine(lineId: string, patch: Partial<ReceiveLineDraft>) {
    setLines((prev) => ({ ...prev, [lineId]: { ...prev[lineId]!, ...patch } }));
  }

  const draftList = useMemo(() => drop.lines.map((l) => lines[l.id]!), [drop.lines, lines]);

  const photoOk = photoFile !== null;
  const signatureOk = !!signatureDataUrl;
  const linesOk = drop.lines.every((l) => {
    const d = lines[l.id]!;
    if (d.qtyReceived === null) return false;
    if (!d.receivedStorageAreaId) return false;
    if (lineNeedsReason(l.qty, d) && d.discrepancyReason.trim() === '') return false;
    return true;
  });
  const canSubmit = photoOk && signatureOk && linesOk;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text-primary">{drop.locationName}</span>
        <StatusBadge domain="drop" status={drop.status} />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                <th className="px-3 py-2">{t('outlet.receiving.item')}</th>
                <th className="px-3 py-2">{t('outlet.receiving.qtySent')}</th>
                <th className="px-3 py-2">{t('outlet.receiving.qtyReceived')}</th>
                <th className="px-3 py-2">{t('outlet.receiving.storageArea')}</th>
                <th className="px-3 py-2">{t('outlet.receiving.discrepancyReason')}</th>
              </tr>
            </thead>
            <tbody>
              {drop.lines.map((l) => {
                const d = lines[l.id]!;
                const needsReason = lineNeedsReason(l.qty, d);
                return (
                  <tr key={l.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-2.5 font-medium text-text-primary">{l.itemName}</td>
                    <td className="px-3 py-2.5 tabular-nums">{formatQty(l.qty, l.unitCode)}</td>
                    <td className="px-3 py-2.5">
                      <QtyInput
                        value={d.qtyReceived}
                        onChange={(v) => updateLine(l.id, { qtyReceived: v })}
                        unitCode={l.unitCode}
                        size="touch"
                        wrapperClassName="w-36"
                        disabled={submitting}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <Select
                        value={d.receivedStorageAreaId}
                        onValueChange={(v) => updateLine(l.id, { receivedStorageAreaId: v })}
                        options={areaOptions}
                        placeholder={t('common.selectPlaceholder')}
                        size="touch"
                        wrapperClassName="w-40"
                        disabled={submitting}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      {needsReason ? (
                        <Textarea
                          rows={1}
                          value={d.discrepancyReason}
                          onChange={(e) => updateLine(l.id, { discrepancyReason: e.target.value })}
                          placeholder={t('common.reasonPlaceholder')}
                          error={
                            d.discrepancyReason.trim() === ''
                              ? t('validation.reasonRequired')
                              : undefined
                          }
                          disabled={submitting}
                          wrapperClassName="w-56"
                        />
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <PhotoCapture
          label={t('outlet.receiving.photoLabel')}
          value={photoFile ? URL.createObjectURL(photoFile) : null}
          onCapture={onPhotoChange}
          onRemove={() => onPhotoChange(null)}
          required
          disabled={submitting}
        />
        <SignaturePad
          label={t('outlet.receiving.signatureLabel')}
          value={signatureDataUrl}
          onChange={onSignatureChange}
          required
          disabled={submitting}
        />
      </div>

      <Button
        type="button"
        size="touch-lg"
        fullWidth
        loading={submitting}
        disabled={!canSubmit}
        onClick={() => onSubmit(draftList)}
      >
        {t('outlet.receiving.confirm')}
      </Button>
    </div>
  );
}
