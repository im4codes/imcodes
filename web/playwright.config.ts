import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser harness for the chat timeline's per-update cost.
 *
 * Serves a PRODUCTION build of the fixture harness (`npm run build:fixtures`
 * then `npm run serve:fixtures`, i.e. `vite preview` over static output —
 * not `vite dev`) so host-sensitive rendering/perf characteristics match
 * what ships, not what the dev-server's on-the-fly transform produces.
 *
 * Correctness vs performance are two SEPARATE Playwright projects/commands
 * on purpose (see web/package.json's `test:browser` vs `test:browser:perf`):
 * perf specs are host-sensitive (CPU throttling, timing assertions) and a
 * slow correctness worker sharing a run with them would skew the numbers,
 * while a perf worker's own throttling would flake correctness assertions.
 * `npm run test:browser` never selects the `performance` project, and
 * `test:browser:perf` selects ONLY it.
 */

const PORT = 4300;
const BASE_URL = `http://localhost:${PORT}`;

// Playwright's own TS loader resolves `paths` from web/tsconfig.json, so
// `@shared/*` imports inside fixture-harness code work here the same as
// everywhere else in web/.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Builds + serves the fixtures bundle once per run and reuses it across
  // every project below (all four correctness projects + performance all
  // point at the same static server).
  webServer: {
    command: 'npm run build:fixtures && npm run serve:fixtures',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'performance',
      testMatch: /.*\.perf\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
});
