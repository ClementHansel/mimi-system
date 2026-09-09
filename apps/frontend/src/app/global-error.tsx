'use client';

import { useEffect } from 'react';

/**
 * The boundary of last resort — for a throw in the ROOT LAYOUT itself, which
 * `app/error.tsx` cannot catch because it renders inside that layout.
 *
 * MA-190's crash was on a page, so `error.tsx` next door is the one that
 * matters there. This exists because the root layout mounts `I18nProvider`,
 * `BrandProvider` and `AppShell`, and a throw in any of those would otherwise
 * fall through to the same bare "Application error" sentence with the same
 * dead end.
 *
 * Deliberately dependency-free, and that is the whole point: it must render
 * when the providers above it are the thing that failed. So no `useI18n`
 * (its provider may be what threw), no `Button`, no design-token classes —
 * the token sheet is imported by the layout that is broken. Copy is inlined
 * in Indonesian rather than read from the dictionary, and the styles are
 * literal. It renders its own `<html>`/`<body>` because Next replaces the
 * whole document at this level.
 *
 * `window.location` for both actions rather than the router: at this point
 * React's tree is unusable, and a hard navigation is the only reliable move.
 * "Keluar" clears the stored session on the way out, since an unusable
 * persisted session is a documented cause of exactly this class of crash
 * (see `session-store.ts` and `app/error.tsx`).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[mimi] unhandled root-layout error', { digest: error.digest, error });
  }, [error]);

  function signOut() {
    try {
      window.localStorage.removeItem('mimi-session');
    } catch {
      // A browser blocking storage is not a reason to withhold the redirect.
    }
    window.location.href = '/login';
  }

  return (
    <html lang="id">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          backgroundColor: '#fafaf9',
          color: '#1c1917',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          textAlign: 'center',
        }}
      >
        <div
          style={{ maxWidth: '28rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>Aplikasi gagal dimuat</h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.5, margin: 0, color: '#44403c' }}>
            Terjadi kesalahan saat memuat aplikasi. Data Anda tidak terpengaruh. Coba muat ulang
            halaman ini; bila masih gagal, keluar lalu masuk kembali.
          </p>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              justifyContent: 'center',
              marginTop: '0.5rem',
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: '2.75rem',
                padding: '0 1rem',
                borderRadius: '0.375rem',
                border: 'none',
                backgroundColor: '#a8481a',
                color: '#fff',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Coba Lagi
            </button>
            <button
              type="button"
              onClick={signOut}
              style={{
                minHeight: '2.75rem',
                padding: '0 1rem',
                borderRadius: '0.375rem',
                border: '1px solid #d6d3d1',
                backgroundColor: 'transparent',
                color: '#1c1917',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Keluar
            </button>
          </div>
          {error.digest && (
            <p style={{ fontSize: '0.75rem', margin: 0, color: '#78716c' }}>
              Kode kesalahan: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
