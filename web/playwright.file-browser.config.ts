import { defineConfig, devices } from '@playwright/test';

// The responsive fixture is self-contained and injects production CSS, so it
// does not need to build or boot the full application shell.
export default defineConfig({
  testDir: './e2e',
  reporter: [['list']],
  projects: [{ name: 'file-browser-responsive', use: { ...devices['Desktop Chrome'] } }],
});
