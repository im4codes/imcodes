import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS pinned-libwebrtc H.264 sender bridge', () => {
  const header = read('native/macos-remote-desktop/h264_sender_bridge.h');
  const bridge = read('native/macos-remote-desktop/h264_sender_bridge.cc');
  const production = read('native/macos-remote-desktop/pinned_libwebrtc_h264_sender.cc');
  const build = read('native/macos-remote-desktop/BUILD.gn');
  const directory = process.platform === 'darwin'
    ? mkdtempSync(resolve(tmpdir(), 'imcodes-libwebrtc-sender-test-'))
    : null;
  const executable = directory === null ? null : resolve(directory, 'sender-test');

  afterAll(async () => {
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
  });

  it('keeps queueing behind an injectable sender seam with explicit bounds', async () => {
    expect(header).toContain('class H264SenderBackend');
    expect(header).toContain('max_pending_access_units');
    expect(header).toContain('max_pending_bytes');
    expect(header).toContain('max_access_unit_bytes');
    expect(header).toContain('webrtc_owned_copy_bytes');
    expect(bridge).toContain('MakeRoomLocked');
    expect(bridge).toContain('last_started_generation_');
    expect(bridge).toContain('ignored_late_callbacks');
  });

  it('submits through pinned upstream encoded-image APIs and one owned copy', async () => {
    expect(production).toContain('#include "api/video/encoded_image.h"');
    expect(production).toContain('#include "api/video_codecs/video_encoder.h"');
    expect(production).toContain('webrtc::EncodedImageBuffer::Create');
    expect(production).toContain('callback_->OnEncodedImage');
    expect(production).toContain('webrtc::H264PacketizationMode::NonInterleaved');
    expect(production).toContain('SetRtpTimestamp(frame.rtp_timestamp_90khz)');
    expect(production).toContain('webrtc::VideoFrameType::kVideoFrameKey');
    expect(production).toContain('result.drop_next_frame');
    expect(build).toContain('source_set("pinned_libwebrtc_h264_sender_bridge")');
    expect(build).toContain('"//api/video:encoded_image"');
    expect(build).toContain('"//api/video_codecs:video_codecs_api"');
  });

  it('contains no custom packetizer, transport, pacing, congestion, ICE or socket', async () => {
    const productionCode = `${bridge}\n${production}`;
    expect(productionCode).not.toMatch(/RtpPacket|RtcpPacket|Packetizer|PacingController|CongestionController|IceTransport|TurnPort|UdpSocket|TcpSocket/);
    expect(productionCode).not.toMatch(/#include\s*[<"][^>"]*(socket|udp|tcp|ice|pacing|congestion)[^>"]*[>"]/i);
  });

  it('compiles and runs the fake sender counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const compile = await runNative('xcrun', [
      'clang++',
      '-std=c++20',
      '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer',
      '-pthread',
      '-mmacosx-version-min=12.3',
      '-I', resolve(ROOT, 'native/macos-remote-desktop'),
      '-I', resolve(ROOT, 'native/remote-desktop-common'),
      resolve(ROOT, 'test/spec/macos-remote-desktop-libwebrtc-sender-test.cc'),
      resolve(ROOT, 'native/macos-remote-desktop/h264_sender_bridge.cc'),
      resolve(ROOT, 'native/macos-remote-desktop/video_toolbox_h264_encoder.mm'),
      resolve(ROOT, 'native/remote-desktop-common/value_types.cc'),
      '-framework', 'CoreMedia',
      '-framework', 'CoreVideo',
      '-framework', 'Foundation',
      '-framework', 'VideoToolbox',
      '-o', executable!,
    ], { cwd: directory! });
    expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);

    const run = await runNative(executable!, [], { cwd: directory! });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 60_000);

  it('compiles the checkout-independent bridge for both release architectures', async () => {
    if (process.platform !== 'darwin') return;
    for (const architecture of ['arm64', 'x86_64'] as const) {
      const output = resolve(directory!, `${architecture}.o`);
      const compile = await runNative('xcrun', [
        'clang++',
        '-std=c++20',
        '-Wall', '-Wextra', '-Werror',
        '-pthread',
        '-mmacosx-version-min=12.3',
        '-arch', architecture,
        '-I', resolve(ROOT, 'native/macos-remote-desktop'),
        '-I', resolve(ROOT, 'native/remote-desktop-common'),
        '-c', resolve(ROOT, 'native/macos-remote-desktop/h264_sender_bridge.cc'),
        '-o', output,
      ], { cwd: directory! });
      expect(compile.status, `${architecture}\n${compile.stdout}\n${compile.stderr}`).toBe(0);
    }
  }, 60_000);
});
