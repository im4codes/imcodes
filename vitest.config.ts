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
