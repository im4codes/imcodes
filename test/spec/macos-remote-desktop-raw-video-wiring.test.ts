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
    expect(worker).toContain('DecideRawCodecs(');
    expect(worker).toContain('HardwareH264EncoderAvailable(), capture_backend->SupportsOutputSize()');
    expect(worker).toContain('AllowRawCodecs(raw_decision.allowed)');
    // Decided after the capture backend exists (and refused when it does not), never before.
    expect(worker.indexOf('DecideRawCodecs(')).toBeGreaterThan(worker.indexOf('macos_remote_desktop_worker_capture_backend_unavailable'));
    expect(worker).toContain('macos_remote_desktop_worker_raw_codecs allowed=');
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

  describe('libwebrtc side (VP9/VP8 offer, answer order, rate and byte taps)', () => {
    const factory = transport.slice(
      transport.indexOf('class PassthroughH264EncoderFactory'),
      transport.indexOf('// One negotiation attempt, shared by the three upstream observers.'),
    );
    const tap = transport.slice(
      transport.indexOf('class RawCodecEncoder final'),
      transport.indexOf('class PassthroughH264EncoderFactory'),
    );

    it('offers VP9/VP8 only on a Mac that may send them; every other Mac still offers exactly H.264', () => {
      expect(factory).toMatch(/if \(!raw_codecs_allowed\(\)\) return \{h264\};/);
      expect(factory).toContain('return {webrtc::SdpVideoFormat::VP9Profile0(), webrtc::SdpVideoFormat::VP8(),\n            h264};');
      expect(factory).toContain('binder_->raw_video()->raw_codecs_allowed()');
      // The libvpx encoders are only created inside the allowed branch; the default is the passthrough.
      const create = factory.slice(factory.indexOf('Create('));
      expect(create.indexOf('if (raw_codecs_allowed())')).toBeLessThan(create.indexOf('CreateVp9Encoder'));
      expect(create.indexOf('CreateVp8Encoder')).toBeLessThan(create.lastIndexOf('std::make_unique<PassthroughH264Encoder>'));
    });

    it('reports the network target to the session after upstream applied it, and counts encoded bytes', () => {
      const setRates = tap.slice(tap.indexOf('void SetRates('), tap.indexOf('void OnPacketLossRateUpdate'));
      expect(setRates.indexOf('inner_->SetRates(parameters)')).toBeGreaterThanOrEqual(0);
      expect(setRates.indexOf('inner_->SetRates(parameters)')).toBeLessThan(setRates.indexOf('adapter_->ReportQualityTarget('));
      expect(setRates).toContain('parameters.bitrate.get_sum_bps()');
      expect(tap).toContain('raw->AddAcceptedBytes(encoded_image.size())');
      // Every other call is forwarded untouched, so libwebrtc keeps owning the encode.
      for (const call of ['inner_->Encode(frame, frame_types)', 'inner_->Release()', 'inner_->OnRttUpdate(rtt_ms)',
        'inner_->OnPacketLossRateUpdate(packet_loss_rate)', 'inner_->GetEncoderInfo()', 'downstream->OnFrameDropped(']) {
        expect(tap).toContain(call);
      }
    });

    it('sets the answer order only for a raw-capable Mac, and records the codec before the stream can start', () => {
      expect(transport).toMatch(/if \(raw->raw_codecs_allowed\(\) && factory_ != nullptr\) \{\s*state->prepare_answer =/);
      expect(transport).toContain('raw->SetNegotiatedCodec(ParseAnsweredVideoCodec(answer))');
      const remote = transport.slice(transport.indexOf('class SetRemoteObserver'));
      expect(remote.indexOf('prepare_answer(*peer)')).toBeLessThan(remote.indexOf('peer->CreateAnswer('));
      const answer = transport.slice(transport.indexOf('class CreateAnswerObserver'), transport.indexOf('class SetRemoteObserver'));
      expect(answer.indexOf('on_answer(serialized)')).toBeGreaterThanOrEqual(0);
      expect(answer.indexOf('on_answer(serialized)')).toBeLessThan(answer.indexOf('peer->SetLocalDescription('));
    });

    it('answers VP9, VP8, H.264 then the utility codecs, and survives a refused preference', () => {
      const helper = transport.slice(transport.indexOf('void ApplyRawCodecAnswerOrder'), transport.indexOf('// Upper bound on one negotiation.'));
      expect(helper).toContain('GetRtpSenderCapabilities(webrtc::MediaType::VIDEO)');
      expect(helper).toContain('SortByAnswerPreference(');
      expect(helper).toContain('transceiver->SetCodecPreferences(codecs).ok()');
      // A refusal is logged and negotiation continues in the offer's order (H.264 first).
      expect(helper).toContain('macos_remote_desktop_transport_codec_preferences_refused');
      expect(helper).not.toMatch(/return false|Fail\(/);
    });
  });
});
