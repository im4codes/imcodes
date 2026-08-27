import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

async function runXcrun(arguments_: string[]) {
  return await runNative('xcrun', arguments_, {
    cwd: ROOT,
    env: {
      ...process.env,
      // LeakSanitizer is unavailable in Apple's system ASan runtime. Address
      // and UB instrumentation still remain active for the native fake.
      ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1',
      UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
    },
  });
}

describe('macOS CGEvent input adapter', () => {
  const header = read('native/macos-remote-desktop/cg_event_input_adapter.h');
  const implementation = read('native/macos-remote-desktop/cg_event_input_adapter.mm');
  const nativeTest = read('test/spec/macos-remote-desktop-input-test.mm');

  it('keeps Apple SDK types behind PImpl and an injected platform-neutral backend', async () => {
    expect(header).toContain('class Impl;');
    expect(header).toContain('std::unique_ptr<Impl> impl_');
    expect(header).toContain('class CGEventInputBackend');
    expect(header).not.toMatch(/#import|ApplicationServices|Foundation|CGEventRef|CGKeyCode|CGPoint|AXUIElement/);
    expect(implementation).toContain('#import <ApplicationServices/ApplicationServices.h>');
    expect(implementation).toContain('class SystemCGEventInputBackend final');
  });

  it('probes Accessibility without requesting or coercing a TCC prompt', async () => {
    expect(implementation).toContain('AXIsProcessTrusted()');
    expect(implementation).not.toMatch(/AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt/);
    expect(implementation).not.toMatch(/osascript|tccutil|AuthorizationExecuteWithPrivileges|loginwindow/);
  });

  it('keeps authority and replay ownership in the common InputLedger', async () => {
    expect(header).toContain('Input ownership, epochs, sequence fencing and controller reference counts');
    expect(nativeTest).toContain('common::InputLedger ledger(adapter)');
    expect(nativeTest).toContain('common::InputResult::kStaleSequence');
    expect(nativeTest).toContain('common::InputResult::kStaleTopology');
    expect(nativeTest).not.toMatch(/adapter\.Emit(?:Key|Button|Wheel|Text)\s*\(/);
  });

  it('names every terminal release boundary and retains failed releases for retry', async () => {
    for (const reason of [
      'kDowngrade',
      'kDisconnect',
      'kPermissionLoss',
      'kUserChange',
      'kAgentCrash',
      'kShutdown',
    ]) {
      expect(header).toContain(reason);
      expect(nativeTest).toContain(`CGEventInputReleaseReason::${reason}`);
    }
    expect(implementation).toContain('current = emitted_keys_.erase(current)');
    expect(implementation).toContain('current = emitted_buttons_.erase(current)');
    expect(implementation).toContain('++statistics_.release_failures');
  });

  it('compiles the production Objective-C++ adapter for macOS 13 arm64 and x86_64', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-input-objects-'));
    try {
      for (const architecture of ['arm64', 'x86_64']) {
        const compile = await runXcrun([
          'clang++',
          '-std=c++20',
          '-x', 'objective-c++',
          '-fobjc-arc',
          '-fblocks',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wunguarded-availability-new',
          '-mmacosx-version-min=12.3',
          '-arch', architecture,
          '-I', resolve(ROOT, 'native/macos-remote-desktop'),
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(ROOT, 'native/macos-remote-desktop/cg_event_input_adapter.mm'),
          '-o', resolve(directory, `cg-event-input-${architecture}.o`),
        ]);
        expect(compile.status, `${architecture}\n${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs the ledger/topology/stuck-input fake under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-input-test-'));
    const executable = resolve(directory, 'macos-input-test');
    try {
      const compile = await runXcrun([
        'clang++',
        '-std=c++20',
        '-fobjc-arc',
        '-fblocks',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wunguarded-availability-new',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-input-test.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/cg_event_input_adapter.mm'),
        resolve(ROOT, 'native/remote-desktop-common/input_ledger.cc'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        '-framework', 'ApplicationServices',
        '-framework', 'Foundation',
        '-o', executable,
      ]);
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = await runNative(executable, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
