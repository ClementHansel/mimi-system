'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import type { Dictionary } from '@/lib/i18n/id';

export type PlaceholderRouteKey = keyof Dictionary['placeholder'];

/**
 * The Wave-1 placeholder body for all 12 protected route surfaces
 * (BUILD-PLAN §4.3) — names the surface, its owning wave/agent, and its FR
 * coverage, so the nav is complete and routing works at Gate G1 while
 * Waves 4–5 build the real screens. A Wave 4/5 agent replaces `page.tsx`'s
 * contents entirely; this component (and the `placeholder.*` i18n keys it
 * reads) can then be deleted for that route.
 *
 * `icon` takes an already-rendered element (`<ShieldCheck />`), not a
 * component reference — each `page.tsx` is a Server Component, and a bare
 * component function isn't serializable across the server→client boundary
 * into this ('use client') component, whereas a rendered element is.
 */
export function RoutePlaceholder({ routeKey, icon }: { routeKey: PlaceholderRouteKey; icon: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-surface-sunken text-text-muted">
        {icon}
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t(`placeholder.${routeKey}.title`)}</h1>
        <p className="mx-auto max-w-md text-text-secondary">{t(`placeholder.${routeKey}.description`)}</p>
      </div>
      <div className="flex flex-col gap-1 text-sm text-text-muted">
        <span>{t(`placeholder.${routeKey}.owner`)}</span>
        <span>{t(`placeholder.${routeKey}.coverage`)}</span>
      </div>
    </div>
  );
}
