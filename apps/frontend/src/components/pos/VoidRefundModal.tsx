'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Modal,
  Button,
  Card,
  CardContent,
  Input,
  MoneyInput,
  Select,
  Textarea,
  PhotoCapture,
  Badge,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useConnectivityStore } from '@/stores/connectivity-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money, UUID } from '@/lib/shared-types';
import { getUnlockChallenge, redeemUnlockCode } from '@/lib/local/credentials/offline-credentials';
import {
  mintClientId,
  listCachedApproverCredentials,
  type CachedApproverOption,
} from './pos-runtime';
import { usePosShiftStore } from './shift-store';
import { apiErrorDetail } from '@/lib/api-error';

/**
 * Void/refund (FR-POS-03) — ALWAYS requires supervisor authorization, never
 * kasir-only (SYNC-PROTOCOL §8 row 3).
 *
 * ONLINE, since B-15 (owner Q8, 2026-08-22), this is a TWO-STEP flow and the
 * modal stays open between the steps:
 *
 *   1. The kasir submits the request. Eligible supervisors are notified.
 *   2. A supervisor authorises it from their own screen — anywhere, which is
 *      the point (a swapped shift, someone off sick) — and reads back a
 *      six-digit one-time code. The kasir types it here to finish.
 *
 * The modal does not close between the two, because closing it would strand a
 * pending void with no obvious way back to it, and the code expires in five
 * minutes. The supervisor's PIN field is GONE from the online path: there is no
 * longer any standing secret to type, which is what B-15 was.
 *
 * OFFLINE/LAN is unchanged and still PIN-based against a cached credential —
 * no server exists to mint a code when the outlet has no internet. It remains
 * explicitly provisional, labeled "awaiting verification", never shown as a
 * done deal.
 */
export function VoidRefundModal({
  open,
  onClose,
  runtime,
  actor,
  saleId,
}: {
  open: boolean;
  onClose: () => void;
  runtime: LocalRuntime;
  actor: ActorMeta;
  saleId: UUID;
}) {
  const { t } = useI18n();
  const tier = useConnectivityStore((s) => s.tier);
  const isOnline = tier === 'online';
  const recordVoid = usePosShiftStore((s) => s.recordVoid);

  const [type, setType] = useState<'void' | 'refund'>('void');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState<Money | null>(null);
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  /** Set once the online request exists — this is what flips the modal to step 2. */
  const [pendingVoidId, setPendingVoidId] = useState<UUID | null>(null);
  /**
   * B-17 — set when the SELECTED offline credential is terminally locked on this
   * device. Carries the challenge to read down the phone and how many unlock
   * attempts are left.
   */
  const [unlock, setUnlock] = useState<{ challenge: string; attemptsLeft: number } | null>(null);
  const [unlockCode, setUnlockCode] = useState('');
  const [selfie, setSelfie] = useState<{ file: File; preview: string } | null>(null);

  const [approvers, setApprovers] = useState<CachedApproverOption[]>([]);
  const [credentialId, setCredentialId] = useState('');
  /**
   * RISK-S2 — is a selfie MANDATORY for this particular approval?
   *
   * The threshold is the selected credential's own `selfieRequiredAboveIdr`
   * (§7.2), which is exactly what `authorizeOffline` compares against. Deriving
   * it here rather than hardcoding keeps the UI and the authorizer from ever
   * disagreeing about what "above the threshold" means.
   *
   * Before this, the camera was offered unconditionally and was optional: a
   * supervisor voiding a large sale could skip it, enter their PIN, tap
   * approve, and only then be told `selfie_required` — with a customer
   * waiting. A control that presents as an unexplained refusal after the work
   * is done is one people learn to route around, which is the opposite of what
   * this risk wanted.
   *
   * Only applies OFFLINE. Online, the supervisor is authenticated against the
   * server directly and no credential is involved.
   */
  const selectedApprover = approvers.find((a) => a.credentialId === credentialId);
  const selfieRequired =
    !isOnline &&
    amount !== null &&
    selectedApprover !== undefined &&
    Number(amount) >= Number(selectedApprover.selfieRequiredAboveIdr);
  const selfieMissing = selfieRequired && selfie === null;
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || isOnline) return;
    listCachedApproverCredentials(runtime)
      .then(setApprovers)
      .catch(() => setApprovers([]));
  }, [open, isOnline, runtime]);

  // B-17 — a locked credential must announce itself BEFORE the supervisor types
  // a PIN that cannot possibly work. Three sessions of this project were lost to
  // features that existed but were unreachable by the role that needed them; an
  // unlock path nobody is shown is the same failure.
  useEffect(() => {
    if (!open || isOnline || !credentialId) {
      setUnlock(null);
      return;
    }
    getUnlockChallenge(runtime.db, credentialId as UUID)
      .then(setUnlock)
      .catch(() => setUnlock(null));
  }, [open, isOnline, credentialId, runtime]);

  async function handleUnlock() {
    if (!credentialId) return;
    const outcome = await redeemUnlockCode(runtime.db, credentialId as UUID, unlockCode);
    if (outcome.ok) {
      setUnlock(null);
      setUnlockCode('');
      toast({ title: t('pos.voidUnlockSuccess'), variant: 'success' });
      return;
    }
    setUnlockCode('');
    if (outcome.reason === 'attempts_exhausted') {
      setUnlock({ challenge: unlock?.challenge ?? '', attemptsLeft: 0 });
      toast({ title: t('pos.voidUnlockExhausted'), variant: 'danger' });
      return;
    }
    setUnlock((prev) => (prev ? { ...prev, attemptsLeft: outcome.attemptsLeft } : prev));
    toast({
      title: t('pos.voidUnlockInvalid'),
      description: t('pos.voidUnlockAttemptsLeft', { count: String(outcome.attemptsLeft) }),
      variant: 'danger',
    });
  }

  const awaitingCode = isOnline && pendingVoidId !== null;

  async function handleSubmit() {
    if (awaitingCode) {
      if (!/^\d{6}$/.test(code)) {
        toast({ title: t('pos.voidCodeRequired'), variant: 'danger' });
        return;
      }
    } else if (!reason.trim()) {
      toast({ title: t('validation.reasonRequired'), variant: 'danger' });
      return;
    }
    setSubmitting(true);
    try {
      if (isOnline) {
        // STEP 2 — a request already exists and we are redeeming the
        // supervisor's code. Kept separate from step 1 so a wrong code costs a
        // retry, never a duplicate void request.
        if (pendingVoidId) {
          await api.post(`/api/pos/void-refunds/${pendingVoidId}/approve`, { code });
          toast({ title: t('pos.voidApprovedTitle'), variant: 'success' });
          recordVoid();
          onClose();
          return;
        }

        // STEP 1 — raise the request and wait for a code. Nothing is approved
        // yet, and the copy says so rather than implying the void is done.
        const clientId = mintClientId();
        const req = await api.post<{ voidRefundId: UUID; status: string }>(
          `/api/pos/sales/${saleId}/void-request`,
          {
            clientId,
            type,
            reason,
            amount: amount ?? undefined,
          },
        );
        setPendingVoidId(req.voidRefundId);
        toast({
          title: t('pos.voidRequestedTitle'),
          description: t('pos.voidRequestedWaitingCode'),
          variant: 'info',
        });
        setSubmitting(false);
        return;
      } else {
        if (!credentialId) {
          toast({ title: t('pos.voidNoCredential'), variant: 'danger' });
          setSubmitting(false);
          return;
        }
        let selfieRef;
        if (selfie)
          selfieRef = await runtime.captureEvidence(
            selfie.file,
            selfie.file.type,
            'void_refund_selfie',
          );
        const result = await runtime.commitVoidApprovedOffline({
          voidRefundId: mintClientId(),
          credentialId,
          pin,
          amountIdr: amount,
          selfieRef,
          occurredAt: new Date().toISOString(),
          actor,
        });
        if (!result.authorization.ok) {
          // B-17 — a cooldown carries how long to wait. "Try again shortly" with
          // no number is the kind of message that gets tapped repeatedly, which
          // is exactly what the cooldown is trying to stop.
          const wait = result.authorization.retryAfterSeconds;
          toast({
            title: t('pos.voidAuthFailed'),
            description:
              wait !== undefined
                ? t('pos.voidAuthReasonCoolingDownFor', { seconds: String(wait) })
                : t(`pos.voidAuthReason.${result.authorization.reason}`),
            variant: 'danger',
          });
          setSubmitting(false);
          return;
        }
        toast({
          title: t('pos.voidProvisionalTitle'),
          description: t('pos.voidProvisionalDescription'),
          variant: 'warning',
        });
      }
      recordVoid();
      onClose();
    } catch (err) {
      toast({ title: t('pos.voidFailed'), description: apiErrorDetail(err), variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pos.voidRefundTitle')}
      description={
        isOnline ? t('pos.voidRefundOnlineDescription') : t('pos.voidRefundOfflineDescription')
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={handleSubmit}
            loading={submitting}
            disabled={selfieMissing}
          >
            {awaitingCode ? t('pos.voidCodeSubmit') : t('pos.voidSubmit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!isOnline && (
          <Badge variant="warning" className="w-fit">
            <ShieldAlert className="size-3.5" aria-hidden />
            {t('pos.voidOfflineBadge')}
          </Badge>
        )}
        {!awaitingCode && (
          <Select
            label={t('pos.voidType')}
            value={type}
            onValueChange={(v) => setType(v as 'void' | 'refund')}
            options={[
              { value: 'void', label: t('pos.voidTypeVoid') },
              { value: 'refund', label: t('pos.voidTypeRefund') },
            ]}
          />
        )}
        {!awaitingCode && (
          <Textarea
            label={t('common.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            rows={2}
          />
        )}
        {!awaitingCode && (
          <MoneyInput
            label={t('pos.voidAmount')}
            value={amount}
            onChange={setAmount}
            hint={t('common.optional')}
          />
        )}

        {!isOnline && (
          <Select
            label={t('pos.voidApprover')}
            value={credentialId}
            onValueChange={setCredentialId}
            placeholder={t('common.selectPlaceholder')}
            options={approvers.map((a) => ({ value: a.credentialId, label: t(`role.${a.role}`) }))}
          />
        )}
        {/* Online step 2: the one-time code the supervisor read out. Not a
            password field — the cashier is typing digits someone just told them
            over the phone and needs to see whether they got them right. */}
        {awaitingCode && (
          <Input
            label={t('pos.voidCodeLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            hint={t('pos.voidCodeHint')}
            required
          />
        )}
        {/* B-17 — the offline recovery panel. Shown INSTEAD of nothing at all,
            which is what a supervisor used to get after five wrong PINs during
            an outage: a dead credential and no way back until connectivity
            returned. */}
        {!isOnline && unlock && (
          <Card className="border-warning-600/30 bg-warning-50/40">
            <CardContent className="flex flex-col gap-2 p-3">
              <div className="text-sm font-medium text-warning-700">{t('pos.voidUnlockTitle')}</div>
              <p className="text-sm text-fg-muted">{t('pos.voidUnlockExplainer')}</p>
              <div>
                <div className="text-xs text-fg-subtle">{t('pos.voidUnlockChallengeLabel')}</div>
                {/* Monospace and spaced out: this is read aloud down a phone line. */}
                <div
                  className="font-mono text-3xl font-bold tracking-[0.3em]"
                  data-testid="unlock-challenge"
                >
                  {unlock.challenge}
                </div>
              </div>
              {unlock.attemptsLeft > 0 ? (
                <>
                  <Input
                    label={t('pos.voidUnlockCodeLabel')}
                    value={unlockCode}
                    autoComplete="one-time-code"
                    maxLength={9}
                    onChange={(e) => setUnlockCode(e.target.value)}
                    hint={t('pos.voidUnlockAttemptsLeft', {
                      count: String(unlock.attemptsLeft),
                    })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={handleUnlock}
                  >
                    {t('pos.voidUnlockSubmit')}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-danger-700">{t('pos.voidUnlockExhausted')}</p>
              )}
            </CardContent>
          </Card>
        )}
        {/* The supervisor's standing PIN survives ONLY on the offline path,
            where there is no server to mint a code. Showing it online is what
            B-15 was. */}
        {!isOnline && (
          <Input
            label={t('pos.supervisorPin')}
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        )}
        {!isOnline && (
          <div className="flex flex-col gap-1">
            <PhotoCapture
              label={selfieRequired ? t('pos.voidSelfieRequired') : t('pos.voidSelfie')}
              value={selfie?.preview ?? null}
              onCapture={(file) => setSelfie({ file, preview: URL.createObjectURL(file) })}
              onRemove={() => setSelfie(null)}
            />
            {/*
              Stated BEFORE the attempt, not after it fails. The amount is what
              makes the photo mandatory, so the message says so — a requirement
              whose trigger is invisible reads as arbitrary.
            */}
            {selfieMissing && (
              <p className="text-sm text-danger-600">
                {t('pos.voidSelfieRequiredHint', {
                  amount: selectedApprover?.selfieRequiredAboveIdr ?? '0',
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
