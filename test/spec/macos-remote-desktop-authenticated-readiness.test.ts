import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runNative } from './support/native-exec.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');
const COMMON = resolve(ROOT, 'native/remote-desktop-common');

describe('macOS authenticated graphical readiness', () => {
  it('runs exact peer, successor, replay, and profile counterexamples under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-auth-readiness-'));
    try {
      const output = resolve(directory, 'authenticated-readiness');
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-I', NATIVE, '-I', COMMON,
        resolve(NATIVE, 'macos_authenticated_session_readiness.cc'),
        resolve(NATIVE, 'macos_worker_ipc_client.cc'),
        resolve(NATIVE, 'macos_login_window_capture.cc'),
        resolve(NATIVE, 'screen_capture_kit_limits.cc'),
        resolve(COMMON, 'value_types.cc'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-authenticated-readiness-test.cc'),
        '-o', output,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(output, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos authenticated readiness counterfactual ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
