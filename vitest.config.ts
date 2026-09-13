import { defineConfig } from 'vitest/config';

/**
 * Probe files owned by test/setup/isolated-home.test.ts. They are NOT tests in
 * their own right: each one only means something when the harness runs it
 * through a throwaway config that installs the isolated-home setup (or, for the
 * leak probe, deliberately breaks it). Collected by any standing config they
 * either fail -- IMCODES_HOME is unset there -- or silently rewrite HOME for the
 * rest of that run.
 *
 * They used to be kept out of the daemon project only because their names happen
 * to end in `.integration.test.ts`. That same suffix is exactly what
 * vitest.integration.config.ts collects, which is how they leaked into
 * `npm run test:integration` (CI run 34745118391). Exclude them by LOCATION, in
 * every standing config, from this one constant.
 */
export const HARNESS_OWNED_PROBE_FIXTURES = 'test/setup/fixtures/**';

// Every suite is a project; `--project <name>` selects one (see the test:*
// scripts). This replaced a separate `vitest.workspace.ts`, which vitest 3
// deprecates and vitest 4 removes. The root previously also carried its own
// include/exclude for a bare `vitest run`, but that was already dead: vitest
// auto-loads a workspace file when one exists, so the projects below have been
// the only thing running for some time.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'daemon',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/e2e/**', 'test/**/*.integration.test.ts', HARNESS_OWNED_PROBE_FIXTURES, '**/node_modules/**'],
          environment: 'node',
          globals: false,
          // Runs before each test file is imported, which is the only point
          // early enough: daemon modules resolve ~/.imcodes paths at import
          // time (src/util/logger.ts even opens daemon.log there), so without
          // this the suite appends to the developer's real production log.
          // See test/setup/isolated-home.ts.
          setupFiles: ['./test/setup/isolated-home.ts'],
          // Owns the directory those per-worker homes live in and removes it once
          // every worker has exited — including workers that were killed. See
          // test/setup/isolated-home-global.ts.
          globalSetup: ['./test/setup/isolated-home-global.ts'],
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
    ],
    // NOTE: this `coverage` block was previously a sibling of `test:` at the
    // top level, where vitest silently ignored it and fell back to its
    // built-in defaults — which include the `html` reporter (writes hundreds
    // of per-file pages) and an unbounded include glob that re-instruments
    // the entire workspace on every run. Putting the block in its rightful
    // place + tightening reporter/include/exclude was the bulk of the CI
    // coverage-job slowdown.
    coverage: {
      provider: 'v8',
      // CI consumes machine-readable formats only.
      // - `lcovonly`     — Codecov auto-detects this. We use `lcovonly`
      //                    instead of `lcov` because the latter ALSO
      //                    generates a sibling `lcov-report/` directory of
      //                    ~556 per-file HTML pages (~24 MB) that nothing
      //                    in CI consumes — pure I/O waste.
      // - `json-summary` — used by the vitest-coverage-report-action PR
      //                    comment and by `scripts/write-coverage-summary.mjs`.
      // - `json`         — required by write-coverage-summary (reads
      //                    coverage-final.json to regenerate the summary).
      // - `text`         — short terminal table at the end of the run.
      // Local dev keeps `html` so developers can browse coverage in a
      // browser; CI never needs it.
      reporter: process.env.CI
        ? ['lcovonly', 'json-summary', 'json', 'text']
        : ['text', 'html'],
      // Only instrument actual source — never tests, build outputs, or
      // ancillary scripts. v8 instrumentation cost scales with the size of
      // the included tree.
      include: [
        'src/**/*.ts',
        'web/src/**/*.ts',
        'web/src/**/*.tsx',
        'server/src/**/*.ts',
        'shared/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.bench.ts',
        '**/*.d.ts',
        '**/*.config.ts',
        '**/dist/**',
        '**/node_modules/**',
        'test/**',
        'web/test/**',
        'server/test/**',
        'docs/**',
        'openspec/**',
        'scripts/**',
        'bench/**',
        'worker/**',
        'mobile/**',
      ],
    },
  },
});
