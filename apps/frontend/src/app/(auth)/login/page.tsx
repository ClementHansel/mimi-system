'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, LogIn, ShieldAlert, WifiOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { login, isInvalidCredentials } from '@/lib/auth';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

/**
 * F01 `(auth)` — built on top of the Wave-1 functional baseline (gate G1's
 * "login works" criterion). F-BRAND additions (this pass): a branded split
 * layout carrying real Mimi Chicken identity (see the `auth.brand*` i18n
 * keys — verified facts only, no fabricated logo/colours), a password
 * reveal toggle, and two defect fixes found in testing: the username field
 * was missing a `name` attribute (breaks password-manager save/autofill —
 * browsers key on `name`, not just `autoComplete`) and neither field had a
 * dedicated a11y label for the reveal toggle. Every field is `size="touch"`
 * (44px floor, NFR-04) — this runs on a cashier's tablet as much as a
 * back-office laptop.
 *
 * Landing changed from redirecting straight to a per-role route to always
 * redirecting to the home hub (`/`, F-BRAND) — the owner asked for an
 * AIRE-style "where do you want to work today" launchpad instead of
 * dropping straight into one module. `../landing`'s `getLandingRoute` (the
 * old per-role route map) isn't deleted: the hub reuses it to decide which
 * of a role's visible destinations is its "primary job" hero card.
 */
export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const tier = useConnectivityStore((s) => s.tier);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(username, password);
      router.push(user.mustSetPin ? `/set-pin?next=${encodeURIComponent('/')}` : '/');
    } catch (err) {
      setError(isInvalidCredentials(err) ? t('auth.invalidCredentials') : t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-surface lg:flex-row">
      {/* ── Brand panel — hidden below lg; mobile gets the compact chip below instead ── */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 px-12 py-10 text-white lg:flex lg:w-1/2 lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-brand-300/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-white/5 blur-3xl"
        />

        <div className="relative flex items-center gap-3">
          <span className="flex size-11 flex-none items-center justify-center rounded-xl bg-white/15 font-display text-lg font-bold">
            MC
          </span>
          <span className="font-display text-lg font-semibold">{t('shell.appName')}</span>
        </div>

        <div className="relative flex max-w-md flex-col gap-4">
          <h1 className="font-display text-3xl font-bold leading-tight xl:text-4xl">
            {t('auth.brandHeadline')}
          </h1>
          <p className="text-base text-white/85">{t('auth.brandTagline')}</p>
          <p className="text-sm text-white/70">{t('auth.brandOutlets')}</p>
          <p className="text-sm text-white/70">{t('auth.brandHours')}</p>
        </div>

        <p className="relative text-xs text-white/60">
          {t('auth.brandFooter', { year: new Date().getFullYear() })}
        </p>
      </div>

      {/* ── Form panel ── */}
      <div className="relative flex flex-1 flex-col justify-center px-6 py-12 sm:px-12 lg:px-16 xl:px-24">
        {/* Compact brand chip — shown only when the brand panel is hidden (mobile/tablet) */}
        <div className="mb-8 flex items-center gap-2 lg:hidden">
          <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-brand-500 font-display text-base font-bold text-white">
            MC
          </span>
          <span className="font-display text-base font-semibold text-text-primary">
            {t('shell.appName')}
          </span>
        </div>

        <div className="mx-auto w-full max-w-sm">
          <h2 className="font-display text-2xl font-semibold text-text-primary">
            {t('auth.loginTitle')}
          </h2>
          <p className="mt-2 text-sm text-text-secondary">{t('auth.loginSubtitle')}</p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4" noValidate>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-danger-600/20 bg-danger-50 p-3 text-sm text-danger-700"
              >
                <ShieldAlert className="mt-0.5 size-4 flex-none" aria-hidden />
                <span>{error}</span>
              </div>
            )}
            {tier === 'isolated' && (
              <div className="flex items-start gap-2 rounded-lg border border-warning-600/20 bg-warning-50 p-3 text-sm text-warning-700">
                <WifiOff className="mt-0.5 size-4 flex-none" aria-hidden />
                <span>{t('auth.offlineNotice')}</span>
              </div>
            )}

            <Input
              label={t('auth.username')}
              placeholder={t('auth.usernamePlaceholder')}
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              size="touch"
              required
            />

            <div className="relative">
              <Input
                label={t('auth.password')}
                type={showPassword ? 'text' : 'password'}
                placeholder={t('auth.passwordPlaceholder')}
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                size="touch"
                rightIcon={
                  showPassword ? (
                    <EyeOff className="size-4" aria-hidden />
                  ) : (
                    <Eye className="size-4" aria-hidden />
                  )
                }
                required
              />
              {/* Input's rightIcon is decorative (pointer-events-none) — this
                  real button sits on top of it, aligned to the input's own
                  box (this wrapper has no hint/error text, so its bottom
                  edge is the input's bottom edge). */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                aria-pressed={showPassword}
                className="absolute bottom-0 right-0 flex h-touch w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:text-text-primary focus-visible:text-text-primary"
              >
                <span className="sr-only">
                  {showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                </span>
              </button>
            </div>

            <Button
              type="submit"
              size="touch-lg"
              fullWidth
              loading={submitting}
              leftIcon={<LogIn className="size-4" />}
            >
              {submitting ? t('auth.submitting') : t('auth.submit')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
