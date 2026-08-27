import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

async function compileObject(architecture: 'arm64' | 'x86_64', output: string) {
  return await runNative('xcrun', [
    'clang++',
    '-std=c++20',
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
    '-c', resolve(ROOT, 'native/macos-remote-desktop/video_toolbox_h264_encoder.mm'),
    '-o', output,
  ], { cwd: dirname(output) });
}

describe('macOS VideoToolbox H.264 encoder adapter', () => {
  const header = read('native/macos-remote-desktop/video_toolbox_h264_encoder.h');
  const implementation = read('native/macos-remote-desktop/video_toolbox_h264_encoder.mm');
  const harnessDirectory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-video-toolbox-test-'))
    : null;
  const harnessExecutable = harnessDirectory === null
    ? null
    : resolve(harnessDirectory, 'video-toolbox-test');

  afterAll(async () => {
    if (harnessDirectory !== null) {
      rmSync(harnessDirectory, { recursive: true, force: true });
    }
  });

  it('keeps Apple types behind an injectable common EncoderAdapter boundary', async () => {
    expect(header).toContain('public common::EncoderAdapter');
    expect(header).toContain('class VideoToolboxEncoderBackend');
    expect(header).toContain('class Impl;');
    expect(header).not.toMatch(/#import|CVPixelBuffer|CMSampleBuffer|VTCompressionSession/);
    expect(implementation).toContain('#import <VideoToolbox/VideoToolbox.h>');
  });

  it('uses low-latency hardware-first VideoToolbox with a two-key qualified fallback', async () => {
    expect(implementation).toContain('kVTCompressionPropertyKey_RealTime');
    expect(implementation).toContain('kVTCompressionPropertyKey_AllowFrameReordering');
    expect(implementation).toContain('kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder');
    expect(implementation).toContain('kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder');
    expect(header).toContain('allow_apple_software_fallback');
    expect(header).toContain('apple_software_fallback_qualified');
    expect(implementation).toContain('VideoToolboxEncoderKind::kQualifiedAppleSoftware');
  });

  it('honors explicit BGRA row stride with bounded copies and Annex-B access units', async () => {
    expect(implementation).toContain('frame.pixel_format != common::PixelFormat::kBgra8888');
    expect(implementation).toContain('frame.row_bytes');
    expect(implementation).toContain('CopyBgraFrameRows(');
    expect(implementation).not.toMatch(/storage->size\(\)\s*\/\s*frame\.encoded_pixels\.height/);
    expect(implementation).toContain('CMVideoFormatDescriptionGetH264ParameterSetAtIndex');
    expect(implementation).toContain('kAnnexBStartCode');
    expect(implementation).toContain('max_access_unit_bytes');
    expect(implementation).toContain('max_pending_frames');
  });

  it('forces keyframes and consumes only the existing common quality selection', async () => {
    expect(implementation).toContain('kVTEncodeFrameOptionKey_ForceKeyFrame');
    expect(header).toContain('ReconfigureFromQualitySelection');
    expect(header).toContain('const imcodes::rd::QualitySelection& selection');
    expect(implementation).toContain('force_next_keyframe = true');
  });

  it('contains no custom WebRTC transport, RTP, RTCP, pacing or congestion controller', async () => {
    expect(implementation).not.toMatch(/RtpPacket|RtcpPacket|RTCPeerConnection|PacingController|CongestionController|IceTransport|UdpSocket|TcpSocket/);
  });

  it('compiles and links the injected native adapter harness under sanitizers', async () => {
    if (process.platform !== 'darwin') return;
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
      resolve(ROOT, 'test/spec/macos-remote-desktop-video-toolbox-test.mm'),
      resolve(ROOT, 'native/macos-remote-desktop/video_toolbox_h264_encoder.mm'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      '-framework', 'CoreMedia',
      '-framework', 'CoreVideo',
      '-framework', 'Foundation',
      '-framework', 'VideoToolbox',
      '-o', harnessExecutable!,
    ], { cwd: harnessDirectory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
  }, 60_000);

  it('runs the injected native adapter harness under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const run = await runNative(harnessExecutable!, [], {
      cwd: harnessDirectory!,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 60_000);

  it('compiles the production Objective-C++ adapter for both release architectures', async () => {
    if (process.platform !== 'darwin') return;

    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-video-toolbox-arch-'));
    try {
      for (const architecture of ['arm64', 'x86_64'] as const) {
        const compile = await compileObject(architecture, resolve(directory, `${architecture}.o`));
        expect(compile.status, `${architecture}\n${compile.stdout}\n${compile.stderr}`).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
