'use client';

import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { errMsg } from '@/lib/api-error';
import { Button, Card, CardContent, Input, toast } from '@/components/ui';
import { useSessionStore } from '@/stores/session-store';

/** Matches `ChangePasswordDto`'s `@MinLength(8)`. Checked here only to say so before the round trip — the server is the authority. */
const MIN_LENGTH = 8;

/**
 * "Ubah Kata Sandi" — a person changing their own password.
 *
 * Until this existed there was NO way to. `POST /users/:id/reset-password` is an
 * admin acting on someone else, gated on `user.password.reset`, which only
 * owner, manager and superadmin hold. Everyone else was issued a password by
 * whoever created their account and kept it for the life of the account, with
 * that person still knowing it.
 *
 * Rendered on every branch of `ProfilePanel`, including the one for a login with
 * no `employees` row — a shared till account or a service user has no personal
 * data to show and still needs to be able to rotate its password.
 *
 * Changing the password revokes every session server-side, so the correct end
 * to this flow is a trip back to `/login`; the alternative is an app holding a
 * dead token and failing confusingly on the next request.
 */
export function ChangePasswordCard() {
  const { t } = useI18n();
  const clearSession = useSessionStore((s) => s.clearSession);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_LENGTH &&
    newPassword === confirmPassword &&
    !submitting;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      await api.post('/auth/password', { currentPassword, newPassword });
      toast({ title: t('me.password.success'), variant: 'success' });
      // Every session was just revoked, this one included. Clearing locally and
      // sending them to /login is the honest consequence, not a punishment.
      clearSession();
      window.location.assign('/login');
    } catch (err) {
      // A wrong current password is the one failure worth naming precisely —
      // everything else goes through the shared code-to-sentence mapping.
      if (err instanceof ApiError && err.code === 'ERR_AUTH_INVALID_CREDENTIALS') {
        setError(t('me.password.wrongCurrent'));
      } else {
        setError(errMsg(err, t('table.error')));
      }
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-text-muted" aria-hidden />
          <p className="text-sm font-semibold text-text-primary">{t('me.password.title')}</p>
        </div>
        <p className="text-xs text-text-muted">{t('me.password.subtitle')}</p>

        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <Input
            label={t('me.password.current')}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={submitting}
          />
          <Input
            label={t('me.password.new')}
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={tooShort ? t('me.password.tooShort', { min: MIN_LENGTH }) : undefined}
            disabled={submitting}
          />
          <Input
            label={t('me.password.confirm')}
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={mismatch ? t('me.password.mismatch') : undefined}
            disabled={submitting}
          />

          {error && <p className="text-sm text-danger-600">{error}</p>}

          <Button type="submit" disabled={!canSubmit} loading={submitting} className="self-start">
            {t('me.password.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
