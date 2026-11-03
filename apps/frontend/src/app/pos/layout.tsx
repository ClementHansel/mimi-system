'use client';

import { useEffect, useState } from 'react';
import { Button, Tabs } from '@/components/ui';
import { OfflineBanner } from '@/components/ui/OfflineBanner';
import { useI18n } from '@/lib/i18n';
import { PosShellProvider, usePosShell } from '@/components/pos/PosShellContext';
import { PosTopBar } from '@/components/pos/PosTopBar';
import { PosStatusBar } from '@/components/pos/PosStatusBar';
import { ChannelBanner } from '@/components/pos/ChannelBanner';
import { DevicePairingModal } from '@/components/pos/DevicePairingModal';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';

/**
 * F-POS-2 — POS is its own application, not a page inside the admin shell.
 * `AppShell` (`components/layout/AppShell.tsx`) special-cases this route to
 * render neither the sidebar nor its `Header` — this layout supplies POS's
 * own chrome instead: `PosTopBar` (brand mark, branch, tab nav, session
 * controls, and — F-POS-3 — the walk-in/GoFood/ShopeeFood `ChannelToggle`)
 * plus `PosStatusBar` as the secondary "operating branch and why" line the
 * owner asked for (mirrors AIRE's "Operating branch: X — from your open
 * shift", built from the same assigned-vs-chosen fact `PosStatusBar` already
 * tracked via `onChangeLocation`). `ChannelBanner` sits right under the top
 * bar, above every tab: silent for walk-in, a loud coloured strip for
 * GoFood/ShopeeFood — a second, redundant cue on top of the toggle's own
 * colouring, because the entire point of this feature is that this is the
 * one state a cashier must never lose track of.
 *
 * `<Tabs>` is opened HERE, wrapping both `PosTopBar` (which renders
 * `<TabsList>`) and `{children}` (`app/pos/page.tsx`, which renders the
 * matching `<TabsContent>` panels) — one shared tab context so the header's
 * tab row and the page's content panels can never fall out of sync, without
 * a second store. See `Tabs` in `components/ui/Tabs.tsx`.
 */
function PosChrome({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { posLocation } = usePosShell();
  const locationName = posLocation.status === 'ready' ? posLocation.location.name : null;
  const onChangeLocation =
    posLocation.status === 'ready' && posLocation.canChange ? posLocation.change : undefined;

  const [runtime, setRuntime] = useState<LocalRuntime | null>(null);
  const [needsPairing, setNeedsPairing] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    getBrowserLocalRuntime()
      .then(async (rt) => {
        if (!mounted) return;
        setRuntime(rt);
        const identity = await rt.getIdentity();
        if (mounted) setNeedsPairing(!identity?.deviceToken);
      })
      .catch(() => {
        // If the runtime cannot bootstrap, the page already shows a fatal
        // offline message elsewhere; pairing is not the primary failure here.
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Tabs defaultValue="kasir">
      <div className="flex h-dvh flex-col">
        <PosTopBar />
        <ChannelBanner />
        <OfflineBanner />
        {locationName && (
          <div className="px-4 pt-3">
            <PosStatusBar
              locationName={locationName}
              onChangeLocation={onChangeLocation}
              onConnectDevice={needsPairing ? () => setPairingOpen(true) : undefined}
            />
          </div>
        )}
        {needsPairing && !locationName && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised px-4 py-2 text-sm text-text-primary">
            <span>{t('pos.pairing.unpairedBanner')}</span>
            <Button variant="outline" size="sm" onClick={() => setPairingOpen(true)}>
              {t('pos.pairing.button')}
            </Button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
      {runtime && needsPairing && (
        <DevicePairingModal
          open={pairingOpen}
          onClose={() => setPairingOpen(false)}
          runtime={runtime}
        />
      )}
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
