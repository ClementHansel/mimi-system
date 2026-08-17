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
    const backend = process.env.BACKEND_ORIGIN || 'http://backend:4000';
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${backend}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
