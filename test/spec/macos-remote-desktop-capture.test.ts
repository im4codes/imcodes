import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS ScreenCaptureKit adapter', () => {
  const header = read('native/macos-remote-desktop/screen_capture_kit_adapter.h');
  const implementation = read('native/macos-remote-desktop/screen_capture_kit_adapter.mm');
  const build = read('native/macos-remote-desktop/BUILD.gn');

  it('keeps Apple SDK and Objective-C types behind a PImpl boundary', async () => {
    expect(header).toContain('class Impl;');
    expect(header).toContain('std::unique_ptr<Impl> impl_');
    expect(header).not.toMatch(/#import|SCStream|SCDisplay|CVPixelBuffer|CMSampleBuffer/);
    expect(implementation).toContain('#import <ScreenCaptureKit/ScreenCaptureKit.h>');
  });

  it('probes Screen Recording permission without requesting or coercing it', async () => {
    expect(implementation).toContain('CGPreflightScreenCaptureAccess()');
    expect(implementation).not.toMatch(/\bCGRequestScreenCaptureAccess\s*\(/);
    expect(implementation).not.toMatch(/loginwindow|AuthorizationExecuteWithPrivileges/);
  });

  it('uses bounded enumeration, queue and teardown contracts', async () => {
    expect(header).toContain("enumeration_timeout_ms = 3'000");
    expect(header).toContain("first_frame_timeout_ms = 3'000");
    expect(header).toContain('WaitForFirstFrame');
    expect(header).toContain('max_pending_frames = 2');
    expect(implementation).toContain('dropped_backpressure_frames');
    expect(implementation).toContain('ignored_late_frames');
    expect(implementation).toContain('CVPixelBufferRetain');
    expect(implementation).toContain('CVPixelBufferRelease');
    expect(implementation).toContain('CVPixelBufferGetBytesPerRow');
    expect(implementation).toContain('PixelFormat::kBgra8888');
    expect(implementation).toContain('CMSampleBufferGetPresentationTimeStamp');
    expect(implementation).toContain('SCStreamFrameInfoStatus');
    expect(implementation).toContain('start_requested_ = true');
    expect(implementation).toContain('if (!start_requested_)');
    expect(implementation).toContain('ScreenCaptureKit first frame timed out');
  });

  it('links the production adapter against only the required Apple capture frameworks', async () => {
    expect(build).toContain('source_set("screen_capture_kit_adapter")');
    for (const framework of [
      'CoreGraphics.framework',
      'CoreMedia.framework',
      'CoreVideo.framework',
      'Foundation.framework',
      'ScreenCaptureKit.framework',
    ]) {
      expect(build).toContain(`"${framework}"`);
    }
    expect(build).toContain('"-fobjc-arc"');
    expect(build).toContain('"-Werror=unguarded-availability-new"');
  });

  it('compiles, links and runs the injected native topology/backpressure fake', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-capture-test-'));
    const executable = resolve(directory, 'capture-test');
    try {
      const compile = await runNative('xcrun', [
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
        resolve(ROOT, 'test/spec/macos-remote-desktop-capture-test.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/screen_capture_kit_adapter.mm'),
        // ScreenCaptureKitLimits::IsValid lives here now so the LoginWindow
        // capture supervisor can share the same bounds without ScreenCaptureKit.
        resolve(ROOT, 'native/macos-remote-desktop/screen_capture_kit_limits.cc'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        '-framework', 'CoreGraphics',
        '-framework', 'CoreMedia',
        '-framework', 'CoreVideo',
        '-framework', 'Foundation',
        '-framework', 'ScreenCaptureKit',
        '-o', executable,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

      const run = await runNative(executable, [], { encoding: 'utf8' });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
