import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'daemon',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
      exclude: ['test/e2e/**', 'test/**/*.integration.test.ts', '**/node_modules/**'],
      environment: 'node',
      globals: false,
      // The context-store-worker-isolation change adds real-Worker-thread tests
      // (context-store-worker / context-store-production-owner / memory-recall-l3-*
      // / materialization warm-worker e2e) that spawn threads + do real SQLite work,
      // raising the suite's steady-state CPU contention. Under full-suite parallel
      // load that contention can starve slow-but-correct tests (multi-MB JSONL
      // replay, stdio MCP server, etc.) past vitest's tight 5000ms default — they
      // pass in isolation but intermittently time out in the full run. A
      // contention-tolerant default keeps parallel-load starvation from failing a
      // correct test while genuine hangs (>>20s) still fail. Heavy real-worker
      // cases keep their explicit per-test overrides (20_000/30_000), which win.
      testTimeout: 20000,
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
      fileParallelism: false,
      hookTimeout: 30000,
      testTimeout: 90000, // E2E tests spawn real tmux + agent processes and are unstable under file-level parallelism
      // A cold embedding-model load plus tmux/agent spawn can push a single
      // attempt just past the timeout (observed 60008ms on a 60s limit). Retry
      // so a transient e2e timeout re-runs warm instead of failing CI.
      retry: 2,
    },
  },
]);
