import { runNative } from './support/native-exec.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSource } from '../helpers/read-source.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const COUNTERFACTUAL = resolve(ROOT, 'test', 'spec', 'remote-desktop-encode-speed-governor.cc');

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the encode speed governor test');
}

describe('remote-desktop encode speed governor', () => {
  it('is a public, header-only part of the common GN target and stays platform neutral', () => {
    const build = readSource(resolve(COMMON, 'BUILD.gn'));
    expect(build).toContain('"encode_speed_governor.h"');
    expect(build).toMatch(/public\s*=\s*\[[\s\S]*"encode_speed_governor\.h"[\s\S]*\]/);
    const header = readSource(resolve(COMMON, 'encode_speed_governor.h'));
    for (const token of ['VideoToolbox', 'CoreVideo', 'dispatch', 'windows.h', 'webrtc::', '__APPLE__', '_WIN32']) {
      expect(header, `${token} stays out of the pure policy`).not.toContain(token);
    }
  });

  it.skipIf(process.platform === 'win32')('passes its counterfactuals under ASan and UBSan', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-governor-'));
    const executable = resolve(temp, 'governor');
    try {
      const compile = await runNative(compiler, [
        '-std=c++20',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-pedantic',
        '-I', COMMON,
        COUNTERFACTUAL,
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `run failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('encode speed governor counterfactuals passed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
