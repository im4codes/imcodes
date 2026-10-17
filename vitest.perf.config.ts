import { defineConfig } from 'vitest/config';

/**
 * Real-machine perf harnesses (never collected by the standing suites: the
 * files end in `.perf.ts`). Run one with
 *   PERF_LABEL=fixed PERF_DURATION_SEC=300 npx vitest run --config vitest.perf.config.ts
 */
export default defineConfig({
  test: {
    name: 'perf',
    include: ['test/perf/daemon-event-path/**/*.perf.ts', 'test/perf/timeline-delete/**/*.perf.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/setup/isolated-home.ts'],
    globalSetup: ['./test/setup/isolated-home-global.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 20 * 60_000,
    fileParallelism: false,
  },
});
