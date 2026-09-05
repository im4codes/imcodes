import { defineConfig } from 'vitest/config';
import { WEB_FAKE_TIMERS } from './vitest.fake-timers.js';
import path from 'path';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'web-filebrowser',
    include: ['test/components/FileBrowser.test.tsx'],
    exclude: ['**/node_modules/**'],
    environment: 'jsdom',
    fakeTimers: { ...WEB_FAKE_TIMERS },
    globals: false,
    // Must match vitest.components.config.ts, which is the config CI actually
    // gates on for this file. Without the storage shim jsdom hands back a plain
    // object and every test dies on `localStorage.clear is not a function` — so
    // this "run it in isolation" helper disagreed with CI, which is the worst
    // possible failure mode for a debugging tool.
    setupFiles: ['./test/setup-jsdom-storage.ts'],
    poolOptions: { forks: { execArgv: ['--max-old-space-size=6144'] } },
  },
});
