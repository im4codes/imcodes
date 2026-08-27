import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM,
  MACOS_REMOTE_DESKTOP_SESSION_TYPE,
} from '../../src/node/macos-remote-desktop-session-type.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');
const COMMON = resolve(ROOT, 'native/remote-desktop-common');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS LoginWindow capture supervision', () => {
  const header = read('native/macos-remote-desktop/macos_login_window_capture.h');
  const impl = read('native/macos-remote-desktop/macos_login_window_capture.cc');

  it('pins the 14.4 boundary and session tokens to the TypeScript contract', async () => {
    expect(header).toContain(
      `kLoginWindowScreenCaptureKitMajor = ${MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM.major}`,
    );
    expect(header).toContain(
      `kLoginWindowScreenCaptureKitMinor = ${MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM.minor}`,
    );
    for (const value of Object.values(MACOS_REMOTE_DESKTOP_SESSION_TYPE)) {
      expect(header, value).toContain(`"${value}"`);
    }
  });

  it('drives both backends through one interface, so bounds cannot drift', async () => {
    // A second backend interface would let the CGDisplayStream path acquire its
    // own frame/topology/first-frame/teardown bounds.
    expect(header).toContain('ScreenCaptureKitBackend* screen_capture_kit');
    expect(header).toContain('ScreenCaptureKitBackend* cg_display_stream');
    expect(impl).not.toMatch(/class\s+\w*CgDisplayStreamBackend/u);
    // And it must stay free of Apple headers or it could not be sanitized here.
    // Comments may name ScreenCaptureKit; includes may not pull it in.
    const includes = impl.split('\n').filter((line) => /^\s*#\s*(include|import)/u.test(line));
    expect(includes.join('\n')).not.toMatch(/#import|CoreGraphics|ScreenCaptureKit|Cocoa/u);
  });

  it('keeps one source of truth for the shared capture bounds', async () => {
    const relocated = read('native/macos-remote-desktop/screen_capture_kit_limits.cc');
    expect(relocated).toContain('ScreenCaptureKitLimits::IsValid');
    // The adapter must not carry a second copy of the same bounds.
    const adapter = read('native/macos-remote-desktop/screen_capture_kit_adapter.mm');
    expect(adapter).not.toContain('kMaximumTimeoutMs = ');
    // The definition moved; the declaration legitimately stays in the header.
    expect(adapter).not.toMatch(/bool\s+ScreenCaptureKitLimits::IsValid/u);
  });

  it('ships a real CGDisplayStream backend, not a stub', async () => {
    const backend = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
    // The pre-14.4 path must actually capture. A stub that reported success
    // would be worse than refusing: the operator would see a frozen screen and
    // believe the session was live.
    expect(backend).toContain('CGDisplayStreamCreateWithDispatchQueue');
    expect(backend).toContain('CGDisplayStreamStart');
    expect(backend).toContain('CGDisplayStreamStop');
    expect(backend).toContain('CGGetActiveDisplayList');
    // Same interface as ScreenCaptureKit, so the bounds cannot drift.
    expect(backend).toContain('public ScreenCaptureKitBackend');
    expect(backend).toContain('public ScreenCaptureKitBackendStream');
    // Backpressure uses the shared bound rather than an unbounded queue.
    expect(backend).toContain('max_pending_');
    // Encoded pixels come from the display mode: on a Retina panel the logical
    // bounds are half-resolution.
    expect(backend).toContain('CGDisplayModeGetPixelWidth');
    // Preflight, never request: a TCC prompt at the login window has nobody to
    // answer it.
    expect(backend).toContain('CGPreflightScreenCaptureAccess');
    expect(backend).not.toContain('CGRequestScreenCaptureAccess');
  });

  it('compiles the CGDisplayStream backend against CoreGraphics', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-cgds-'));
    try {
      const compile = await runNative('xcrun', [
        '--sdk', 'macosx', 'clang++', '-std=c++20', '-c',
        '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=12.3',
        '-I', NATIVE, '-I', COMMON,
        resolve(NATIVE, 'cg_display_stream_backend.mm'),
        '-o', resolve(directory, 'cgds.o'),
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the capture counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-lwc-'));
    try {
      const output = resolve(directory, 'login-window-capture');
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-I', NATIVE, '-I', COMMON,
        resolve(NATIVE, 'macos_login_window_capture.cc'),
        resolve(NATIVE, 'screen_capture_kit_limits.cc'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-login-window-capture-test.cc'),
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
      expect(run.stdout).toContain('macos login window capture counterfactual ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
