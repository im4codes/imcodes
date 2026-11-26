import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NATIVE_COMPILE_TEST_TIMEOUT_MS, runNative } from './support/native-exec.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const PULSE_CAPTURE = join(ROOT, 'native', 'linux-remote-desktop', 'linux_pulse_loopback_capture.cc');
const PAYLOAD = join(ROOT, 'native', 'remote-desktop-common', 'data_channel_payload.cc');
const TEST_SRC = join(HERE, 'linux-remote-desktop-audio-test.cc');

function compiler(): string | null {
  for (const candidate of ['clang++', 'g++']) {
    if (spawnSync(candidate, ['--version']).status === 0) return candidate;
  }
  return null;
}

describe('linux remote desktop PulseAudio loopback audio unit test', () => {
  it.skipIf(process.platform !== 'linux')(
    'verifies @DEFAULT_MONITOR@, missing-lib & unreachable-server silent fallback, read recovery, and multi-session refcounting',
    async () => {
      const cxx = compiler();
      expect(cxx, 'a C++20 compiler is required').not.toBeNull();

      const directory = mkdtempSync(join(tmpdir(), 'imcodes-linux-audio-'));
      try {
        const binary = join(directory, 'audio_test');
        const build = await runNative(cxx!, [
          '-std=c++20',
          '-O0',
          '-Wall',
          '-Wextra',
          '-Werror',
          `-I${ROOT}`,
          PULSE_CAPTURE,
          PAYLOAD,
          TEST_SRC,
          '-lpthread',
          '-ldl',
          '-o',
          binary,
        ]);
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

        const run = await runNative(binary, []);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        expect(run.stdout).toContain('linux remote desktop pulse loopback audio: ok');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    NATIVE_COMPILE_TEST_TIMEOUT_MS,
  );
});
