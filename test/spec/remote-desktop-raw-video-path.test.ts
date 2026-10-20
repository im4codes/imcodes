import { runNative } from './support/native-exec.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const MACOS = resolve(ROOT, 'native', 'macos-remote-desktop');

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the raw video path test');
}

describe('remote-desktop raw (libvpx) video path, session side', () => {
  it.skipIf(process.platform === 'win32')('routes frames by the negotiated codec under ASan and UBSan', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-rawpath-'));
    const executable = resolve(temp, 'raw-video-path');
    try {
      const compile = await runNative(compiler, [
        '-std=c++20', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror', '-pedantic',
        '-I', MACOS, '-I', COMMON,
        resolve(ROOT, 'test', 'spec', 'remote-desktop-raw-video-path.cc'),
        resolve(MACOS, 'codec_encoder_adapters.cc'),
        resolve(MACOS, 'macos_media_sender_binder.cc'),
        resolve(MACOS, 'h264_sender_bridge.cc'),
        resolve(COMMON, 'value_types.cc'),
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], {
        encoding: 'utf8',
        env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
      });
      expect(run.status, `run failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('raw video path counterfactuals passed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
