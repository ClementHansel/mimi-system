'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { LogIn } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { login, isInvalidCredentials } from '@/lib/auth';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { getLandingRoute } from '../landing';

/**
 * F01 `(auth)` — built on top of the Wave-1 functional baseline (gate G1's
 * "login works" criterion). W4-05 additions: (1) role-appropriate landing
 * page instead of a hardcoded `/dashboard` for every role, (2) routes through
 * `/set-pin` first when `Me.mustSetPin` is true (D-17 — a PIN is required for
 * POS/approval offline authorization and is not set at seed time for every
 * role).
 */
export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const tier = useConnectivityStore((s) => s.tier);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(username, password);
      const landing = getLandingRoute(user);
      router.push(user.mustSetPin ? `/set-pin?next=${encodeURIComponent(landing)}` : landing);
    } catch (err) {
      setError(isInvalidCredentials(err) ? t('auth.invalidCredentials') : t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t('auth.loginTitle')}</CardTitle>
        <CardDescription>{t('auth.loginSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Input
            label={t('auth.username')}
            placeholder={t('auth.usernamePlaceholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <Input
            label={t('auth.password')}
            type="password"
            placeholder={t('auth.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <p className="text-sm text-danger-600">{error}</p>}
          {tier === 'isolated' && <p className="text-sm text-warning-600">{t('auth.offlineNotice')}</p>}
          <Button type="submit" size="lg" fullWidth loading={submitting} leftIcon={<LogIn className="size-4" />}>
            {submitting ? t('auth.submitting') : t('auth.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
