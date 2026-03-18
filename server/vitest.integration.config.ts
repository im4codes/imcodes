import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['test/setup/integration-global.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serial — one shared container, tests must not run concurrently
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
