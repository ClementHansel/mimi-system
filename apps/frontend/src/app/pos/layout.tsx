'use client';

import { Tabs } from '@/components/ui';
import { OfflineBanner } from '@/components/ui/OfflineBanner';
import { PosShellProvider, usePosShell } from '@/components/pos/PosShellContext';
import { PosTopBar } from '@/components/pos/PosTopBar';
import { PosStatusBar } from '@/components/pos/PosStatusBar';

/**
 * F-POS-2 — POS is its own application, not a page inside the admin shell.
 * `AppShell` (`components/layout/AppShell.tsx`) special-cases this route to
 * render neither the sidebar nor its `Header` — this layout supplies POS's
 * own chrome instead: `PosTopBar` (brand mark, branch, tab nav, session
 * controls) plus `PosStatusBar` as the secondary "operating branch and why"
 * line the owner asked for (mirrors AIRE's "Operating branch: X — from your
 * open shift", built from the same assigned-vs-chosen fact `PosStatusBar`
 * already tracked via `onChangeLocation`).
 *
 * `<Tabs>` is opened HERE, wrapping both `PosTopBar` (which renders
 * `<TabsList>`) and `{children}` (`app/pos/page.tsx`, which renders the
 * matching `<TabsContent>` panels) — one shared tab context so the header's
 * tab row and the page's content panels can never fall out of sync, without
 * a second store. See `Tabs` in `components/ui/Tabs.tsx`.
 */
function PosChrome({ children }: { children: React.ReactNode }) {
  const { posLocation } = usePosShell();
  const locationName = posLocation.status === 'ready' ? posLocation.location.name : null;
  const onChangeLocation =
    posLocation.status === 'ready' && posLocation.canChange ? posLocation.change : undefined;

  return (
    <Tabs defaultValue="kasir">
      <div className="flex h-dvh flex-col">
        <PosTopBar />
        <OfflineBanner />
        {locationName && (
          <div className="px-4 pt-3">
            <PosStatusBar locationName={locationName} onChangeLocation={onChangeLocation} />
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </Tabs>
  );
}

export default function PosLayout({ children }: { children: React.ReactNode }) {
  return (
    <PosShellProvider>
      <PosChrome>{children}</PosChrome>
    </PosShellProvider>
  );
}
