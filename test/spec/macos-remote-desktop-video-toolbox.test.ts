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

  it('defaults Apple software fallback on and qualified, with one source of truth', async () => {
    // Real-hardware counterexample: on a Mac Pro 6,1 the hardware probe returns
    // -12903 (kVTVideoEncoderNotAvailableNow) while a software-only session
    // creates and encodes fine. Defaulting the fallback off made cold readiness
    // report encoder=false and the runtime profile resolve to `unavailable` on
    // a machine that could encode. Both keys must default ON.
    expect(header).toMatch(/bool allow_apple_software_fallback = true;/);
    expect(header).toMatch(/bool apple_software_fallback_qualified = true;/);
    expect(header).not.toMatch(/bool allow_apple_software_fallback = false;/);
    expect(header).not.toMatch(/bool apple_software_fallback_qualified = false;/);

    // Hardware stays strictly preferred: readiness short-circuits on hardware
    // before it ever consults the software policy.
    expect(implementation).toMatch(
      /if \(backend_->HardwareEncoderAvailable\(\)\) \{\s*\n\s*return common::ReadinessState::kReady;/u,
    );

    // The software path stays PROVEN, not assumed: readiness still requires a
    // real software-only session probe, so the default cannot fabricate
    // readiness on a host where software encoding genuinely fails.
    expect(implementation).toContain('backend_->AppleSoftwareEncoderAvailable()');
    const softwareProbe = read('native/macos-remote-desktop/video_toolbox_h264_encoder.mm')
      .slice(read('native/macos-remote-desktop/video_toolbox_h264_encoder.mm')
        .indexOf('bool AppleSoftwareEncoderAvailable()'));
    expect(softwareProbe.slice(0, 600)).toContain('CreateCompressionSession(');

    // Measured Intel counterexample: a software-only session creates (status 0)
    // but kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder
    // returns kVTPropertyNotSupportedErr (-12900) with no value. Treating that
    // as failure rejected every software session on that host. An absent key
    // means VideoToolbox is not claiming hardware, i.e. using_hardware=false.
    // Hardware stays fail-closed because its caller demands an affirmative true.
    // Anchored to the statement, not the substring: a `false && status == ...`
    // dead-coding mutant contains the substring and would survive a toContain.
    expect(implementation).toMatch(/\n  if \(status == kVTPropertyNotSupportedErr\) \{\n/u);
    expect(implementation).toMatch(/kVTPropertyNotSupportedErr\)\s*\{[\s\S]{0,200}\*using_hardware = false;[\s\S]{0,60}return true;/u);
    expect(implementation).toContain('kind == VideoToolboxEncoderKind::kHardware && !using_hardware');

    // Measured on macOS 12.7.6 Intel: the SOFTWARE encoder rejects
    // ConstrainedBaseline_AutoLevel with kVTParameterErr (-12902) while
    // accepting Baseline/Main/High. The retry is sound only because the emitted
    // bitstream was inspected: encoding a real 640x480 frame at
    // Baseline_AutoLevel produced SPS profile_idc=66, profile_iop=0xe0
    // (constraint_set1=1), level_idc=30 => profile-level-id 42e01e, which IS
    // constrained-baseline and stays compatible with the negotiated 42e01f.
    expect(implementation).toContain('PlainProfileForRejectedConstrained');
    // Three-way gate: software kind AND exact constrained mapping AND the exact
    // measured status. Any other status, or hardware, must fail closed rather
    // than silently land on a different profile.
    expect(implementation).toMatch(
      /\(kind == VideoToolboxEncoderKind::kQualifiedAppleSoftware &&\s*\n\s*profile_status == kVTParameterErr\)\s*\n\s*\? PlainProfileForRejectedConstrained\(profile_level\)\s*\n\s*: nullptr;/u,
    );
    expect(implementation).toContain('const OSStatus profile_status = VTSessionSetProperty(');
    // Constrained -> plain mapping must stay within the same profile family.
    expect(implementation).toMatch(
      /ConstrainedBaseline_AutoLevel\) \{\s*\n\s*return kVTProfileLevel_H264_Baseline_AutoLevel;/u,
    );
    expect(implementation).not.toContain('kVTProfileLevel_H264_ConstrainedHigh_AutoLevel');

    // NO DRIFT: the cold readiness probe and the production session must both
    // take the default, so one policy change moves both. A second literal
    // policy anywhere would let them disagree.
    const workerMain = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
    expect(workerMain).toContain('macos::VideoToolboxH264Encoder encoder;');
    expect(workerMain).not.toMatch(/allow_apple_software_fallback\s*=/u);
    const sessionHeader = read('native/macos-remote-desktop/macos_remote_desktop_session.h');
    expect(sessionHeader).toContain('VideoToolboxEncoderPolicy encoder_policy;');
    expect(sessionHeader).not.toMatch(/allow_apple_software_fallback\s*=/u);
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
