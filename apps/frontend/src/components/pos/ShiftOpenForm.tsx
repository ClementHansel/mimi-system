'use client';

import { useState } from 'react';
import { LockOpen } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  MoneyInput,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money, UUID } from '@/lib/shared-types';
import { mintClientId } from './pos-runtime';
import { usePosShiftStore } from './shift-store';

/**
 * "Buka Kasir" (FR-POS-02). Fully local in every connectivity tier
 * (SYNC-PROTOCOL §8 row 16) — always enabled regardless of `tier`.
 */
export function ShiftOpenForm({
  runtime,
  actor,
  locationId,
  kasirName,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  locationId: UUID;
  kasirName: string;
}) {
  const { t } = useI18n();
  const [openingCash, setOpeningCash] = useState<Money | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Minted once at draft time (this component's mount), reused on every
  // retry of the SAME open attempt — SYNC-PROTOCOL §2.2 rule 3 double-tap
  // guard. A fresh mount (new shift attempt) gets a fresh id via useState's
  // lazy initializer.
  const [shiftId] = useState<string>(() => mintClientId());
  const openShift = usePosShiftStore((s) => s.open);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!openingCash) return;
    setSubmitting(true);
    try {
      const occurredAt = new Date().toISOString();
      await runtime.commitShiftOpened(
        shiftId,
        { clientId: shiftId, locationId, openingCash, openedAt: occurredAt },
        actor,
      );
      openShift({ shiftId, locationId, openingCash, openedAt: occurredAt, kasirName });
      toast({ title: t('pos.shiftOpenedTitle'), variant: 'success' });
    } catch (err) {
      toast({
        title: t('pos.shiftOpenFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockOpen className="size-5 text-brand-600" aria-hidden />
            {t('pos.openShiftTitle')}
          </CardTitle>
          <CardDescription>{t('pos.openShiftDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <MoneyInput
              label={t('pos.openingCash')}
              value={openingCash}
              onChange={setOpeningCash}
              required
              size="touch"
              hint={t('pos.openingCashHint')}
            />
            <Button
              type="submit"
              size="touch-lg"
              fullWidth
              loading={submitting}
              disabled={!openingCash}
            >
              {t('pos.openShiftSubmit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
