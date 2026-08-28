'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/**
 * Shared chrome for the `employee` interface's own-data pages.
 *
 * Absen, Slip Gaji, Cuti, Data Pribadi, Pinjaman and Kontrak used to be six
 * tabs on `/me`. The owner moved them into the sidebar/hamburger
 * (2026-08-27), so each is now its own route — which also means each one can
 * be linked to, bookmarked and opened straight from a notification, none of
 * which a tab could do. This component keeps the six looking like one
 * surface: the same narrow, one-handed column the tabs had (NFR-04), a title,
 * and a way back to the overview for a phone whose sidebar is behind a
 * hamburger.
 */
export function MeSurface({ titleKey, children }: { titleKey: string; children: ReactNode }) {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-3">
      {/* AppShell renders OfflineBanner once, above every non-chromeless
          route's <main> — no page-level copy here. */}
      <div className="flex flex-col gap-1">
        <Link
          href="/me"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('nav.me')}
        </Link>
        <h1 className="font-display text-xl font-semibold text-text-primary">{t(titleKey)}</h1>
      </div>
      {children}
    </div>
  );
}
