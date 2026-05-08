#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(npmCmd, ['run', 'build']);
run(npxCmd, [
  'vitest',
  'run',
  'test/daemon/file-preview-read-dist-smoke.test.ts',
  'test/daemon/file-preview-read-dist-daemon-smoke.test.ts',
], {
  env: {
    ...process.env,
    PREVIEW_DIST_REQUIRED: '1',
  },
});
