import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS latency-first encoder mode', () => {
  const common = read('native/remote-desktop-common/platform_interfaces.h');
  const encoder = read('native/macos-remote-desktop/video_toolbox_h264_encoder.mm');
  const header = read('native/macos-remote-desktop/video_toolbox_h264_encoder.h');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');
  const cg = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
  const adapterSource = read('native/macos-remote-desktop/screen_capture_kit_adapter.mm');

  it('is off by default and only the output-size-capable (CGDisplayStream) path turns it on', () => {
    expect(common).toMatch(/bool latency_first = false;/);
    // The session enables it from the capture's own capability, nowhere else.
    expect(session).toMatch(/\.latency_first = dependencies_\.adapters\.capture\.SupportsOutputSize\(\)/);
    expect(session.match(/\blatency_first\b/g)?.length).toBe(1); // exactly that one assignment
    // Nothing else in the production worker names the flag.
    expect(read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm')).not.toContain('latency_first');
    expect(read('native/macos-remote-desktop/screen_capture_kit_adapter.mm')).not.toContain('latency_first');
  });

  it('keeps one frame in flight and does not turn drops into backlog pressure in that mode only', () => {
    expect(encoder).toMatch(/configuration\.latency_first \? 1U : limits_\.max_pending_frames/);
    // The latency-first drop returns before backlog pressure is touched and is counted apart from faults.
    expect(encoder).toMatch(/if \(latency_first\) \{[\s\S]{0,260}\+\+statistics\.dropped_by_design_frames;\s*return std::nullopt;\s*\}\s*\+\+statistics\.dropped_backpressure_frames;/);
  });

  it('refreshes a settled picture once, only in latency-first mode, using the shared policy', () => {
    expect(encoder).toContain('#include "../remote-desktop-common/static_refresh_policy.h"');
    expect(encoder).toMatch(/if \(latency_first\) \{\s*const auto now_ms[\s\S]{0,300}refresh\.OnFrame\(frame\.repeated_unchanged, frames_since_key,\s*bitrate_bps, now_ms\);/);
    expect(encoder).toMatch(/const bool force = request_keyframe \|\| force_next_keyframe \|\| refresh_now;/);
    // frames_since_key resets on a keyframe and a session rebuild forgets the run.
    expect(encoder).toMatch(/if \(access_unit\.keyframe\) \{\s*frames_since_key = 0;/);
    expect(encoder).toMatch(/frames_since_key = 0;\s*refresh\.Reset\(\);/);
    // The refresh weighs the CURRENT link target, including bitrate-only updates.
    expect(encoder).toContain('state_->bitrate_bps = next.bitrate_bps;');
    expect(encoder).toContain('state_->bitrate_bps = configuration.bitrate_bps;');
  });

  it('marks a keep-alive re-delivery of the unchanged picture, and no other frame', () => {
    const values = read('native/remote-desktop-common/value_types.h');
    expect(values).toMatch(/bool repeated_unchanged = false;/);
    const repeat = cg.slice(cg.indexOf('void RepeatLastFrame()'), cg.indexOf('void HandleFrame('));
    expect(repeat).toContain('frame.repeated_unchanged = true;');
    expect(cg.match(/repeated_unchanged = true/g)?.length).toBe(1);
    expect(adapterSource).not.toContain('repeated_unchanged');
  });

  it('reports only faults as dropped frames', () => {
    expect(encoder).toMatch(/std::uint64_t VideoToolboxH264Encoder::DroppedFrames\(\) const noexcept \{\s*return impl_->Statistics\(\)\.dropped_backpressure_frames;/);
  });

  it('feeds the governor only from frames of the configured size and only once armed', () => {
    expect(encoder).toContain('frame.encoded_pixels.width == expected_pixels.width');
    expect(encoder).toMatch(/if \(!armed\.load\(std::memory_order_relaxed\)\) return;/);
    expect(encoder).toMatch(/speed_->armed\.store\(false, std::memory_order_relaxed\);/);
    expect(encoder).toMatch(/if \(latency_first\) speed_->armed\.store\(true, std::memory_order_relaxed\);/);
  });

  it('serialises rebuilds: the ladder thread and the capture thread can both ask for one', () => {
    expect(encoder.match(/std::lock_guard<std::recursive_mutex> rebuild\(rebuild_mutex_\);/g)?.length).toBe(2);
    expect(encoder).toContain('std::recursive_mutex rebuild_mutex_;');
  });

  it('never keeps a pointer to the caller\'s preset-id string', () => {
    expect(encoder).toContain('requested_selection_->id = "requested";');
  });

  it('applies a governor step on the capture thread, outside every lock, and tells the observer', () => {
    expect(encoder).toMatch(/if \(latency_first_\.load\(std::memory_order_relaxed\)\) \{\s*ApplyGovernorIfChanged\(\);/);
    expect(encoder).toMatch(/observer = observer_;\s*\}\s*if \(observer\) observer\(\);/);
    expect(header).toContain('void SetConfigurationObserver(std::function<void()> observer);');
    expect(session).toContain('encoder_.SetConfigurationObserver([this] { RetargetCaptureToEncoder(); });');
  });

  it('gives up resolution last: the governor thresholds favour latency, then sharpness', () => {
    const governor = read('native/remote-desktop-common/encode_speed_governor.h');
    expect(governor).toMatch(/kEncodeStepDownMs = 130\.0;/);
    expect(governor).toMatch(/kEncodeStepUpMs = 90\.0;/);
    expect(governor).toMatch(/kEncodeStepUpHoldMs = 20'000;/);
  });

  it('compiles, links and runs the injected-backend latency-first harness under ASan/UBSan (darwin only)', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-latency-first-test-'));
    const executable = resolve(directory, 'latency-first-test');
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
        '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE',
        '-mmacosx-version-min=12.3',
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-latency-first-encoder-test.mm'),
        resolve(ROOT, 'native/macos-remote-desktop/video_toolbox_h264_encoder.mm'),
        resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
        resolve(ROOT, 'native/remote-desktop-common/quality_ladder.cc'),
        '-framework', 'CoreMedia',
        '-framework', 'CoreVideo',
        '-framework', 'Foundation',
        '-framework', 'VideoToolbox',
        '-o', executable,
      ], { cwd: directory });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(executable, [], { cwd: directory });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos latency-first encoder counterfactuals passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
