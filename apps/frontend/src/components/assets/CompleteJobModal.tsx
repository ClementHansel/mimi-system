'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Modal,
  Button,
  MoneyInput,
  Input,
  Textarea,
  PhotoCapture,
  Select,
  toast,
} from '@/components/ui';
import { completeJob } from './lib/assets-api';
import { uploadAttachment } from './lib/attachments';
import type { Job } from './lib/types';
import type { Money } from '@/lib/shared-types';

const CONDITIONS = ['good', 'fair', 'poor'] as const;

/**
 * "Menyelesaikan tugas maintenance dengan bukti foto dan catatan kondisi"
 * (this ticket's F09 brief, FR-PMS-04): proof photo wajib, condition-after
 * required, cost/vendor/odometer optional. Shared by both the "Jatuh Tempo"
 * and "Tugas Maintenance" tabs — completing a job reads the same either way,
 * regardless of which list the driver/technician opened it from.
 */
export function CompleteJobModal({
  job,
  onClose,
  onDone,
}: {
  job: Job;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [photo, setPhoto] = useState<File | null>(null);
  const [cost, setCost] = useState<Money | null>(null);
  const [vendor, setVendor] = useState('');
  const [conditionAfter, setConditionAfter] = useState<string>('good');
  const [odometerKm, setOdometerKm] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = photo !== null;

  async function handleSubmit() {
    if (!photo || !canSubmit) return;
    setSubmitting(true);
    try {
      const proofAttachmentId = await uploadAttachment({
        file: photo,
        fileName: photo.name,
        mimeType: photo.type || 'image/jpeg',
        kind: 'maintenance_proof',
      });
      await completeJob(job.id, {
        proofAttachmentIds: [proofAttachmentId],
        cost: cost ?? undefined,
        vendor: vendor || undefined,
        conditionAfter,
        odometerKm: odometerKm ? Number(odometerKm) : undefined,
        notes: notes || undefined,
      });
      toast({ title: t('assets.jobs.completeSuccess'), variant: 'success' });
      onDone();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('assets.jobs.completeTitle', { name: job.assetName })}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <PhotoCapture
          label={t('assets.jobs.proofPhotoLabel')}
          value={photo ? URL.createObjectURL(photo) : null}
          onCapture={setPhoto}
          onRemove={() => setPhoto(null)}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t('assets.jobs.conditionAfter')}
            value={conditionAfter}
            onValueChange={setConditionAfter}
            options={CONDITIONS.map((c) => ({ value: c, label: t(`assets.condition.${c}`) }))}
          />
          <MoneyInput label={t('assets.jobs.cost')} value={cost} onChange={setCost} />
          <Input
            label={t('assets.jobs.vendor')}
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
          <Input
            label={t('assets.jobs.odometerKm')}
            type="number"
            min={0}
            value={odometerKm}
            onChange={(e) => setOdometerKm(e.target.value)}
          />
        </div>
        <Textarea
          label={t('common.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <Button
          size="touch-lg"
          fullWidth
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t('assets.jobs.completeSubmit')}
        </Button>
      </div>
    </Modal>
  );
}
