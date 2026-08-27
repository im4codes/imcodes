import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMON = resolve(ROOT, 'native', 'remote-desktop-common');
const FAKE = resolve(ROOT, 'test', 'spec', 'remote-desktop-common-conformance.cc');

const SANITIZER_FLAGS = [
  '-fsanitize=address,undefined',
  '-fno-omit-frame-pointer',
];

async function findCompiler(): Promise<string> {
  for (const candidate of [process.env.CXX, 'clang++', 'c++', 'g++']) {
    if (!candidate) continue;
    const probe = await runNative(candidate, ['--version'], {});
    if (probe.status === 0) return candidate;
  }
  throw new Error('A C++20 compiler is required for the common native conformance test');
}

async function supportsSanitizers(compiler: string, directory: string): Promise<boolean> {
  const probe = resolve(directory, 'sanitizer-probe');
  const result = await runNative(compiler, [
    '-std=c++20',
    ...SANITIZER_FLAGS,
    '-x', 'c++', '-',
    '-o', probe,
  ], {
    input: 'int main() { return 0; }',
  });
  if (result.status !== 0) return false;
  return (await runNative(probe, [], {
    env: {
      ...process.env,
      ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
      UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
    },
  })).status === 0;
}

describe.skipIf(process.platform === 'win32')('remote-desktop common conformance fake', () => {
  it('compiles without a platform SDK and exercises the common contracts', async () => {
    const compiler = await findCompiler();
    const temp = mkdtempSync(resolve(tmpdir(), 'imcodes-rd-common-'));
    const executable = resolve(temp, 'remote-desktop-common-conformance');
    try {
      const sanitizerFlags = await supportsSanitizers(compiler, temp)
        ? SANITIZER_FLAGS
        : [];
      const compile = await runNative(compiler, [
        '-std=c++20',
        ...sanitizerFlags,
        '-Wall',
        '-Wextra',
        '-Werror',
        '-pedantic',
        '-I', COMMON,
        resolve(COMMON, 'value_types.cc'),
        resolve(COMMON, 'input_ledger.cc'),
        resolve(COMMON, 'session_core.cc'),
        FAKE,
        '-o', executable,
      ], {});
      expect(
        compile.status,
        `native compile failed\nstdout:\n${compile.stdout}\nstderr:\n${compile.stderr}`,
      ).toBe(0);

      const run = await runNative(executable, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(
        run.status,
        `conformance fake failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      ).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('pins every requested failure-mode assertion in the executable fake', async () => {
    const fake = readFileSync(FAKE, 'utf8');
    for (const assertion of [
      'encoded width remains video pixels',
      'logical width remains input coordinates',
      'partial capability set is not control-ready',
      'stale topology input is rejected before injection',
      'controller-specific release preserves another owner',
      'stale sequence is rejected by the common ledger',
      'obsolete controller epochs are rejected',
      'oversized text is rejected before sequence consumption',
      'out-of-range wheel input is rejected before sequence consumption',
      'ledger terminal release-all clears every controller',
      'adapter failure is terminal',
      'input backend failure is reported through SessionCore',
      'input backend failure performs terminal release-all',
      'terminal failure performs one release-all',
      'terminal cleanup is idempotent',
    ]) {
      expect(fake).toContain(assertion);
    }
  });
});
