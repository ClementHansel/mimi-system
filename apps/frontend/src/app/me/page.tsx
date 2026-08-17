'use client';

import { QrCode, FileText, CalendarPlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { AbsenPanel } from '@/components/me/AbsenPanel';
import { SlipGajiPanel } from '@/components/me/SlipGajiPanel';
import { CutiPanel } from '@/components/me/CutiPanel';

/**
 * F11 `me` — every employee's own view (BUILD-PLAN W4-10). MOBILE-FIRST: a
 * phone screen used one-handed in a car park at 6am (NFR-04) — large touch
 * targets (`touch-lg` buttons throughout the panels), no dense tables, no
 * hover-only affordances. Strict self-scoping: every fetch here goes through
 * `.me`/`self`-suffixed endpoints (CONTRACTS §4.14/§4.15) — the backend
 * enforces it, but this surface never even offers a widget that could ask
 * for someone else's record.
 */
export default function MePage() {
  const { t } = useI18n();

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-3">
      {/* AppShell (components/layout/AppShell.tsx) already renders OfflineBanner once, above every
          non-chromeless route's <main> — this page is not chromeless, so it does not render its own
          copy (previously did, producing a stacked duplicate). */}
      <h1 className="font-display text-xl font-semibold text-text-primary">{t('nav.me')}</h1>

      <Tabs defaultValue="absen">
        <TabsList className="grid grid-cols-3">
          <TabsTrigger value="absen">
            <span className="inline-flex items-center gap-1.5"><QrCode className="size-4" aria-hidden />{t('me.tabs.absen')}</span>
          </TabsTrigger>
          <TabsTrigger value="slip">
            <span className="inline-flex items-center gap-1.5"><FileText className="size-4" aria-hidden />{t('me.tabs.slip')}</span>
          </TabsTrigger>
          <TabsTrigger value="cuti">
            <span className="inline-flex items-center gap-1.5"><CalendarPlus className="size-4" aria-hidden />{t('me.tabs.cuti')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="absen">
          <AbsenPanel />
        </TabsContent>
        <TabsContent value="slip">
          <SlipGajiPanel />
        </TabsContent>
        <TabsContent value="cuti">
          <CutiPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
