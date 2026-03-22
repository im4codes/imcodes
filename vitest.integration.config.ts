import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'integration',
      include: ['test/**/*.integration.test.ts'],
      environment: 'node',
      globals: false,
      testTimeout: 30_000,
    },
  },
]);
