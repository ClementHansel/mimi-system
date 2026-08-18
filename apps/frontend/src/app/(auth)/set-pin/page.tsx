'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { isInvalidCredentials } from '@/lib/auth';
import { useSessionStore } from '@/stores/session-store';
import { toast } from '@/components/ui/Toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

/**
 * F01 — PIN setup (D-17, FR-POS-03). `Me.mustSetPin` (CONTRACTS §4.1) routes
 * a fresh/reset account here from `/login` before it reaches its landing
 * page. Re-asks the password because `POST /api/auth/pin` requires it
 * (§4.1 M01) — the access token alone isn't proof-of-password for minting a
 * credential that unlocks offline POS/approval actions.
 */
export default function SetPinPage() {
  return (
    <Suspense fallback={null}>
      <SetPinForm />
    </Suspense>
  );
}

function SetPinForm() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/me';
  const updateUser = useSessionStore((s) => s.updateUser);

  const [currentPassword, setCurrentPassword] = useState('');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pinFormatValid = /^\d{6}$/.test(pin);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!pinFormatValid) {
      setError(t('setPin.pinInvalid'));
      return;
    }
    if (pin !== confirmPin) {
      setError(t('setPin.pinMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/pin', { currentPassword, pin });
      updateUser({ mustSetPin: false });
      toast({ title: t('setPin.success'), variant: 'success' });
      router.push(next);
    } catch (err) {
      if (isInvalidCredentials(err)) {
        setError(t('auth.invalidCredentials'));
      } else if (err instanceof ApiError && err.code === 'ERR_AUTH_PIN_INVALID') {
        setError(t('setPin.pinInvalid'));
      } else {
        setError(t('auth.genericError'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t('setPin.title')}</CardTitle>
        <CardDescription>{t('setPin.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Input
            label={t('setPin.currentPassword')}
            type="password"
            placeholder={t('setPin.currentPasswordPlaceholder')}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <Input
            label={t('setPin.pin')}
            type="password"
            inputMode="numeric"
            maxLength={6}
            placeholder={t('setPin.pinPlaceholder')}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoComplete="off"
            required
          />
          <Input
            label={t('setPin.confirmPin')}
            type="password"
            inputMode="numeric"
            maxLength={6}
            placeholder={t('setPin.pinPlaceholder')}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoComplete="off"
            required
          />
          {error && <p className="text-sm text-danger-600">{error}</p>}
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={submitting}
            leftIcon={<KeyRound className="size-4" />}
          >
            {submitting ? t('setPin.submitting') : t('setPin.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
