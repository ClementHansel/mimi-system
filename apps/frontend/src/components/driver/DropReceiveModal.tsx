'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Modal, Button, Card, CardContent, PhotoCapture, SignaturePad, QtyInput, Select, Textarea, TempInput, toast,
} from '@/components/ui';
import { formatQty } from '@/lib/formatters';
import { dataUrlToFile } from './lib/attachments';
import { getDriverRuntime, useActorMeta, mintId } from './lib/driver-runtime';
import { getStorageAreas } from './lib/driver-api';
import { isFrozenBreach } from './lib/cold-chain';
import type { Drop, StorageArea, SuratJalan } from './lib/types';
import type { Qty, Temp } from '@/lib/shared-types';

interface LineDraft {
  lineId: string;
  qtyReceived: Qty | null;
  receivedStorageAreaId: string;
  discrepancyReason: string;
}

function lineNeedsReason(qtySent: Qty, draft: LineDraft): boolean {
  if (draft.qtyReceived === null) return false;
  return draft.qtyReceived !== qtySent;
}

/**
 * "Serah Terima" — the last of the three per-drop actions and the fraud-
 * control checkpoint of the whole flow (FR-LOG-14/15/16): photo wajib,
 * signature wajib, any sent≠received line demands a discrepancy reason.
 * Same gating vocabulary as `outlet/ReceiveDropForm.tsx` (this ticket's
 * direct model) reimplemented here rather than imported, since that
 * component lives outside this surface's owned paths. Commits through
 * `commitDropReceived`; both evidence blobs go through `captureEvidence`
 * first, and — unlike the bug this ticket flagged upstream — this component
 * uses each `AttachmentRef`'s OWN returned `attachmentId`, not a freshly
 * minted one, so the event's `photoAttachmentIds`/`signatureAttachmentId`
 * actually correlate to the stored blob (`attachment-store.ts`'s "TWO
 * IDENTITIES, ONE ROW").
 */
export interface DropReceiveModalProps {
  open: boolean;
  onClose: () => void;
  sj: SuratJalan;
  drop: Drop;
  onDone: (patch: Partial<Drop>) => void;
}

export function DropReceiveModal({ open, onClose, sj, drop, onDone }: DropReceiveModalProps) {
  const { t } = useI18n();
  const actor = useActorMeta();
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [tempC, setTempC] = useState<Temp | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lines, setLines] = useState<Record<string, LineDraft>>({});

  useEffect(() => {
    if (!open) return;
    getStorageAreas(drop.locationId).then(setAreas).catch(() => setAreas([]));
    setLines(
      Object.fromEntries(
        drop.lines.map((l) => [
          l.id,
          { lineId: l.id, qtyReceived: l.qty, receivedStorageAreaId: l.receivedStorageAreaId ?? '', discrepancyReason: '' },
        ]),
      ),
    );
    setPhotoFile(null);
    setSignature(null);
    setTempC(null);
    // Re-seeds the draft whenever a NEW drop is opened for serah-terima —
    // deliberately keyed on `open`/`drop.id`, not re-running on every
    // keystroke (drop.lines is derived from drop.id and intentionally
    // excluded from the dependency list for that reason).
  }, [open, drop.id, drop.locationId]);

  const areaOptions = useMemo(() => areas.map((a) => ({ value: a.id, label: a.name })), [areas]);
  const draftList = useMemo(() => drop.lines.map((l) => lines[l.id]).filter((d): d is LineDraft => !!d), [drop.lines, lines]);
  const breach = isFrozenBreach(tempC, sj.shipmentType);

  function updateLine(lineId: string, patch: Partial<LineDraft>) {
    setLines((prev) => ({ ...prev, [lineId]: { ...prev[lineId]!, ...patch } }));
  }

  const photoOk = photoFile !== null;
  const signatureOk = !!signature;
  const linesOk = drop.lines.every((l) => {
    const d = lines[l.id];
    if (!d) return false;
    if (d.qtyReceived === null) return false;
    if (!d.receivedStorageAreaId) return false;
    if (lineNeedsReason(l.qty, d) && d.discrepancyReason.trim() === '') return false;
    return true;
  });
  const canSubmit = photoOk && signatureOk && linesOk;

  async function handleSubmit() {
    if (!actor || !canSubmit || !photoFile || !signature) return;
    setSubmitting(true);
    try {
      const runtime = await getDriverRuntime();
      const photoRef = await runtime.captureEvidence(photoFile, photoFile.type || 'image/jpeg', 'delivery_receiving_photo');
      const signatureFile = dataUrlToFile(signature, 'signature.png');
      const signatureRef = await runtime.captureEvidence(signatureFile, signatureFile.type, 'delivery_receiving_signature');

      await runtime.commitDropReceived(
        drop.id,
        {
          dropId: drop.id,
          lines: draftList.map((l) => ({
            lineId: l.lineId,
            qtyReceived: l.qtyReceived as string,
            receivedStorageAreaId: l.receivedStorageAreaId,
            discrepancyReason: l.discrepancyReason || undefined,
          })),
          photoAttachmentIds: [photoRef.attachmentId],
          signatureAttachmentId: signatureRef.attachmentId,
          tempC: tempC ?? undefined,
          clientId: mintId(),
        },
        actor,
      );

      toast({ title: t('driver.receive.queued'), variant: 'success' });
      const hasDiscrepancy = draftList.some((l) => {
        const sent = drop.lines.find((dl) => dl.id === l.lineId)?.qty;
        return sent !== undefined && l.qtyReceived !== null && l.qtyReceived !== sent;
      });
      onDone({
        status: hasDiscrepancy ? 'completed_discrepancy' : 'completed',
        receivedAt: new Date().toISOString(),
        lines: drop.lines.map((l) => {
          const d = lines[l.id];
          return d
            ? { ...l, qtyReceived: d.qtyReceived, receivedStorageAreaId: d.receivedStorageAreaId || null, discrepancyReason: d.discrepancyReason || null }
            : l;
        }),
      });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('driver.receive.title', { location: drop.locationName })} size="xl">
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="flex flex-col gap-3 p-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                  <th className="px-3 py-2">{t('driver.receive.item')}</th>
                  <th className="px-3 py-2">{t('driver.receive.qtySent')}</th>
                  <th className="px-3 py-2">{t('driver.receive.qtyReceived')}</th>
                  <th className="px-3 py-2">{t('driver.receive.storageArea')}</th>
                  <th className="px-3 py-2">{t('driver.receive.discrepancyReason')}</th>
                </tr>
              </thead>
              <tbody>
                {drop.lines.map((l) => {
                  const d = lines[l.id];
                  if (!d) return null;
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
                            error={d.discrepancyReason.trim() === '' ? t('validation.reasonRequired') : undefined}
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

        <div className="grid gap-4 sm:grid-cols-3">
          <PhotoCapture
            label={t('driver.receive.photoLabel')}
            value={photoFile ? URL.createObjectURL(photoFile) : null}
            onCapture={setPhotoFile}
            onRemove={() => setPhotoFile(null)}
            required
            disabled={submitting}
          />
          <SignaturePad
            label={t('driver.receive.signatureLabel')}
            value={signature}
            onChange={setSignature}
            required
            disabled={submitting}
          />
          <TempInput
            label={t('driver.receive.tempLabel')}
            value={tempC}
            onChange={setTempC}
            breach={breach}
            size="touch"
            hint={breach ? t('driver.coldChain.breach') : undefined}
          />
        </div>

        <Button type="button" size="touch-lg" fullWidth loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
          {t('driver.receive.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
