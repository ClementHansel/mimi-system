'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, Textarea, toast } from '@/components/ui';
import { skipDrop } from './lib/driver-api';
import type { Drop } from './lib/types';

/**
 * "Lewati dulu" — defer this drop to the end of today's route.
 *
 * The action this screen was missing. Until now a driver who could not deliver
 * RIGHT NOW — outlet mid-rush, road closed, arrived before opening — had two
 * options, and both were wrong: leave the drop sitting at the front of the
 * route blocking the order, or mark it failed. Failed is terminal AND reverses
 * the dispatch stock movement, so a driver still holding the goods would be
 * telling the system they had gone back to the warehouse. The next stock opname
 * inherits that lie.
 *
 * A skip closes nothing and moves no stock. The drop returns to `pending` at
 * the back of the queue and stays deliverable today.
 *
 * Online-only, like `DropFailModal` and for the same reason — `sj_drops` skip
 * has no sync-protocol schema mapping, and inventing one is a protocol decision
 * rather than a screen decision. It matters less here: a driver with no signal
 * simply drives to the next outlet, and the route order catches up on
 * reconnect.
 */
export interface DropSkipModalProps {
  open: boolean;
  onClose: () => void;
  drop: Drop;
  onDone: (patch: Partial<Drop>) => void;
}

export function DropSkipModal({ open, onClose, drop, onDone }: DropSkipModalProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Required, unlike most note fields. The value of a skip is the pattern it
  // reveals — an outlet skipped every Friday afternoon is a fact worth acting
  // on — and a run of blank reasons reveals nothing.
  const canSubmit = reason.trim() !== '';

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await skipDrop(drop.id, reason.trim());
      toast({ title: t('driver.skip.success'), variant: 'success' });
      // `pending`, not a skipped state: the server moved it to the back of the
      // route and it is still deliverable. Mirroring that here keeps the card
      // showing "belum" rather than implying the stop is done with.
      onDone({ status: 'pending' });
      onClose();
    } catch {
      toast({ title: t('driver.skip.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('driver.skip.title', { location: drop.locationName })}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t('driver.skip.explainer')}</p>
        <Textarea
          label={t('driver.skip.reasonLabel')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('common.reasonPlaceholder')}
          required
          disabled={submitting}
        />
        <Button
          type="button"
          variant="secondary"
          size="touch-lg"
          fullWidth
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t('driver.skip.submit')}
        </Button>
      </div>
    </Modal>
  );
}
