import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { BrandProvider } from '@/lib/brand';
import { AppShell } from '@/components/layout/AppShell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  weight: ['600', '700', '800'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Mimi Chicken OS',
  description:
    'Sistem operasional Mimi Chicken — POS, logistik, SDM, dan akuntansi untuk gudang pusat dan jaringan outlet.',
  // Renders <link rel="manifest" href="/manifest.json"> — Next's App Router
  // metadata API is how the root layout injects a <head> tag (there's no
  // JSX <head> element to hand-write one into). Required for installability
  // on the POS/outlet tablets (FR-POS-01, NFR-07); public/manifest.json and
  // the /icons/icon-*.png it references are W2-E's (SW/manifest) and this
  // agent's (icon assets) respectively.
  manifest: '/manifest.json',
  // F-DOC: these STATIC icons remain, and are not made redundant by the
  // owner-uploadable favicon (`brand.identity.faviconAttachmentId`, applied at
  // runtime by `BrandProvider`). This layout is a SERVER component with no
  // session, so it cannot read a settings key; what it emits here is what the
  // browser has on first paint, what a bookmark and the iOS home screen
  // capture, and what a visitor who never signs in sees. `BrandProvider`
  // replaces the `<link rel="icon">` once a session exists. Both are needed —
  // see the long note on `applyFavicon` in `lib/brand/BrandProvider.tsx`.
  icons: {
    // iOS ignores the web manifest's icon list and specifically wants this tag.
    apple: '/icons/icon-192.png',
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
};

// Tablet-first (POS/outlet) + mobile (me/driver) + desktop (dashboards) — no
// forced max-scale, since a kitchen tablet user may legitimately need to
// pinch-zoom a dense table.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Brand terracotta for the browser/OS chrome tint on first paint, before
  // the manifest loads. NOTE: public/manifest.json's own `theme_color` is
  // currently `#b91c1c` (this design system's danger-red, not the brand
  // color below) — likely a placeholder from whoever stood the manifest up;
  // flagged for a one-line fix rather than edited here (manifest.json is
  // W2-E's file).
  themeColor: '#a8481a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={`${inter.variable} ${manrope.variable}`}>
      <body>
        <I18nProvider>
          {/* F-DOC — injects the owner's `--color-brand-*` ramp and favicon
              onto the document once a session exists. It sits INSIDE
              `I18nProvider` (it has no copy of its own, but anything it may
              later need to say belongs in one dictionary) and OUTSIDE
              `AppShell`, so the palette is applied for chromeless routes —
              POS and every /print document — as well as for the shell. */}
          <BrandProvider>
            <AppShell>{children}</AppShell>
          </BrandProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
