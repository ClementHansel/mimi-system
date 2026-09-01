'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useSessionStore } from '@/stores/session-store';
import { resolveAttachmentUrl } from '@/lib/attachment-url';
import {
  DEFAULT_BRAND_IDENTITY,
  DEFAULT_BRAND_PALETTE,
  type BrandIdentity,
  type BrandPalette,
} from '@/lib/shared-types';
import { brandCssVariables, documentPalette } from './palette';
import { hasPermission } from '@/lib/permissions';
import { getBranding, getCompanyProfile, type CompanyProfile } from './brand-api';

/**
 * Applies the owner's brand to the RUNNING APP: the `--color-brand-*` ramp on
 * `:root`, and the favicon in the browser tab.
 *
 * ── WHY A CLIENT PROVIDER AND NOT THE SERVER ─────────────────────────────────
 * `app/layout.tsx` is a server component, and the obvious implementation —
 * read the setting during SSR and emit a `<style>` in `<head>` — cannot work
 * here. This is a PWA whose session lives in `localStorage` (see `AppShell`'s
 * note on why route protection is client-side): the server rendering the
 * layout has no token, so it cannot read a permission-checked settings key,
 * and there is no per-request tenant to key a cache on. So the brand is
 * applied on the client, once, as soon as there IS a session.
 *
 * The visible consequence is a first paint in the SHIPPED terracotta before
 * the owner's colour lands. That is deliberate and it is the better failure:
 * `globals.css` already contains a complete, designed palette, so the flash is
 * from one valid theme to another rather than from unstyled to styled. The
 * alternative — blocking render until the setting arrives — would put a
 * network round trip in front of the login screen on a tablet on mobile data.
 *
 * ── WHY IT WAITS FOR AUTH ────────────────────────────────────────────────────
 * `apiFetch` treats a 401 as a dead session: it clears the store and sends the
 * browser to `/login`. A provider that fetched on mount would therefore fire
 * that path on the login screen itself, on every load, for every visitor. So
 * the fetch is gated on a hydrated, authenticated session — which is also the
 * only moment the value is knowable.
 *
 * ── WHY EVERY FAILURE IS SILENT ──────────────────────────────────────────────
 * The identity is cosmetic. If the settings read 403s (a role without
 * `settings.read`) or the network is down, the app keeps the shipped palette
 * and the shipped icons and says nothing — a toast about a favicon on a
 * cashier's till would be noise about something they cannot act on. See the
 * note on `settings.read` in `refresh()` for the one real gap this leaves.
 */

export interface BrandContextValue {
  identity: BrandIdentity;
  /** The four colours `resolveDocColor` resolves a template's `brand.*` tokens against. */
  palette: BrandPalette;
  /** `company.profile` verbatim — the Brand panel merges into it rather than replacing it. */
  companyProfile: CompanyProfile;
  /** Presigned URL for `company.profile.logoAttachmentId`, or null. */
  logoUrl: string | null;
  /** False until the first fetch settles (either way). */
  loaded: boolean;
  /** Re-read both settings keys. The Brand panel calls this after saving. */
  refresh: () => Promise<void>;
}

const FALLBACK: BrandContextValue = {
  identity: DEFAULT_BRAND_IDENTITY,
  palette: DEFAULT_BRAND_PALETTE,
  companyProfile: {},
  logoUrl: null,
  loaded: false,
  refresh: async () => {},
};

const BrandContext = createContext<BrandContextValue>(FALLBACK);

/**
 * Swap the browser tab icon to the uploaded favicon, keeping the shipped
 * `/icons/*` as the fallback.
 *
 * BOTH MECHANISMS EXIST ON PURPOSE, and they cover different moments:
 *
 *  - `app/layout.tsx`'s static `metadata.icons` is emitted server-side into
 *    the HTML `<head>`. It is what the browser sees on FIRST paint, what a
 *    bookmark and the iOS home screen capture, and what a visitor who never
 *    signs in gets. It cannot be dynamic — see this file's header.
 *  - this function runs after the identity loads and REPLACES the href. It is
 *    what an owner sees change in their tab after uploading an icon.
 *
 * Removing either one breaks something real: without the static tag there is
 * no icon at all before login and none on the install prompt; without this
 * one, uploading a favicon does nothing visible until a rebuild.
 *
 * The `<link>` is REUSED rather than appended, and tagged `data-brand-favicon`
 * so a later call replaces its own tag instead of stacking a new one on every
 * refresh (browsers honour the LAST matching `rel="icon"`, so stacking would
 * work by accident and leak a node per save).
 */
function applyFavicon(url: string | null): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector<HTMLLinkElement>('link[data-brand-favicon]');
  if (!url) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement('link');
  link.rel = 'icon';
  link.setAttribute('data-brand-favicon', '');
  link.href = url;
  if (!existing) document.head.appendChild(link);
}

/**
 * Write the ramp onto `document.documentElement`'s inline style.
 *
 * Inline rather than a generated `<style>` block because `globals.css`'s
 * `@theme` puts the same custom properties on `:root`, and an inline style on
 * the same element beats any stylesheet rule without needing `!important` or a
 * specificity fight. Tailwind v4 utilities compile to `var(--color-brand-600)`,
 * so redefining the variable re-tints every existing class with no rebuild.
 */
function applyCssVariables(variables: Record<string, string>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const isHydrated = useSessionStore((s) => s.isHydrated);
  const accessToken = useSessionStore((s) => s.accessToken);
  const user = useSessionStore((s) => s.user);
  const authenticated = !!accessToken && !!user;

  const [identity, setIdentity] = useState<BrandIdentity>(DEFAULT_BRAND_IDENTITY);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>({});
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const permissions = user?.permissions ?? [];

  const refresh = useCallback(async () => {
    // The two keys are read INDEPENDENTLY, not with `Promise.all`, because
    // they fail independently and for different reasons: `brand.identity` is
    // new and may not exist yet on an un-migrated environment, while
    // `company.profile` has been there since migration 007. One missing key
    // must not cost the app the other one's value — an install with a logo but
    // no palette should still print its logo.
    //
    // THE KNOWN GAP THAT USED TO BE HERE IS CLOSED. This read was two
    // `GET /settings/:key` calls behind `settings.read`, which kasir, driver,
    // koki and supervisor do not hold — so every front-of-house screen kept the
    // SHIPPED palette, logo and favicon however the owner branded the system,
    // and fired two 403s per page load doing it. The comment here said the fix
    // had to be server-side and that this client could not make it; the server
    // side now exists as `GET /settings/branding`, authenticated but
    // unpermissioned, returning only what a screen needs to paint itself.
    const branding = await getBranding().catch(() => null);
    if (branding) setIdentity(branding.identity);

    // The FULL `company.profile` is a separate, still-permissioned read: it
    // carries address/city and whatever future keys are added, and only the
    // Brand panel needs it (it merges into the whole object on save — see
    // `putCompanyLogo`). ASKED FOR ONLY BY ROLES THAT MAY HAVE IT: firing it
    // for a cashier and swallowing the 403 would leave exactly the per-page
    // forbidden request this change set out to remove. A role without
    // `settings.read` keeps `companyProfile` empty, which is what it has always
    // effectively been for them.
    const nextProfile = hasPermission(permissions, 'settings.read')
      ? await getCompanyProfile().catch(() => null)
      : null;
    if (nextProfile) setCompanyProfile(nextProfile);

    // Logo id comes from the branding bundle, not the profile, so it resolves
    // for the roles that cannot read the profile at all — which is the whole
    // point of the change above.
    setLogoUrl(await resolveAttachmentUrl(branding?.logoAttachmentId ?? null));
    setLoaded(true);
    // `permissions` is read above, so it belongs in the dependency list — a
    // stale closure here would decide the profile read from the PREVIOUS user
    // after a re-login.
  }, [permissions]);

  useEffect(() => {
    if (!isHydrated || !authenticated) return;
    void refresh();
  }, [isHydrated, authenticated, refresh]);

  // Re-applied whenever the identity changes — which is on load and after the
  // Brand panel saves, so an owner sees the new colour without a reload.
  useEffect(() => {
    applyCssVariables(brandCssVariables(identity));
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    void resolveAttachmentUrl(identity.faviconAttachmentId).then((url) => {
      if (!cancelled) applyFavicon(url);
    });
    return () => {
      cancelled = true;
    };
  }, [identity.faviconAttachmentId]);

  const value = useMemo<BrandContextValue>(
    () => ({
      identity,
      palette: documentPalette(identity, DEFAULT_BRAND_PALETTE),
      companyProfile,
      logoUrl,
      loaded,
      refresh,
    }),
    [identity, companyProfile, logoUrl, loaded, refresh],
  );

  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/**
 * The brand, for anything that needs to draw with it.
 *
 * Outside a provider this returns the shipped default rather than throwing —
 * the print routes and the designer both render in trees a test may mount
 * bare, and a document that prints in the default terracotta is a far better
 * outcome than one that throws on a missing context.
 */
export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
