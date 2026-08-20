import { defineConfig } from 'vitest/config';
import { WEB_FAKE_TIMERS } from './vitest.fake-timers.js';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'web-components',
    include: ['test/components/**/*.test.ts', 'test/components/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    environment: 'jsdom',
    fakeTimers: { ...WEB_FAKE_TIMERS },
    globals: false,
    setupFiles: ['./test/setup-jsdom-storage.ts'],
    poolOptions: { forks: { execArgv: ['--max-old-space-size=6144'] } },
  },
});
