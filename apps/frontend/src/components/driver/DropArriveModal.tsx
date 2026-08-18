'use client';

import { useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, TempInput, Textarea, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { getDriverRuntime, useActorMeta, mintId } from './lib/driver-runtime';
import { sealForDrop } from './lib/cold-chain';
import type { Drop, SuratJalan } from './lib/types';
import type { Temp } from '@/lib/shared-types';

/**
 * "Tiba di Lokasi" — arrival at a drop's outlet. Per `@mimi/sync-protocol`'s
 * schema registry, `sj_drops.arrived.tempC` is REQUIRED regardless of
 * shipment type (unlike `departed`'s optional temp) — the wire contract this
 * component follows, not CONTRACTS.md's looser prose. Seal verification only
 * shows when the Surat Jalan actually tracked a seal for this drop
 * (`sealForDrop` — SJ-wide seals apply to every drop on the route).
 *
 * No client-side breach guess: a `frozen` SJ carries both chilled and
 * frozen goods, and which range applies is a per-class, backend-only
 * evaluation (`cold-chain.ts`'s doc comment). This form submits the reading
 * as entered — never blocked — and leaves the breach verdict to the synced
 * `TempLog.isBreach` shown later in `DropCard`.
 */
export interface DropArriveModalProps {
  open: boolean;
  onClose: () => void;
  sj: SuratJalan;
  drop: Drop;
  onDone: (patch: Partial<Drop>) => void;
}

export function DropArriveModal({ open, onClose, sj, drop, onDone }: DropArriveModalProps) {
  const { t } = useI18n();
  const actor = useActorMeta();
  const [tempC, setTempC] = useState<Temp | null>(null);
  const [sealStatus, setSealStatus] = useState<'verified_intact' | 'broken' | null>(null);
  const [sealNotes, setSealNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const seal = sealForDrop(sj, drop.id);
  const sealOk = !seal || sealStatus !== null;
  const notesOk = sealStatus !== 'broken' || sealNotes.trim() !== '';
  const canSubmit = tempC !== null && sealOk && notesOk;

  async function handleSubmit() {
    if (!actor || !canSubmit) return;
    setSubmitting(true);
    try {
      const runtime = await getDriverRuntime();
      const at = new Date().toISOString();
      await runtime.commitDropArrived(
        drop.id,
        {
          dropId: drop.id,
          at,
          tempC,
          sealCheck:
            seal && sealStatus
              ? { sealId: seal.id, status: sealStatus, notes: sealNotes || undefined }
              : undefined,
        },
        actor,
      );
      await runtime.commitTempLog(
        mintId(),
        { sjId: sj.id, dropId: drop.id, stage: 'arrive', tempC },
        actor,
      );
      toast({ title: t('driver.arrive.queued'), variant: 'success' });
      onDone({ status: 'arrived', arrivedAt: at });
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
      title={t('driver.arrive.title', { location: drop.locationName })}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <TempInput
          label={t('driver.arrive.tempLabel')}
          value={tempC}
          onChange={setTempC}
          required
          size="touch"
        />

        {seal && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">
              {t('driver.arrive.sealLabel')} — {seal.sealNumber}
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSealStatus('verified_intact')}
                className={cn(
                  'flex h-touch-lg flex-col items-center justify-center gap-1 rounded-lg border-2 font-medium transition-colors',
                  sealStatus === 'verified_intact'
                    ? 'border-success-600 bg-success-50 text-success-700'
                    : 'border-border-strong text-text-secondary hover:bg-surface-sunken',
                )}
              >
                <ShieldCheck className="size-6" aria-hidden />
                {t('driver.arrive.sealIntact')}
              </button>
              <button
                type="button"
                onClick={() => setSealStatus('broken')}
                className={cn(
                  'flex h-touch-lg flex-col items-center justify-center gap-1 rounded-lg border-2 font-medium transition-colors',
                  sealStatus === 'broken'
                    ? 'border-danger-600 bg-danger-50 text-danger-700'
                    : 'border-border-strong text-text-secondary hover:bg-surface-sunken',
                )}
              >
                <ShieldAlert className="size-6" aria-hidden />
                {t('driver.arrive.sealBroken')}
              </button>
            </div>
            {sealStatus === 'broken' && (
              <Textarea
                label={t('driver.arrive.sealNotes')}
                value={sealNotes}
                onChange={(e) => setSealNotes(e.target.value)}
                placeholder={t('common.reasonPlaceholder')}
                error={sealNotes.trim() === '' ? t('validation.reasonRequired') : undefined}
              />
            )}
          </div>
        )}

        <Button
          type="button"
          size="touch-lg"
          fullWidth
          loading={submitting}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t('driver.arrive.submit')}
        </Button>
      </div>
    </Modal>
  );
}
