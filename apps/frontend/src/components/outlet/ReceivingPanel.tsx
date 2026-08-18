'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, StatusBadge, EmptyState, Card, CardContent, toast } from '@/components/ui';
import { fmtDateTime } from '@/lib/dates';
import { useOutletLocation } from './lib/use-outlet-location';
import { listIncomingSuratJalan, getStorageAreas } from './lib/outlet-api';
import { dataUrlToFile } from './lib/attachments';
import { useActorMeta, getOutletRuntime, mintId } from './lib/outlet-runtime';
import { ReceiveDropForm, type ReceiveLineDraft } from './ReceiveDropForm';
import type { SuratJalan, Drop, StorageArea } from './lib/types';

const OPEN_DROP_STATUSES = new Set(['pending', 'en_route', 'arrived']);

/**
 * "Terima barang": receive a Surat Jalan drop. Photo wajib, signature
 * captured, per-line discrepancy recorded — the fraud-control checkpoint of
 * the goods-in flow (FR-LOG-14/15/16), and RISK-02's scenario: a driver at
 * the door with frozen chicken and no internet. Unlike the other five outlet
 * flows, `LocalRuntime` already exposes a named helper for this one
 * (`commitDropReceived`, alongside `commitDropDeparted/Arrived` and
 * `commitTempLog`) — so the submit path here goes through the offline
 * outbox (`captureEvidence` for the photo/signature bytes,
 * `commitDropReceived` for the fact), not a live REST call. Confirmed to
 * queue with the network down — see `ReceivingPanel.offline.test.ts`.
 *
 * The drop LIST is still a plain online read (`listIncomingSuratJalan`):
 * there is no local cache of pending Surat Jalan on this device, so a true
 * "blind receipt" (SYNC-PROTOCOL §8 row 6 — the device never cached the SJ
 * at all) isn't reachable from this screen yet. That's a separate,
 * larger feature (manual SJ/line entry) than the "wire the submit through
 * the outbox" ask this rewire covers, and is flagged as a follow-up rather
 * than attempted here.
 */
export function ReceivingPanel() {
  const { t } = useI18n();
  const { locationId } = useOutletLocation();
  const actor = useActorMeta();
  const [sjList, setSjList] = useState<SuratJalan[]>([]);
  const [areas, setAreas] = useState<StorageArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDrop, setActiveDrop] = useState<Drop | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    listIncomingSuratJalan(locationId)
      .then((res) => setSjList(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId]);
  useEffect(() => {
    if (locationId) getStorageAreas(locationId).then(setAreas);
  }, [locationId]);

  const incomingDrops = sjList.flatMap((sj) =>
    sj.drops
      .filter((d) => d.locationId === locationId && OPEN_DROP_STATUSES.has(d.status))
      .map((d) => ({ sj, drop: d })),
  );

  function openReceive(drop: Drop) {
    setActiveDrop(drop);
    setPhotoFile(null);
    setSignature(null);
  }

  async function handleSubmit(lines: ReceiveLineDraft[]) {
    if (!activeDrop || !photoFile || !signature || !actor) return;
    setSubmitting(true);
    try {
      const runtime = await getOutletRuntime();

      // Bytes go into the local attachment side-channel (sha256-deduped,
      // uploaded cloud-direct whenever WAN is up — `captureEvidence` never
      // makes a network call itself). The event payload MUST carry the ref's
      // own `attachmentId` (W2-E's canonical id, resolved cloud-side via
      // `X-Attachment-Id`) — NOT a freshly minted id, which would point at
      // nothing and silently break the FR-LOG-15 wajib-foto evidence trail.
      const photoRef = await runtime.captureEvidence(
        photoFile,
        photoFile.type || 'image/jpeg',
        'receiving_photo',
      );
      const photoAttachmentId = photoRef.attachmentId;

      const signatureFile = dataUrlToFile(signature, 'signature.png');
      const signatureRef = await runtime.captureEvidence(
        signatureFile,
        signatureFile.type,
        'receiving_signature',
      );
      const signatureAttachmentId = signatureRef.attachmentId;

      await runtime.commitDropReceived(
        activeDrop.id,
        {
          dropId: activeDrop.id,
          lines: lines.map((l) => ({
            lineId: l.lineId,
            qtyReceived: l.qtyReceived as string,
            receivedStorageAreaId: l.receivedStorageAreaId,
            discrepancyReason: l.discrepancyReason || undefined,
          })),
          photoAttachmentIds: [photoAttachmentId],
          signatureAttachmentId,
          clientId: mintId(),
        },
        actor,
      );

      toast({ title: t('outlet.receiving.queued'), variant: 'success' });
      setActiveDrop(null);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  if (!locationId) return <EmptyState title={t('table.error')} size="lg" />;
  if (loading) return <EmptyState title={t('table.loading')} size="lg" />;
  if (incomingDrops.length === 0)
    return <EmptyState title={t('outlet.receiving.empty')} size="lg" />;

  return (
    <div className="flex flex-col gap-3">
      {incomingDrops.map(({ sj, drop }) => (
        <Card
          key={drop.id}
          className="cursor-pointer hover:bg-surface-sunken"
          onClick={() => openReceive(drop)}
        >
          <CardContent className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-text-primary">{sj.sjNumber}</p>
              <p className="text-sm text-text-muted">
                {t('outlet.receiving.driver')}: {sj.driver.name} — {drop.lines.length} item
              </p>
              {drop.arrivedAt && (
                <p className="text-xs text-text-muted">{fmtDateTime(drop.arrivedAt)}</p>
              )}
            </div>
            <StatusBadge domain="drop" status={drop.status} />
          </CardContent>
        </Card>
      ))}

      <Modal
        open={!!activeDrop}
        onClose={() => setActiveDrop(null)}
        title={t('outlet.receiving.title')}
        size="xl"
      >
        {activeDrop && (
          <ReceiveDropForm
            drop={activeDrop}
            storageAreas={areas}
            photoFile={photoFile}
            onPhotoChange={setPhotoFile}
            signatureDataUrl={signature}
            onSignatureChange={setSignature}
            submitting={submitting}
            onSubmit={handleSubmit}
          />
        )}
      </Modal>
    </div>
  );
}
