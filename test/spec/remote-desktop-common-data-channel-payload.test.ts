import { runNative } from './support/native-exec.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const HARNESS = resolve(ROOT, 'test', 'spec', 'remote-desktop-common-data-channel-payload.cc');
const NATIVE_TIMEOUT_MS = 60_000;

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], {});
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the data-channel payload test');
}

describe.skipIf(process.platform === 'win32')('remote-desktop data-channel payload parser', () => {
  it('accepts exactly the shapes the browser sends and refuses everything else (held_input included)', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-payload-'));
    const executable = resolve(temp, 'payload');
    try {
      const compile = await runNative(compiler, [
        '-std=c++20', '-Wall', '-Wextra', '-Werror', '-pedantic',
        '-I', COMMON,
        resolve(COMMON, 'data_channel_payload.cc'),
        resolve(COMMON, 'value_types.cc'),
        resolve(COMMON, 'quality_ladder.cc'),
        HARNESS,
        '-o', executable,
      ], {});
      expect(compile.status, `compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], {});
      expect(run.status, `payload harness failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, NATIVE_TIMEOUT_MS);
});
