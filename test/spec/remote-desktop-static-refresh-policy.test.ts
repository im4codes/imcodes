import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const COUNTERFACTUAL = resolve(ROOT, 'test', 'spec', 'remote-desktop-static-refresh-policy.cc');

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the static refresh policy test');
}

describe('remote-desktop static refresh policy', () => {
  it('is a public, header-only part of the common GN target, in the Windows overlay, and platform neutral', () => {
    const build = readFileSync(resolve(COMMON, 'BUILD.gn'), 'utf8');
    expect(build).toContain('"static_refresh_policy.h"');
    expect(build).toMatch(/public\s*=\s*\[[\s\S]*"static_refresh_policy\.h"[\s\S]*\]/);
    const overlay = readFileSync(resolve(ROOT, 'native', 'windows-remote-desktop', 'build-worker.ps1'), 'utf8');
    expect(overlay).toContain("'static_refresh_policy.h'");
    const header = readFileSync(resolve(COMMON, 'static_refresh_policy.h'), 'utf8');
    for (const token of ['VideoToolbox', 'CoreVideo', 'dispatch', 'windows.h', 'webrtc::', '__APPLE__', '_WIN32']) {
      expect(header, `${token} stays out of the pure policy`).not.toContain(token);
    }
  });

  it('keeps the measured thresholds', () => {
    const header = readFileSync(resolve(COMMON, 'static_refresh_policy.h'), 'utf8');
    expect(header).toContain('kStaticRefreshMinUnchangedRun = 3;');
    expect(header).toContain('kStaticRefreshMinFramesSinceKey = 10;');
    expect(header).toContain("kStaticRefreshMinBitrateBps = 6'000'000;");
    expect(header).toContain("kStaticRefreshMinIntervalMs = 5'000;");
  });

  it.skipIf(process.platform === 'win32')('passes its counterfactuals under ASan and UBSan', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-static-refresh-'));
    const executable = resolve(temp, 'static-refresh');
    try {
      const compile = await runNative(compiler, [
        '-std=c++20', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror', '-pedantic',
        '-I', COMMON, COUNTERFACTUAL, '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], {
        encoding: 'utf8',
        env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' },
      });
      expect(run.status, `run failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('static refresh policy counterfactuals passed');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
