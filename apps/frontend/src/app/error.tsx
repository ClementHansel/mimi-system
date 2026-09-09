'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw, LogOut } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { logout } from '@/lib/auth';

/**
 * THE SCREEN THE CLIENT ACTUALLY SAW — replaced with one that says something
 * and offers a way out.
 *
 * MA-190: a newly added employee logged in, set their PIN, and landed on
 *
 *   "Application error: a client-side exception has occurred while loading
 *    mimichicken.my.id (see the browser console for more information)."
 *
 * That string is Next's LAST-RESORT fallback, shown when a client render
 * throws and there is no `error.tsx` to catch it. There was none anywhere in
 * this app — no `error.tsx`, no `global-error.tsx`, no `not-found.tsx` — so
 * every client-side exception in every interface produced exactly that: an
 * English developer sentence on a white page, with no retry, no sign-out, and
 * nothing to report but a screenshot. For outlet crew mid-shift that is not a
 * bug report, it is the end of the shift.
 *
 * This boundary is the fix that is available without knowing which line threw
 * (the console the message points at is the client's, not mine, and the flow
 * does not reproduce on the current build). What it changes:
 *
 *  - Indonesian copy that says what happened and that the data is safe.
 *  - "Coba Lagi" — `reset()`, which re-renders the segment. A transient
 *    failure ends here.
 *  - "Keluar" — sign out, which clears the session. That is the actual
 *    recovery when the crash comes from a bad stored session, which is the
 *    documented way this screen gets produced: `session-store.ts` notes that a
 *    `Me` missing `permissions` or `locations` "throws during render and Next
 *    replaces the page with its client-side-exception screen". Before this,
 *    the only escape from that state was knowing to clear browser storage by
 *    hand.
 *  - The `digest` — Next's stable hash of the real error. It is the one thing
 *    that makes the NEXT report diagnosable instead of another screenshot of
 *    a white page.
 *
 * `console.error` on mount so the digest and the error are in the client's own
 * console together, which is where the message told them to look.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    console.error('[mimi] unhandled client error', { digest: error.digest, error });
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-50">
        <AlertTriangle className="size-6 text-danger-600" aria-hidden />
      </span>

      <div className="flex max-w-md flex-col gap-2">
        <h1 className="font-display text-xl font-bold text-text-primary">
          {t('errors.boundary.title')}
        </h1>
        <p className="text-sm text-text-secondary">{t('errors.boundary.description')}</p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button leftIcon={<RotateCcw className="size-4" />} onClick={reset}>
          {t('errors.boundary.retry')}
        </Button>
        {/* Not decoration: a crash caused by a bad stored session cannot be
            retried out of, and signing out is what clears it. */}
        <Button variant="outline" leftIcon={<LogOut className="size-4" />} onClick={() => logout()}>
          {t('errors.boundary.signOut')}
        </Button>
      </div>

      {error.digest && (
        <p className="text-xs text-text-muted">
          {t('errors.boundary.reference', { digest: error.digest })}
        </p>
      )}
    </div>
  );
}
