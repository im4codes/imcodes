import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS local permission readiness and onboarding contract', () => {
  const header = read(
    'native/macos-remote-desktop/macos_permission_readiness.h',
  );
  const implementation = read(
    'native/macos-remote-desktop/macos_permission_readiness.mm',
  );

  it('keeps Apple APIs private and uses non-interactive permission probes', async () => {
    expect(header).not.toMatch(
      /#import|NSWorkspace|NSURL|NSString|CGPreflight|AXIsProcessTrusted/,
    );
    expect(implementation).toContain('CGPreflightScreenCaptureAccess()');
    expect(implementation).toContain('AXIsProcessTrusted()');
    expect(implementation).not.toMatch(/\bCGRequestScreenCaptureAccess\s*\(/);
    expect(implementation).not.toMatch(/\bAXIsProcessTrustedWithOptions\s*\(/);
  });

  it('opens only the platform-correct local Settings panes', async () => {
    expect(implementation).toContain(
      'Privacy_ScreenCapture',
    );
    expect(implementation).toContain(
      'Privacy_Accessibility',
    );
    expect(implementation).toContain(
      'MacosPermissionActionOrigin::kLocalExplicit',
    );
    expect(implementation).toContain(
      'MacosPermissionActionResultCode::kRejectedNonLocal',
    );
  });

  it('pins bounded generation/freshness and fail-closed capability application', async () => {
    expect(header).toContain('expected_worker_generation');
    expect(header).toContain('expected_observation_sequence');
    expect(implementation).toContain('kMaximumFreshnessWindowMs');
    expect(implementation).toContain('snapshot_.IsFreshFor');
    expect(implementation).toContain(
      'readiness.capture = common::ReadinessState::kUnavailable',
    );
    expect(implementation).toContain(
      'readiness.input = common::ReadinessState::kUnavailable',
    );
  });

  it('compiles production Objective-C++ for macOS 13 arm64 and x86_64', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-permission-obj-'));
    try {
      for (const architecture of ['arm64', 'x86_64']) {
        const object = resolve(directory, `permission-${architecture}.o`);
        const compile = await runNative('xcrun', [
          'clang++',
          '-std=c++20',
          '-fobjc-arc',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wunguarded-availability-new',
          '-mmacosx-version-min=12.3',
          '-arch', architecture,
          '-I', resolve(ROOT, 'native/macos-remote-desktop'),
          '-I', resolve(ROOT, 'native/remote-desktop-common'),
          '-c', resolve(
            ROOT,
            'native/macos-remote-desktop/macos_permission_readiness.mm',
          ),
          '-o', object,
        ], { encoding: 'utf8' });
        expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs denied/partial/stale/nonlocal counterfactuals under sanitizers', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-permission-test-'));
    const executable = resolve(directory, 'permission-test');
    try {
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-fobjc-arc',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wunguarded-availability-new',
        '-fsanitize=address,undefined',
        '-fno-omit-frame-pointer',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-permission-readiness-test.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/macos_permission_readiness.mm'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        '-framework', 'AppKit',
        '-framework', 'ApplicationServices',
        '-framework', 'CoreGraphics',
        '-framework', 'Foundation',
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = await runNative(executable, [], {
        env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0' },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
