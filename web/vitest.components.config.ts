import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'web-components',
    include: ['test/components/**/*.test.ts', 'test/components/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup-jsdom-storage.ts'],
    poolOptions: { forks: { execArgv: ['--max-old-space-size=6144'] } },
  },
});
