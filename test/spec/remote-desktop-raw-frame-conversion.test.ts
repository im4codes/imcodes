import { runNative } from './support/native-exec.js';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const MACOS = resolve(ROOT, 'native', 'macos-remote-desktop');
// libyuv is the library the pinned libwebrtc SDK already ships; it is not vendored
// here. Point this at a libyuv checkout (it holds include/ and source/) to run the
// conversion test on a host; the macOS CI job compiles and links the same code
// against the SDK's own copy.
const LIBYUV = process.env.IMCODES_LIBYUV_SOURCE ?? '';
const haveLibyuv = LIBYUV !== '' && existsSync(resolve(LIBYUV, 'include', 'libyuv', 'convert.h'));

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the raw frame conversion test');
}

describe('remote-desktop raw frame conversion (libyuv)', () => {
  it.skipIf(process.platform === 'win32' || !haveLibyuv)('converts BGRA and NV12 to I420 on the BT.709 limited-range matrix', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-rawconv-'));
    const executable = resolve(temp, 'raw-frame-conversion');
    try {
      const sources = readdirSync(resolve(LIBYUV, 'source'))
        .filter((name) => name.endsWith('.cc'))
        .map((name) => resolve(LIBYUV, 'source', name));
      // libyuv is third-party code: built on its own, without our warning flags.
      const library = await runNative(compiler, [
        '-std=c++17', '-O1', '-c',
        '-DLIBYUV_DISABLE_NEON', '-DLIBYUV_DISABLE_SVE', '-DLIBYUV_DISABLE_SME',
        '-DLIBYUV_DISABLE_LSX', '-DLIBYUV_DISABLE_LASX',
        '-I', resolve(LIBYUV, 'include'),
        ...sources,
      ], { encoding: 'utf8', cwd: temp });
      expect(library.status, `libyuv build failed\n${library.stderr}`).toBe(0);
      const objects = readdirSync(temp).filter((name) => name.endsWith('.o')).map((name) => resolve(temp, name));
      const compile = await runNative(compiler, [
        '-std=c++20', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror', '-pedantic',
        '-I', MACOS, '-I', COMMON, '-I', resolve(LIBYUV, 'include'),
        resolve(ROOT, 'test', 'spec', 'remote-desktop-raw-frame-conversion.cc'),
        resolve(MACOS, 'raw_frame_conversion.cc'),
        resolve(COMMON, 'value_types.cc'),
        ...objects,
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], {
        encoding: 'utf8',
        env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
      });
      expect(run.status, `run failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('raw frame conversion counterfactuals passed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 300_000);
});
