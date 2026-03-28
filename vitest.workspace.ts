import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'daemon',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      exclude: ['test/e2e/**', 'test/**/*.integration.test.ts', '**/node_modules/**'],
      environment: 'node',
      globals: false,
    },
  },
  './web/vitest.config.ts',
  {
    test: {
      name: 'server',
      include: ['server/test/**/*.test.ts'],
      // auth-flow and proxy-addr tests depend on @hono/node-server and proxy-addr
      // which live in server/node_modules. Exclude them from the root workspace;
      // they run via `cd server && npm test` in their own environment.
      exclude: [
        'server/test/**/*.integration.test.ts',
        'server/test/auth-flow.test.ts',
        'server/test/bind-rebind.test.ts',
        'server/test/auth-security.test.ts',
        'server/test/proxy-addr.test.ts',
        'server/test/password-auth.test.ts',
        'server/test/admin.test.ts',
        'server/test/cron-api.test.ts',
        'server/test/job-dispatch.test.ts',
        '**/node_modules/**',
      ],
      environment: 'node',
      globals: false,
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['test/e2e/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
      globals: false,
      testTimeout: 30000, // E2E tests spawn real tmux + agent processes which take several seconds
    },
  },
]);
