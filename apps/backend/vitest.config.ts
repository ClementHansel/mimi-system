import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'path';

export default defineConfig({
  plugins: [swc.vite()],
  resolve: {
    alias: {
      '@mimi/shared': resolve(__dirname, '../../packages/shared/src'),
      '@mimi/shared/': resolve(__dirname, '../../packages/shared/src') + '/',
      '@mimi/sync-protocol': resolve(__dirname, '../../packages/sync-protocol/src'),
      '@mimi/sync-protocol/': resolve(__dirname, '../../packages/sync-protocol/src') + '/',
    },
  },
  test: {
    globals: true,
    root: './',
  },
});
