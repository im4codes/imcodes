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
        // The kill switch is read for every route (so the next session sees an edit) and decides first.
    expect(worker).toContain('ResolveRawCodecSettings(\n          ProcessEnvironmentLookup, ReadSmallRegularFile)');
    expect(worker).toMatch(/HardwareH264EncoderAvailable\(\), capture_backend->SupportsOutputSize\(\),\s*raw_settings\.raw_codecs\)/);
    expect(worker).toContain('S_ISREG(info.st_mode)');
    expect(worker).toContain('info.st_size > kMaxBytes');
    expect(worker).toContain('AllowRawCodecs(raw_decision.allowed)');
    expect(worker).toContain('PreferNv12Capture(raw_settings.nv12_capture)');
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

    it('tells libvpx the capped core count, which is what sizes its thread pool', () => {
      const init = tap.slice(tap.indexOf('int InitEncode('), tap.indexOf('int32_t RegisterEncodeCompleteCallback'));
      expect(init).toContain('capped.number_of_cores = RawEncoderCoreBudget(settings.number_of_cores);');
      expect(init).toContain('inner_->InitEncode(codec_settings, capped)');
      expect(init).not.toContain('inner_->InitEncode(codec_settings, settings)');
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

  describe('encoder visibility (worker log, encoder message)', () => {
    const body = (name: string) => worker.slice(worker.indexOf(`bool WorkerTransportSink::${name}(`), worker.indexOf('\nbool WorkerTransportSink::', worker.indexOf(`bool WorkerTransportSink::${name}(`) + 10));

    it('sends the encoder facts as a message of their own and leaves the quality message alone', () => {
      const quality = body('SendQuality');
      expect(quality).not.toMatch(/root\["(codec|encoderName|implementation|threads|rawCodecs)"\]/);
      expect(quality).toContain('root["encoderClass"]');
      const encoder = body('SendEncoderInfo');
      expect(encoder).toContain('root["type"] = imcodes::rd::kEncoderInfoType;');
      for (const key of ['codec', 'implementation', 'name', 'threads', 'rawCodecs']) {
        expect(encoder).toContain(`root["${key}"] = `);
      }
      // Nothing before a codec exists; and unchanged facts are not resent.
      expect(encoder).toContain('description.codec == imcodes::rd::kEncoderCodecPending');
      expect(encoder).toContain('*last_sent_encoder_ == description');
      // Marked as sent only when the channel really took it, so a closed channel is retried.
      expect(encoder).toMatch(/const bool sent = SendControl\(std::move\(root\)\);\s*if \(sent\)\s*last_sent_encoder_ = description;/);
    });

    it('tells the viewer when the channel opens and again once the encoder is up', () => {
      const open = worker.slice(worker.indexOf('void WorkerTransportSink::HandleDataChannelState('), worker.indexOf('void WorkerTransportSink::OnQualityTarget('));
      expect(open).toMatch(/\(void\)SendQuality\(\);\s*\(void\)SendEncoderInfo\(\);/);
      const drain = worker.slice(worker.indexOf('void WorkerTransportSink::DrainQualityTarget()'), worker.indexOf('void WorkerTransportSink::HandleDataChannelMessage('));
      expect(drain).toMatch(/\(void\)SendQuality\(\);[\s\S]*\(void\)SendEncoderInfo\(\);/);
    });

    it('logs the decision and each change to a file the node can read, not to stderr', () => {
      expect(worker).toContain('std::getenv(macos::kEnvRuntimeDirectory)');
      expect(worker).toContain('macos::WorkerVideoLogPath(');
      expect(worker).toContain('"decision"');
      const encoder = body('SendEncoderInfo');
      expect(encoder).toContain('video_log_->Append(macos::FormatEncoderLogLine(');
      expect(encoder).toContain('"encoder_changed" : "encoder"');
      // The route hands the sink what it needs to describe the real encoder.
      expect(worker).toContain('route->sink->BindVideo(route->media_binder->raw_video(), video_log);');
      expect(worker).toContain('SetPolicyState(policy_state)');
    });

    it('records what libvpx actually came up as, and forgets it on release', () => {
      expect(transport).toContain('raw_->SetEncoderFacts(std::move(facts));');
      expect(transport).toContain('facts.implementation = inner_->GetEncoderInfo().implementation_name;');
      expect(transport).toContain('facts.cores = capped.number_of_cores;');
      expect(transport).toMatch(/int32_t Release\(\) override \{\s*if \(raw_ != nullptr\) raw_->ClearEncoderFacts\(\);/);
    });

    it('draws the real encoder in the status bar, keeping the class-only text for older nodes', () => {
      const panel = read('web/src/components/RemoteDesktopPanel.tsx');
      expect(panel).toContain('describeRemoteDesktopEncoder(snapshot.encoder, t)');
      expect(panel).toContain("t('remote_desktop.encoder', { encoder: snapshot.quality.encoderClass })");
      expect(panel).toContain('data-encoder-codec={actual.codec}');
    });
  });
});
