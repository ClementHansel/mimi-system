'use client';

import { useState } from 'react';
import { LockOpen, UserRoundX } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/dates';
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
import { usePosShiftStore, type OpenShift } from './shift-store';
import { ShiftCloseModal } from './ShiftCloseModal';
import { apiErrorDetail } from '@/lib/api-error';

/**
 * "Buka Kasir" (FR-POS-02). Fully local in every connectivity tier
 * (SYNC-PROTOCOL §8 row 16) — always enabled regardless of `tier`.
 *
 * Two states, because a shared till has two ways of arriving here. Usually
 * nothing is open and this is the opening form. But when the PREVIOUS
 * cashier left a shift open on this browser (`openByOtherCashier`), opening a
 * second one is refused the way the backend's own interactive
 * `PosShiftService.open` refuses it — "A shift is already open for this
 * location/device" — and the cashier is offered the handover instead: count
 * the drawer, close the shift that is actually open, then open theirs.
 *
 * Which is a change of stance, not just of copy. Before MA-191 this screen
 * was never reached in that case at all: the till adopted the leftover shift
 * as the new cashier's own. See `OpenShift.kasirUserId`.
 */
export function ShiftOpenForm({
  runtime,
  actor,
  locationId,
  kasirName,
  openByOtherCashier = null,
}: {
  runtime: LocalRuntime;
  actor: ActorMeta;
  locationId: UUID;
  kasirName: string;
  /** A shift open on this device belonging to somebody else — see the header. */
  openByOtherCashier?: OpenShift | null;
}) {
  const { t } = useI18n();
  const [openingCash, setOpeningCash] = useState<Money | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Minted once at draft time (this component's mount), reused on every
  // retry of the SAME open attempt — SYNC-PROTOCOL §2.2 rule 3 double-tap
  // guard. A fresh mount (new shift attempt) gets a fresh id via useState's
  // lazy initializer.
  const [shiftId] = useState<string>(() => mintClientId());
  const [handoverOpen, setHandoverOpen] = useState(false);
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
      openShift({
        shiftId,
        locationId,
        openingCash,
        openedAt: occurredAt,
        kasirName,
        kasirUserId: actor.actorUserId,
      });
      toast({ title: t('pos.shiftOpenedTitle'), variant: 'success' });
    } catch (err) {
      toast({
        title: t('pos.shiftOpenFailed'),
        description: apiErrorDetail(err),
        variant: 'danger',
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (openByOtherCashier) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRoundX className="size-5 text-warning-600" aria-hidden />
              {t('pos.handoverTitle')}
            </CardTitle>
            <CardDescription>
              {t('pos.handoverDescription', { name: openByOtherCashier.kasirName })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* The description above already names the cashier, so this only
                carries what it does not: WHEN, which is how the person at the
                till recognises which shift they are being asked to close. */}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-muted">{t('pos.shiftOpenedAtLabel')}</dt>
              <dd className="text-right font-medium tabular-nums text-text-primary">
                {fmtDateTime(openByOtherCashier.openedAt)}
              </dd>
            </dl>
            <p className="text-sm text-text-muted">{t('pos.handoverBody')}</p>
            <Button size="touch-lg" fullWidth onClick={() => setHandoverOpen(true)}>
              {t('pos.handoverCloseSubmit', { name: openByOtherCashier.kasirName })}
            </Button>
          </CardContent>
        </Card>

        {/* The same "Tutup Kasir" dialog the shift's own cashier would use.
            `actor` is the person standing at the till NOW, so the closing fact
            records THEM as `closed_by` against the previous cashier's
            `opened_by` — which is what a handover actually is, and is exactly
            the pair `PosShiftService.close` already stores. */}
        <ShiftCloseModal
          open={handoverOpen}
          onClose={() => setHandoverOpen(false)}
          runtime={runtime}
          actor={actor}
          shift={openByOtherCashier}
        />
      </div>
    );
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
