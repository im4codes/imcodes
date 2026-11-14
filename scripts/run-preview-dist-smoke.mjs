#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolvePlatformCommand } from './daemon-runtime-artifacts.mjs';

export function runSmokeCommand(command, args, options = {}) {
  const { platform, env, spawnSyncImpl, ...spawnOpts } = options;
  const resolved = resolvePlatformCommand(command, args, { platform, env });
  const run = spawnSyncImpl ?? spawnSync;
  const result = run(resolved.command, resolved.args, {
    stdio: 'inherit',
    shell: false,
    ...(env !== undefined ? { env } : {}),
    ...spawnOpts,
    ...resolved.options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runSmokeCommand('npm', ['run', 'build']);
  runSmokeCommand('npx', [
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
}
