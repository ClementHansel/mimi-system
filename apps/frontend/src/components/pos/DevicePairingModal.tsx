'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Modal, Button, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { errMsg } from '@/lib/api-error';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** Strip separators and non-alphanumeric characters, uppercase. */
function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface DevicePairingModalProps {
  runtime: LocalRuntime;
  open: boolean;
  onClose: () => void;
}

/**
 * POS-only pairing screen (CONTRACTS §4.21). The tablet opens this when it has
 * no cloud credential, the operator types the 12-char code shown in the admin
 * `AddDevicePairingModal`, and the backend's `PairingTokensService` redeems it
 * atomically. The returned credential is persisted through the existing local
 * runtime path and the page reloads so the sync engine's `hasDeviceCredential`
 * gate picks it up (the device-token closure in `browser.ts` is built over the
 * pre-registration identity snapshot, so `stop()/start()` would not refresh it).
 */
export function DevicePairingModal({ runtime, open, onClose }: DevicePairingModalProps) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const normalized = normalizeCode(code);
    if (normalized.length !== 12) {
      setError(t('pos.pairing.lengthHint'));
      setSubmitting(false);
      return;
    }

    const id = await runtime.getIdentity();
    if (!id?.fingerprint) {
      setError(t('pos.pairing.runtimeError'));
      setSubmitting(false);
      return;
    }

    try {
      const response = await api.post<{
        deviceId: string;
        deviceToken: string;
        location: { id: string; code: string; name: string };
        nodeLanUrl: string | null;
        syncConfig: { cloudUrl: string; protocolV: number };
      }>('/devices/register', {
        displayCode: normalized,
        fingerprint: id.fingerprint,
        category: 'tablet',
        appVersion: APP_VERSION,
      });
      await runtime.completeRegistration(response);
      window.location.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ERR_AUTH_TOKEN_INVALID') {
        const sessionIssue = /access token|sesi/i.test(err.message);
        setError(t(sessionIssue ? 'pos.pairing.sessionExpired' : 'pos.pairing.invalid'));
      } else {
        setError(errMsg(err, t('pos.pairing.invalid')));
      }
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pos.pairing.title')}
      description={t('pos.pairing.description')}
      footer={
        <Button
          onClick={submit}
          loading={submitting}
          disabled={normalizeCode(code).length === 0}
          fullWidth
        >
          {t('pos.pairing.submit')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('pos.pairing.hint')}
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !submitting) void submit();
          }}
          placeholder={t('pos.pairing.hint')}
          size="lg"
          className="font-mono tracking-widest"
          maxLength={24}
          autoFocus
        />
        {error && <p className="text-sm text-danger-600">{error}</p>}
      </div>
    </Modal>
  );
}
