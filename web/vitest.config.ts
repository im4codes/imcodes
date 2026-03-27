import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
    jsxDev: false,
  },
  test: {
    name: 'web',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    environment: 'jsdom',
    globals: false,
  },
});
