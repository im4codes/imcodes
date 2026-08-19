import { defineConfig } from 'vitest/config';

// Selected with `--config`, not `--workspace`: a single-project workspace has
// no reason to be one, and vitest 4 removes both `defineWorkspace` and the
// `--workspace` flag.
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
  },
});
