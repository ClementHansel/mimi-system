'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { useNavStore } from '@/stores/nav-store';
import { getBrowserLocalRuntime } from '@/lib/local/browser';
import { registerServiceWorker, type LocalRuntime } from '@/lib/local';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ToastViewport } from '@/components/ui/Toast';
import { OfflineBanner } from '@/components/ui/OfflineBanner';
import { Drawer } from '@/components/ui/Drawer';

/** Routes rendered WITHOUT the app shell (no sidebar/header) — pre-login only. */
const PUBLIC_ROUTES = ['/login'];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Routes that render full-bleed with NO Sidebar/Header even though the
 * visitor IS authenticated (unlike `PUBLIC_ROUTES` above, the auth-redirect
 * effect below still applies here — an unauthenticated visitor still bounces
 * to `/login`).
 *
 * - `/` exactly (F-HUB-2): the home hub is a standalone, centred workspace
 *   chooser with its own slim top bar, not a page rendered inside the app
 *   shell's chrome.
 * - `/pos` and everything under it (F-POS-2): the owner reviewed POS against
 *   AIRE's live till and wants it to read as a standalone cashier app, not a
 *   page inside the admin shell — a tablet used one-handed during a rush has
 *   no room for a collapsible sidebar it will never touch. `app/pos/layout.tsx`
 *   supplies POS's own top bar/tabs/session controls AND its own
 *   `OfflineBanner` (offline-legibility is non-negotiable everywhere, POS
 *   most of all) — `AppShell` only keeps `ToastViewport` common to both.
 *
 * `/` needs an EXACT match (every path "starts with" `/`); `/pos` needs a
 * prefix match (its sub-routes must inherit the same treatment) — hence two
 * lists rather than one, both checked by `isChromelessRoute`.
 */
const CHROMELESS_EXACT_ROUTES = ['/'];
const CHROMELESS_PREFIX_ROUTES = ['/pos'];

function isChromelessRoute(pathname: string): boolean {
  if (CHROMELESS_EXACT_ROUTES.includes(pathname)) return true;
  return CHROMELESS_PREFIX_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Resolves W2-E's `LocalRuntime` (real `idb` store + HTTP transport + our
 * `connectivity-store`, per `src/lib/local/browser.ts`) and registers
 * `public/sw.js` exactly once per page session — module-scoped so React
 * Strict Mode's dev-only double-invocation of the mount effect below can't
 * double-register the service worker's message listener. `start()`/`stop()`
 * deliberately stay OUT of this cache: those toggle the engine's live probe
 * and heartbeat timers, and are paired with the effect's own mount/cleanup
 * instead, so they behave correctly under Strict Mode's mount→cleanup→mount.
 */
let runtimeBootstrap: Promise<LocalRuntime> | null = null;
function bootstrapLocalRuntime(): Promise<LocalRuntime> {
  if (!runtimeBootstrap) {
    runtimeBootstrap = getBrowserLocalRuntime().then(async (runtime) => {
      await registerServiceWorker(runtime);
      return runtime;
    });
  }
  return runtimeBootstrap;
}

/**
 * The app shell (BUILD-PLAN W1-E: "layout.tsx — app shell, role-aware
 * sidebar, header with connectivity and sync status, toast host"). Mounted
 * once by the root layout and wraps every route; it decides — by pathname,
 * not by a route-group boundary — whether to show chrome, so F01's `(auth)`
 * pages and the 12 protected surfaces can all stay flat under `app/<route>/`
 * per BUILD-PLAN §4.3 without a wrapping route group.
 *
 * Route protection here is intentionally client-side: this is a PWA whose
 * session lives in localStorage (via the persisted session store), which
 * Next middleware cannot read. It redirects unauthenticated visitors to
 * `/login` and authenticated visitors away from it — the real authorization
 * boundary is always the backend's `PermissionsGuard` + RLS.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const isHydrated = useSessionStore((s) => s.isHydrated);
  const accessToken = useSessionStore((s) => s.accessToken);
  const user = useSessionStore((s) => s.user);
  const mobileMenuOpen = useNavStore((s) => s.mobileMenuOpen);

  // Authentication means a token AND the user it belongs to — never the token
  // alone. Gating on `accessToken` by itself let a half-valid session through
  // here while `app/page.tsx` (which gates on `user`) returned null, so the
  // app rendered nothing, logged nothing, and never redirected: a permanent
  // blank white page. The two gates now agree, and any session that fails
  // this check is treated as signed out and bounced to /login.
  const isAuthenticated = !!accessToken && !!user;
  const setMobileMenuOpen = useNavStore((s) => s.setMobileMenuOpen);

  // Device-local offline runtime (D-12/SYNC-PROTOCOL): starts the sync
  // engine's upstream prober + heartbeat, which is what actually drives
  // `connectivity-store` (tier/queueDepth/lastSyncAt) — OfflineBanner and
  // SyncStatusPill read live state from here, not a guess. Runs regardless
  // of auth state (a device can be offline-capable before anyone logs in).
  useEffect(() => {
    let cancelled = false;
    let runtime: LocalRuntime | null = null;
    bootstrapLocalRuntime()
      .then((r) => {
        if (cancelled) return;
        runtime = r;
        void r.start();
      })
      .catch((err: unknown) => {
        // Progressive enhancement: a device without IndexedDB/service-worker
        // support (or a locked-down browser) still gets the online-only app.
        console.error('[local-runtime] failed to start', err);
      });
    return () => {
      cancelled = true;
      runtime?.stop();
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    const publicRoute = isPublicRoute(pathname);
    if (!isAuthenticated && !publicRoute) router.replace('/login');
    // F-BRAND: an already-authenticated visitor who lands on /login (e.g. a
    // stale tab, a bookmarked link) bounces to the home hub, not /dashboard —
    // the hub is the one role-agnostic "already signed in" destination.
    if (isAuthenticated && publicRoute) router.replace('/');
  }, [isHydrated, isAuthenticated, pathname, router]);

  if (isPublicRoute(pathname)) {
    return (
      <>
        <main className="flex min-h-dvh items-center justify-center bg-surface p-4">{children}</main>
        <ToastViewport />
      </>
    );
  }

  // Not yet hydrated, or hydrated-but-unauthenticated (redirect effect above
  // is about to fire) — render nothing rather than flashing the shell.
  if (!isHydrated || !isAuthenticated) return null;

  if (isChromelessRoute(pathname)) {
    return (
      <>
        {children}
        <ToastViewport />
      </>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-white"
      >
        {t('shell.skipToContent')}
      </a>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden lg:block">
          <Sidebar variant="desktop" />
        </div>
        <Drawer open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} title="Menu" side="left">
          <Sidebar variant="mobile" />
        </Drawer>
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header />
          <OfflineBanner />
          <main id="main-content" className="flex-1 overflow-y-auto bg-surface p-4 sm:p-6">
            {children}
          </main>
        </div>
      </div>
      <ToastViewport />
    </div>
  );
}
