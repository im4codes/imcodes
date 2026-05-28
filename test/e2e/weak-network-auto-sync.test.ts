/**
 * E2E gate for the weak-network auto-sync chain (run f9f61e78-e82).
 *
 * The root e2e project does not own the web app's Preact/jsdom dependency
 * graph, so the actual browser-side validation lives under `web/test/`. This
 * wrapper runs that suite under the web Vitest config as part of the existing
 * `npm run test:e2e` workflow, so the e2e stage fails if the weak-network
 * recovery chain regresses:
 *   - HTTP backfill must use the 10s recovery budget (not the old 2.5s abort).
 *   - The foreground watchdog must recover a silently-dropped event with no
 *     user action, while an idle session does not poll on every tick.
 *   - A visible-but-not-focused session must catch up on resume (isVisible gate).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function runWebWeakNetworkSuite(): void {
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(
    npxBin,
    ['vitest', 'run', 'test/weak-network-auto-sync.test.tsx'],
    {
      cwd: join(process.cwd(), 'web'),
      stdio: 'inherit',
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
      },
    },
  );
}

describe('weak-network auto-sync e2e gate', () => {
  it('passes the web weak-network sync suite under the real web test config', () => {
    expect(runWebWeakNetworkSuite).not.toThrow();
  }, 60_000);
});
