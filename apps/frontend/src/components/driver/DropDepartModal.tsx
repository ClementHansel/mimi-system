'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, TempInput, toast } from '@/components/ui';
import { getDriverRuntime, useActorMeta, mintId } from './lib/driver-runtime';
import type { Drop, SuratJalan } from './lib/types';
import type { Temp } from '@/lib/shared-types';

/**
 * "Berangkat" — the first of the three per-drop actions (D-14). `frozen`
 * shipments (the cold-chain truck, carrying chilled AND frozen goods
 * together) get a load-temp reading before departure. Whether that reading
 * is a breach depends on which classes (chiller 0..5°C / freezer -25..-15°C)
 * are onboard — only the backend can resolve that per-class evaluation
 * (`cold-chain.ts`'s doc comment), so this form never guesses; it submits
 * whatever the driver reads, never blocked, and the breach verdict shows up
 * later on the synced log. Commits via `commitDropDeparted` +, when a temp
 * was entered, `commitTempLog` — both local-only, queued through the offline
 * outbox (`ReceivingPanel.offline.test.ts` is the proof-shape this mirrors;
 * `DriverJobsPanel.offline.test.ts` is this surface's own).
 */
export interface DropDepartModalProps {
  open: boolean;
  onClose: () => void;
  sj: SuratJalan;
  drop: Drop;
  onDone: (patch: Partial<Drop>) => void;
}

export function DropDepartModal({ open, onClose, sj, drop, onDone }: DropDepartModalProps) {
  const { t } = useI18n();
  const actor = useActorMeta();
  const [tempC, setTempC] = useState<Temp | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isFrozen = sj.shipmentType === 'frozen';
  const canSubmit = !isFrozen || tempC !== null;

  async function handleSubmit() {
    if (!actor || !canSubmit) return;
    setSubmitting(true);
    try {
      const runtime = await getDriverRuntime();
      // Stamped at the moment of the actual action (tap), not captured
      // earlier at render — the event's own instant, per this ticket's
      // "timestamp from the event, never new Date() at render" rule.
      const at = new Date().toISOString();
      await runtime.commitDropDeparted(
        drop.id,
        { dropId: drop.id, at, tempC: tempC ?? undefined },
        actor,
      );
      if (tempC !== null) {
        await runtime.commitTempLog(
          mintId(),
          { sjId: sj.id, dropId: drop.id, stage: 'depart', tempC },
          actor,
        );
      }
      toast({ title: t('driver.depart.queued'), variant: 'success' });
      // Optimistic local patch — the whole point of committing offline is
      // that `getMyJobs` won't necessarily succeed again right now to hand
      // back a fresh status, so the UI advances from the commit result
      // itself, not from a refetch.
      onDone({ status: 'en_route', departedAt: at });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('driver.depart.title', { location: drop.locationName })}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <TempInput
          label={t('driver.depart.tempLabel')}
          value={tempC}
          onChange={setTempC}
          required={isFrozen}
          size="touch"
        />
        <Button
          type="button"
          size="touch-lg"
          fullWidth
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t('driver.depart.submit')}
        </Button>
      </div>
    </Modal>
  );
}
