'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Modal,
  Button,
  Input,
  MoneyInput,
  Select,
  Textarea,
  PhotoCapture,
  Badge,
} from '@/components/ui';
import { toast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import { useConnectivityStore } from '@/stores/connectivity-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { Money, UUID } from '@/lib/shared-types';
import {
  mintClientId,
  listCachedApproverCredentials,
  type CachedApproverOption,
} from './pos-runtime';
import { usePosShiftStore } from './shift-store';

/**
 * Void/refund (FR-POS-03) — ALWAYS requires supervisor authorization, never
 * kasir-only (SYNC-PROTOCOL §8 row 3). Online routes through the real
 * approval chain (a supervisor's PIN against the server); offline/LAN uses a
 * cached credential + PIN and is explicitly provisional — labeled "awaiting
 * verification", never shown as a done deal, per this surface's brief.
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
  const [selfie, setSelfie] = useState<{ file: File; preview: string } | null>(null);
  const [approvers, setApprovers] = useState<CachedApproverOption[]>([]);
  const [credentialId, setCredentialId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || isOnline) return;
    listCachedApproverCredentials(runtime)
      .then(setApprovers)
      .catch(() => setApprovers([]));
  }, [open, isOnline, runtime]);

  async function handleSubmit() {
    if (!reason.trim()) {
      toast({ title: t('validation.reasonRequired'), variant: 'danger' });
      return;
    }
    setSubmitting(true);
    try {
      if (isOnline) {
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
        if (pin) {
          await api.post(`/api/pos/void-refunds/${req.voidRefundId}/approve`, { pin });
          toast({ title: t('pos.voidApprovedTitle'), variant: 'success' });
        } else {
          toast({
            title: t('pos.voidRequestedTitle'),
            description: t('pos.voidAwaitingApproval'),
            variant: 'info',
          });
        }
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
          toast({
            title: t('pos.voidAuthFailed'),
            description: t(`pos.voidAuthReason.${result.authorization.reason}`),
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
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : undefined;
      toast({ title: t('pos.voidFailed'), description: message, variant: 'danger' });
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
          <Button variant="danger" onClick={handleSubmit} loading={submitting}>
            {t('pos.voidSubmit')}
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
        <Select
          label={t('pos.voidType')}
          value={type}
          onValueChange={(v) => setType(v as 'void' | 'refund')}
          options={[
            { value: 'void', label: t('pos.voidTypeVoid') },
            { value: 'refund', label: t('pos.voidTypeRefund') },
          ]}
        />
        <Textarea
          label={t('common.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          rows={2}
        />
        <MoneyInput
          label={t('pos.voidAmount')}
          value={amount}
          onChange={setAmount}
          hint={t('common.optional')}
        />

        {!isOnline && (
          <Select
            label={t('pos.voidApprover')}
            value={credentialId}
            onValueChange={setCredentialId}
            placeholder={t('common.selectPlaceholder')}
            options={approvers.map((a) => ({ value: a.credentialId, label: t(`role.${a.role}`) }))}
          />
        )}
        <Input
          label={t('pos.supervisorPin')}
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          required
        />
        {!isOnline && (
          <PhotoCapture
            label={t('pos.voidSelfie')}
            value={selfie?.preview ?? null}
            onCapture={(file) => setSelfie({ file, preview: URL.createObjectURL(file) })}
            onRemove={() => setSelfie(null)}
          />
        )}
      </div>
    </Modal>
  );
}
