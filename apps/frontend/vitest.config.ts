import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  // The React plugin transforms JSX/TSX under vite 8; esbuild alone fails
  // because vite reads `jsx: preserve` from the Next tsconfig it inherits.
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@mimi/shared': resolve(__dirname, '../../packages/shared/src'),
      '@mimi/sync-protocol': resolve(__dirname, '../../packages/sync-protocol/src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
