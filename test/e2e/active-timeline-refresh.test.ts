/**
 * E2E gate for the native-resume timeline refresh chain.
 *
 * The root e2e project does not own the web app's Preact/jsdom dependency
 * graph, so the actual activation-chain test lives under `web/test/`.
 * This wrapper runs that test under the web Vitest config as part of the
 * existing `npm run test:e2e` workflow, so the e2e stage still fails if the
 * browser-side resume -> HTTP backfill chain regresses.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function runWebActivationChainTest(): void {
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(
    npxBin,
    ['vitest', 'run', 'test/app-resume-refresh.test.tsx'],
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

describe('active timeline refresh e2e gate', () => {
  it('passes the web activation-chain test under the real web test config', () => {
    expect(runWebActivationChainTest).not.toThrow();
  }, 60_000);
});
