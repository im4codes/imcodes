import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

// Source-level pins for the wiring the g++/ASan harnesses cannot reach (they run
// without libwebrtc and without a Mac session): who may turn the raw path on, who
// feeds it, and the colour contract between capture, conversion and the frame tag.
describe('macOS raw (libvpx) video path wiring', () => {
  const worker = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  const session = read('native/macos-remote-desktop/macos_remote_desktop_session.mm');
  const transport = read('native/macos-remote-desktop/pinned_libwebrtc_transport_backend.cc');
  const conversion = read('native/macos-remote-desktop/raw_frame_conversion.cc');
  const cg = read('native/macos-remote-desktop/cg_display_stream_backend.mm');
  const vt = read('native/macos-remote-desktop/video_toolbox_h264_encoder.h');

  it('turns raw codecs on only for a Mac with no hardware H.264 encoder', () => {
    expect(worker).toContain('AllowRawCodecs(!HardwareH264EncoderAvailable())');
    expect(worker).toContain('probe.HardwareEncoderAvailable()');
    // Asked once per process, not per route: it opens a real VideoToolbox session.
    expect(worker).toMatch(/static const bool available = \[\] \{/);
    expect(worker).toContain('configuration.raw_video = media_binder->raw_video();');
    expect(worker).toContain('SetNv12ToBgraConverter(');
  });

  it('keeps the VideoToolbox encoder when the route carries no raw rendezvous', () => {
    expect(session).toContain('raw_enabled_(configuration.raw_video != nullptr)');
    expect(session).toContain('switching_encoder_(encoder_, raw_encoder_, configuration.raw_video)');
    expect(session).toMatch(/return raw_enabled_ \? static_cast<ReconfigurableEncoder&>\(switching_encoder_\)\s*:\s*static_cast<ReconfigurableEncoder&>\(encoder_\)/);
    // Every consumer of the encoder goes through the one view, none around it.
    expect(session).not.toMatch(/\bencoder_\.(ReconfigureFromQualitySelection|Configuration|SetConfigurationObserver)\(/);
    expect(session).toContain('encoder_view().ReconfigureFromQualitySelection(');
    expect(session).toContain('encoder_view().Configuration()');
    expect(session).toContain('.adapters = {capture_, encoder_view(),');
    expect(vt).toContain('class VideoToolboxH264Encoder final : public ReconfigurableEncoder');
  });

  it('delivers raw frames to libwebrtc as I420 tagged with the matrix they were converted with', () => {
    expect(transport).toContain('class ImcodesVideoTrackSource : public webrtc::VideoTrackSourceInterface,');
    expect(transport).toContain('ConvertFrameToI420(frame, planes)');
    expect(transport).toMatch(/webrtc::ColorSpace::PrimaryID::kBT709,[\s\S]*TransferID::kBT709,[\s\S]*MatrixID::kBT709,[\s\S]*RangeID::kLimited/);
    expect(conversion).toContain('&libyuv::kArgbH709Constants');
    expect(conversion).toContain('&libyuv::kYuvH709Constants');
    expect(cg).toContain('kCGDisplayStreamYCbCrMatrix_ITU_R_709_2');
    // No 601 anywhere on this path: a mismatch would shift every colour.
    expect(conversion).not.toMatch(/601|kArgbI601|kYuvI601/);
    expect(cg).not.toContain('ITU_R_601');
  });

  it('stops the black placeholder pump while real frames flow, and clears the sink on close', () => {
    expect(transport).toMatch(/if \(raw_ != nullptr && raw_->raw_active\(\)\) continue;/);
    expect(transport).toContain('media_binder_->raw_video()->SetSink(');
    // Installed once in Open, cleared in both teardown paths (Close and CloseLocked).
    expect(transport.match(/raw_video\(\)->SetSink\(nullptr\)/g)?.length).toBe(2);
  });
});
