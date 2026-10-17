import { configDefaults, defineConfig } from 'vitest/config';
import { HARNESS_OWNED_PROBE_FIXTURES } from './vitest.config.js';

// Selected with `--config`, not `--workspace`: a single-project workspace has
// no reason to be one, and vitest 4 removes both `defineWorkspace` and the
// `--workspace` flag.
export default defineConfig({
  test: {
    name: 'integration',
    include: ['test/**/*.integration.test.ts'],
    // The isolated-home probes share this suffix but are owned by their harness,
    // which runs them with the setup they need. `exclude` replaces vitest's
    // defaults rather than extending them, so keep those explicitly.
    exclude: [...configDefaults.exclude, HARNESS_OWNED_PROBE_FIXTURES],
    environment: 'node',
    globals: false,
    testTimeout: 30_000,
  },
});
