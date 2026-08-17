'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, Textarea, toast } from '@/components/ui';
import { failDrop } from './lib/driver-api';
import type { Drop } from './lib/types';

/**
 * "Gagal Kirim" — outlet closed / unreachable (D-14). Unlike the other three
 * drop actions, `sj_drops.failed` has no offline schema mapping yet
 * (`driver-api.ts`'s doc comment), so this is a plain online call: it
 * requires connectivity and surfaces a clear error rather than silently
 * pretending to queue when it can't reach the cloud.
 */
export interface DropFailModalProps {
  open: boolean;
  onClose: () => void;
  drop: Drop;
  onDone: (patch: Partial<Drop>) => void;
}

export function DropFailModal({ open, onClose, drop, onDone }: DropFailModalProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = reason.trim() !== '';

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await failDrop(drop.id, reason.trim());
      toast({ title: t('driver.fail.success'), variant: 'success' });
      onDone({ status: 'failed', discrepancyNotes: reason.trim() });
    } catch {
      toast({ title: t('driver.fail.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('driver.fail.title', { location: drop.locationName })} size="sm">
      <div className="flex flex-col gap-4">
        <Textarea
          label={t('driver.fail.reasonLabel')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('common.reasonPlaceholder')}
          required
          disabled={submitting}
        />
        <Button type="button" variant="danger" size="touch-lg" fullWidth loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
          {t('driver.fail.submit')}
        </Button>
      </div>
    </Modal>
  );
}
