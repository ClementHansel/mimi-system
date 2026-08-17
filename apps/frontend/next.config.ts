import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'standalone',
  // Pin the file-tracing root to this monorepo so Next doesn't walk up past
  // it looking for a lockfile and mis-trace the workspace (breaks the
  // standalone copy, especially on Windows dev machines).
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@mimi/shared', '@mimi/sync-protocol'],
  reactStrictMode: true,
  typescript: {
    // Type checking is handled by `tsc --noEmit` in CI; App Router's generated
    // route types otherwise conflict with page files exporting extra symbols.
    ignoreBuildErrors: true,
  },
  eslint: {
    dirs: ['src/app', 'src/components', 'src/lib', 'src/stores'],
    ignoreDuringBuilds: true,
  },
  // Proxy /api and the sync socket to the backend so the PWA works whether it's
  // reached directly on :3000 (dev) or through Traefik in prod (which handles
  // /api first and never reaches this rewrite).
  async rewrites() {
    // Both compose files set BACKEND_ORIGIN explicitly, so this fallback is
    // ONLY reached when running `next dev` directly on a host machine — where
    // the Docker service name `backend` cannot resolve and every proxied /api
    // call fails with an opaque 500 (no message, no hint at DNS). Defaulting to
    // localhost makes host dev work out of the box; container runs are
    // unaffected because they never fall through to this value.
    const backend = process.env.BACKEND_ORIGIN || 'http://localhost:4000';
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${backend}/socket.io/:path*` },
      // `/sync/v1/*` is deliberately OUTSIDE the backend's `/api` prefix
      // (main.ts globalPrefix exclude list; CONTRACTS §4.23 / SYNC-PROTOCOL
      // §4.1) so a device's sync transport needs no knowledge of the REST
      // prefix — same reasoning as the bare `/socket.io` namespace above.
      // It therefore needs its own rewrite: without it, any same-origin
      // deployment 404s the health probe, the upstream selector sees every
      // candidate as unreachable, and the UI pins itself to "Offline" while
      // ordinary /api traffic flows perfectly. Silent and very confusing —
      // the app looks disconnected while visibly loading live data.
      { source: '/sync/v1/:path*', destination: `${backend}/sync/v1/:path*` },
    ];
  },
};

export default nextConfig;
