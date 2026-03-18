import { defineConfig } from 'vitest/config';

// Default config used by plain `vitest run` (no --project flag).
// Project-specific runs (test:unit, test:worker, etc.) use vitest.workspace.ts.
export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'worker/test/**/*.test.ts',
    ],
    exclude: [
      'test/e2e/**',
      'web/test/**',
      '**/node_modules/**',
    ],
    environment: 'node',
    globals: false,
  },
});
