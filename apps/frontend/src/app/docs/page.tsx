'use client';

import { BookOpen } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { EmptyState } from '@/components/ui/EmptyState';
import { DocCard } from '@/components/docs/DocCard';
import { MANUALS } from '@/content/docs';

/**
 * F-DOCS index — "Dokumentasi" workspace (BUILD-PLAN W7-03). Lists every
 * manual the signed-in role is allowed to open, grouped by the manual's own
 * `audience` label, filtered through the exact same `usePermissions().can()`
 * check `Sidebar`/`PermissionGate` use elsewhere — a manual never appears for
 * a role that couldn't reach the surface it documents (a kasir is never
 * handed the payroll manual). Real enforcement is still server-side; this is
 * visibility only, same caveat as every other permission gate in the app.
 *
 * No search box here on purpose — see the reader page's header comment for
 * why full-text search was skipped rather than shipped half-working.
 */
export default function DocsIndexPage() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const visible = MANUALS.filter((m) => can(m.permission));
  const groups = Array.from(new Set(visible.map((m) => m.audience))).map((audience) => ({
    audience,
    manuals: visible.filter((m) => m.audience === audience),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-brand-600">{t('docs.kicker')}</p>
        <h1 className="font-display text-2xl font-semibold text-text-primary sm:text-3xl">
          {t('docs.title')}
        </h1>
        <p className="max-w-2xl text-sm text-text-secondary">{t('docs.subtitle')}</p>
      </div>

      {groups.length === 0 && (
        <EmptyState
          icon={BookOpen}
          title={t('docs.emptyTitle')}
          description={t('docs.emptyDescription')}
          size="lg"
        />
      )}

      {groups.map((group) => (
        <div key={group.audience} className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {group.audience}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.manuals.map((manual) => (
              <DocCard key={manual.slug} manual={manual} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
