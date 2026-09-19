#include "pinned_libwebrtc_transport_backend.h"

#include <algorithm>
#include <atomic>
#include <thread>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "../remote-desktop-common/data_channel_constants.h"
#include "../remote-desktop-common/quality_ladder.h"
#include "../remote-desktop-common/video_sender_bitrate.h"
#include "api/audio/audio_device.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_modular_peer_connection_factory.h"
#include "api/enable_media.h"
#include "api/data_channel_interface.h"
#include "api/environment/environment.h"
#include "api/jsep.h"
#include "api/make_ref_counted.h"
#include "api/media_stream_interface.h"
#include "api/peer_connection_interface.h"
#include "api/rtc_error.h"
#include "api/scoped_refptr.h"
#include "api/set_local_description_observer_interface.h"
#include "api/set_remote_description_observer_interface.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "rtc_base/time_utils.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_decoder.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "macos_media_sender_binder.h"
#include "modules/audio_device/include/audio_device_default.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "pinned_libwebrtc_h264_sender.h"
#include "rtc_base/ref_counted_object.h"
#include "rtc_base/thread.h"

namespace imcodes::remote_desktop::macos {
namespace {

common::PeerConnectionState TranslatePeerState(
    webrtc::PeerConnectionInterface::PeerConnectionState state) {
  switch (state) {
    case webrtc::PeerConnectionInterface::PeerConnectionState::kNew:
      return common::PeerConnectionState::kNew;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnecting:
      return common::PeerConnectionState::kConnecting;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kConnected:
      return common::PeerConnectionState::kConnected;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kDisconnected:
      return common::PeerConnectionState::kDisconnected;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kFailed:
      return common::PeerConnectionState::kFailed;
    case webrtc::PeerConnectionInterface::PeerConnectionState::kClosed:
      return common::PeerConnectionState::kClosed;
  }
  // Unknown upstream state must not be read as progress.
  return common::PeerConnectionState::kFailed;
}

common::DataChannelState TranslateChannelState(
    webrtc::DataChannelInterface::DataState state) {
  switch (state) {
    case webrtc::DataChannelInterface::kConnecting:
      return common::DataChannelState::kConnecting;
    case webrtc::DataChannelInterface::kOpen:
      return common::DataChannelState::kOpen;
    case webrtc::DataChannelInterface::kClosing:
    case webrtc::DataChannelInterface::kClosed:
      return common::DataChannelState::kClosed;
  }
  return common::DataChannelState::kFailed;
}

std::optional<common::DataChannelKind> ChannelKindForLabel(
    std::string_view label) {
  for (const common::DataChannelKind kind : kRequiredDataChannels) {
    if (label == DataChannelLabel(kind))
      return kind;
  }
  return std::nullopt;
}

// Per-channel observer. Holds only the channel kind and a borrowed adapter; a
// closed adapter drops the callback via its own stamp check.
class ChannelObserver final : public webrtc::DataChannelObserver {
 public:
  ChannelObserver(MacosTransportSessionAdapter* adapter,
                  common::DataChannelKind kind,
                  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel)
      : adapter_(adapter), kind_(kind), channel_(std::move(channel)) {}

  void OnStateChange() override {
    if (adapter_ == nullptr || channel_ == nullptr)
      return;
    adapter_->ReportDataChannelState(adapter_->stamp(), kind_,
                                     TranslateChannelState(channel_->state()));
  }
  void OnMessage(const webrtc::DataBuffer& buffer) override {
    if (adapter_ == nullptr || buffer.binary || buffer.size() == 0 ||
        buffer.size() > imcodes::rd::kMaxDataMessageBytes) {
      return;
    }
    adapter_->ReportDataChannelMessage(
        adapter_->stamp(), kind_,
        std::string(reinterpret_cast<const char*>(buffer.data.data()),
                    buffer.data.size()));
  }

 private:
  MacosTransportSessionAdapter* adapter_;
  common::DataChannelKind kind_;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel_;
};

// Passthrough H.264 encoder.
//
// VideoToolbox has already produced Annex-B access units, so this encoder never
// compresses anything. Its whole purpose is to be the object upstream calls
// InitEncode on, because that call is the only legitimate source of an
// EncodedImageCallback. Once it has one it builds the pinned sender and binds
// it into the session's MacosMediaSenderBinder; from then on every access unit
// travels upstream's encoded-image path, which owns packetization, RTCP, PLI
// and pacing. Nothing here implements RTP.
// Upstream requires a source object to build a track, but this project never
// hands it a raw frame: capture output goes to VideoToolbox and reaches the
// wire already encoded. The source therefore stays live and silent — it exists
// so a track (and hence an encoder) can be created at all.
class ImcodesVideoTrackSource : public webrtc::VideoTrackSourceInterface {
 public:
  // libwebrtc creates, initialises and keeps calling a video encoder only while
  // its send stream receives frames. A silent source meant the passthrough
  // encoder was never instantiated, its sender never bound, and every access
  // unit VideoToolbox produced was dropped before the wire: the peer connected,
  // the data channels opened, and not one video byte was sent.
  //
  // So this source delivers placeholder frames -- one reused black buffer at
  // the session's encode size, a few times a second. The encoder ignores their
  // pixels; they only drive encoder setup and the Encode cadence, while the
  // real H.264 arrives through the binder.
  explicit ImcodesVideoTrackSource(MacosMediaSenderBinder* binder)
      : binder_(binder), pump_([this] { Pump(); }) {}

  ~ImcodesVideoTrackSource() override {
    stop_.store(true);
    if (pump_.joinable()) pump_.join();
  }

  void AddOrUpdateSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
                       const webrtc::VideoSinkWants& wants) override {
    (void)wants;
    if (sink == nullptr) return;
    std::lock_guard lock(sinks_mutex_);
    if (std::find(sinks_.begin(), sinks_.end(), sink) == sinks_.end())
      sinks_.push_back(sink);
  }
  void RemoveSink(
      webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) override {
    std::lock_guard lock(sinks_mutex_);
    sinks_.erase(std::remove(sinks_.begin(), sinks_.end(), sink), sinks_.end());
  }
  SourceState state() const override { return kLive; }
  bool remote() const override { return false; }
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }
  bool GetStats(Stats* stats) override {
    (void)stats;
    return false;
  }
  void RegisterObserver(webrtc::ObserverInterface* observer) override {
    (void)observer;
  }
  void UnregisterObserver(webrtc::ObserverInterface* observer) override {
    (void)observer;
  }
  bool SupportsEncodedOutput() const override { return false; }
  void GenerateKeyFrame() override {}
  void AddEncodedSink(
      webrtc::VideoSinkInterface<webrtc::RecordableEncodedFrame>* sink)
      override {
    (void)sink;
  }
  void RemoveEncodedSink(
      webrtc::VideoSinkInterface<webrtc::RecordableEncodedFrame>* sink)
      override {
    (void)sink;
  }

 private:
  static constexpr std::chrono::milliseconds kPlaceholderInterval{66};

  void Pump() {
    webrtc::scoped_refptr<webrtc::I420Buffer> buffer;
    common::PixelSize buffer_size{};
    while (!stop_.load()) {
      std::this_thread::sleep_for(kPlaceholderInterval);
      if (stop_.load()) break;
      common::PixelSize size =
          binder_ != nullptr ? binder_->configured_pixels() : common::PixelSize{};
      // Before the session configures an encode size there is nothing real to
      // match; a small even-sized frame still lets the encoder come up.
      if (!size.IsValid()) size = common::PixelSize{640, 360};
      // Even dimensions: I420 chroma subsampling.
      size.width &= ~1U;
      size.height &= ~1U;
      if (buffer == nullptr || size.width != buffer_size.width ||
          size.height != buffer_size.height) {
        buffer = webrtc::I420Buffer::Create(static_cast<int>(size.width),
                                            static_cast<int>(size.height));
        if (buffer == nullptr) continue;
        webrtc::I420Buffer::SetBlack(buffer.get());
        buffer_size = size;
      }
      const webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                           .set_video_frame_buffer(buffer)
                                           .set_timestamp_us(webrtc::TimeMicros())
                                           .build();
      std::lock_guard lock(sinks_mutex_);
      for (auto* sink : sinks_) sink->OnFrame(frame);
    }
  }

  MacosMediaSenderBinder* binder_;
  std::atomic<bool> stop_{false};
  std::mutex sinks_mutex_;
  std::vector<webrtc::VideoSinkInterface<webrtc::VideoFrame>*> sinks_;
  // Declared last: the thread must start after every member it reads exists.
  std::thread pump_;
};

class PassthroughH264Encoder final : public webrtc::VideoEncoder {
 public:
  PassthroughH264Encoder(MacosMediaSenderBinder* binder,
                         MacosTransportSessionAdapter* adapter)
      : binder_(binder), adapter_(adapter) {}

  ~PassthroughH264Encoder() override {
    // Token-scoped: libwebrtc may build the replacement encoder before
    // destroying this one, and detaching the successor here would silently end
    // media for the session.
    if (binder_ != nullptr)
      binder_->Unbind(binding_);
  }

  int32_t InitEncode(const webrtc::VideoCodec* codec_settings,
                     const webrtc::VideoEncoder::Settings& settings) override {
    (void)settings;
    if (codec_settings == nullptr || codec_settings->width <= 0 ||
        codec_settings->height <= 0) {
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    source_width_ = codec_settings->width;
    source_height_ = codec_settings->height;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterEncodeCompleteCallback(
      webrtc::EncodedImageCallback* callback) override {
    if (binder_ == nullptr)
      return WEBRTC_VIDEO_CODEC_ERROR;
    if (callback == nullptr) {
      // Upstream is detaching THIS encoder. Unbind so a later Submit cannot
      // reach a dead callback -- but only if this encoder still owns the
      // binding.
      binder_->Unbind(binding_);
      binding_ = kInvalidMediaSenderBinding;
      return WEBRTC_VIDEO_CODEC_OK;
    }
    auto sender = CreatePinnedLibwebrtcH264Sender(callback);
    if (sender == nullptr)
      return WEBRTC_VIDEO_CODEC_ERROR;
    const MediaSenderBindingId binding = binder_->Bind(std::move(sender));
    if (binding == kInvalidMediaSenderBinding)
      return WEBRTC_VIDEO_CODEC_ERROR;
    binding_ = binding;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Release() override {
    if (binder_ != nullptr)
      binder_->Unbind(binding_);
    binding_ = kInvalidMediaSenderBinding;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  // No raw frame ever reaches this encoder: the capture path feeds the session,
  // which submits already-encoded access units through the binder. A raw frame
  // arriving here would mean a second, unintended media path exists.
  int32_t Encode(
      const webrtc::VideoFrame& frame,
      const std::vector<webrtc::VideoFrameType>* frame_types) override {
    (void)frame;
    (void)frame_types;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  void SetRates(const RateControlParameters& parameters) override {
    if (adapter_ == nullptr || source_width_ <= 0 || source_height_ <= 0)
      return;
    const std::uint32_t target_bps = parameters.bitrate.get_sum_bps();
    if (target_bps == 0 || target_bps == last_target_bps_)
      return;
    last_target_bps_ = target_bps;
    adapter_->ReportQualityTarget(
        adapter_->stamp(),
        common::QualityTarget{
            target_bps,
            common::PixelSize{static_cast<std::uint32_t>(source_width_),
                              static_cast<std::uint32_t>(source_height_)}});
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = "imcodes-videotoolbox-passthrough";
    info.is_hardware_accelerated = true;
    info.supports_native_handle = false;
    return info;
  }

 private:
  MacosMediaSenderBinder* binder_;
  // This encoder's own binding, so its teardown can never detach another's.
  MediaSenderBindingId binding_ = kInvalidMediaSenderBinding;
  MacosTransportSessionAdapter* adapter_;
  int source_width_ = 0;
  int source_height_ = 0;
  std::uint32_t last_target_bps_ = 0;
};

// The Mac only sends video; it never decodes any. The media engine still needs
// a decoder factory, and the builtin one is not part of this SDK.
class NoVideoDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return {};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(
      const webrtc::Environment& /*env*/,
      const webrtc::SdpVideoFormat& /*format*/) override {
    return nullptr;
  }
};

// Remote desktop carries no audio. Without an explicit module the media engine
// builds the Core Audio device, which opens the microphone stack -- on macOS a
// microphone permission prompt for a product that never records.
class SilentAudioDeviceModule
    : public webrtc::webrtc_impl::AudioDeviceModuleDefault<
          webrtc::AudioDeviceModule> {};

class PassthroughH264EncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  PassthroughH264EncoderFactory(MacosMediaSenderBinder* binder,
                                MacosTransportSessionAdapter* adapter)
      : binder_(binder), adapter_(adapter) {}

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    // One format only. Advertising more would let SDP negotiate a codec this
    // project cannot actually produce.
    webrtc::SdpVideoFormat format("H264");
    format.parameters["level-asymmetry-allowed"] = "1";
    format.parameters["packetization-mode"] = "1";
    format.parameters["profile-level-id"] = "42e01f";
    return {format};
  }

  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env,
      const webrtc::SdpVideoFormat& format) override {
    (void)env;
    (void)format;
    return std::make_unique<PassthroughH264Encoder>(binder_, adapter_);
  }

 private:
  MacosMediaSenderBinder* binder_;
  MacosTransportSessionAdapter* adapter_;
};

// One negotiation attempt, shared by the three upstream observers.
//
// Held by shared_ptr because upstream may invoke an observer after the waiting
// caller has already timed out or been cancelled; the state must outlive the
// wait rather than be freed under a live callback.
struct NegotiationState {
  std::mutex mutex;
  std::condition_variable done;
  bool finished = false;
  bool succeeded = false;
  bool cancelled = false;
  std::string answer_sdp;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer;

  void Fail() {
    {
      std::lock_guard lock(mutex);
      if (finished)
        return;
      finished = true;
      succeeded = false;
    }
    done.notify_all();
  }

  void Succeed(std::string sdp) {
    {
      std::lock_guard lock(mutex);
      if (finished)
        return;
      finished = true;
      succeeded = true;
      answer_sdp = std::move(sdp);
    }
    done.notify_all();
  }

  void Cancel() {
    {
      std::lock_guard lock(mutex);
      cancelled = true;
      finished = true;
      succeeded = false;
    }
    done.notify_all();
  }
};

// Not `final`: upstream wraps these with make_ref_counted, which derives from
// the observer type.
class SetLocalObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  SetLocalObserver(std::shared_ptr<NegotiationState> state, std::string answer)
      : state_(std::move(state)), answer_(std::move(answer)) {}

  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    if (state_ == nullptr)
      return;
    if (!error.ok()) {
      state_->Fail();
      return;
    }
    state_->Succeed(std::move(answer_));
  }

 private:
  std::shared_ptr<NegotiationState> state_;
  std::string answer_;
};

class CreateAnswerObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateAnswerObserver(std::shared_ptr<NegotiationState> state)
      : state_(std::move(state)) {}

  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    // Ownership of `desc` transfers here.
    std::unique_ptr<webrtc::SessionDescriptionInterface> answer(desc);
    if (state_ == nullptr || answer == nullptr) {
      if (state_ != nullptr)
        state_->Fail();
      return;
    }
    std::string serialized;
    if (!answer->ToString(&serialized) || serialized.empty()) {
      state_->Fail();
      return;
    }
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer;
    {
      std::lock_guard lock(state_->mutex);
      if (state_->finished)
        return;
      peer = state_->peer;
    }
    if (peer == nullptr) {
      state_->Fail();
      return;
    }
    peer->SetLocalDescription(std::move(answer),
                              webrtc::make_ref_counted<SetLocalObserver>(
                                  state_, std::move(serialized)));
  }

  void OnFailure(webrtc::RTCError /*error*/) override {
    if (state_ != nullptr)
      state_->Fail();
  }

 private:
  std::shared_ptr<NegotiationState> state_;
};

class SetRemoteObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit SetRemoteObserver(std::shared_ptr<NegotiationState> state)
      : state_(std::move(state)) {}

  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    if (state_ == nullptr)
      return;
    if (!error.ok()) {
      state_->Fail();
      return;
    }
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer;
    {
      std::lock_guard lock(state_->mutex);
      if (state_->finished)
        return;
      peer = state_->peer;
    }
    if (peer == nullptr) {
      state_->Fail();
      return;
    }
    peer->CreateAnswer(
        webrtc::make_ref_counted<CreateAnswerObserver>(state_).release(),
        webrtc::PeerConnectionInterface::RTCOfferAnswerOptions());
  }

 private:
  std::shared_ptr<NegotiationState> state_;
};

// Upper bound on one negotiation. Long enough for a real DTLS/ICE-capable
// peer on a slow link, short enough that a peer which never answers cannot
// hold the single-threaded worker dispatch indefinitely.
inline constexpr int kNegotiationTimeoutMs = 10'000;

class PinnedLibwebrtcTransportBackend final
    : public MacosPeerConnectionBackend,
      public webrtc::PeerConnectionObserver {
 public:
  PinnedLibwebrtcTransportBackend() = default;

  ~PinnedLibwebrtcTransportBackend() override { Close(); }

  void BindAdapter(MacosTransportSessionAdapter* adapter) noexcept override {
    std::lock_guard lock(mutex_);
    adapter_ = adapter;
  }

  void BindMediaSender(MacosMediaSenderBinder* binder) noexcept override {
    std::lock_guard lock(mutex_);
    media_binder_ = binder;
  }

  bool Open(const MacosTransportBackendConfiguration& configuration) override {
    std::lock_guard lock(mutex_);
    if (adapter_ == nullptr || peer_ != nullptr)
      return false;

    signaling_thread_ = webrtc::Thread::Create();
    if (signaling_thread_ == nullptr || !signaling_thread_->Start()) {
      return false;
    }
    // A media sender must exist before the factory is built: the factory owns
    // the encoder factory, and the encoder is what produces the callback the
    // binder needs. Without it there is no media path at all, which is a
    // failure rather than a view-only degrade.
    if (media_binder_ == nullptr) {
      signaling_thread_.reset();
      return false;
    }

    webrtc::PeerConnectionFactoryDependencies factory_dependencies;
    factory_dependencies.signaling_thread = signaling_thread_.get();
    // Exactly one encoder factory, advertising exactly one H.264 format. This
    // is the single upstream media path; there is no second packetizer.
    factory_dependencies.video_encoder_factory =
        std::make_unique<PassthroughH264EncoderFactory>(media_binder_,
                                                        adapter_);
    // WITH a media engine. Without EnableMedia the factory is signaling and
    // data only, and libwebrtc refuses any offer carrying a video section:
    // "Not configured for media (UNSUPPORTED_OPERATION)". Every macOS session
    // failed at its first OFFER. The Windows worker has always enabled it.
    factory_dependencies.video_decoder_factory =
        std::make_unique<NoVideoDecoderFactory>();
    factory_dependencies.adm =
        webrtc::make_ref_counted<SilentAudioDeviceModule>();
    factory_dependencies.audio_encoder_factory =
        webrtc::CreateBuiltinAudioEncoderFactory();
    factory_dependencies.audio_decoder_factory =
        webrtc::CreateBuiltinAudioDecoderFactory();
    webrtc::EnableMedia(factory_dependencies);
    factory_ = webrtc::CreateModularPeerConnectionFactory(
        std::move(factory_dependencies));
    if (factory_ == nullptr) {
      signaling_thread_.reset();
      return false;
    }

    webrtc::PeerConnectionInterface::RTCConfiguration rtc_configuration;
    rtc_configuration.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    for (const auto& server : configuration.ice_servers) {
      webrtc::PeerConnectionInterface::IceServer ice_server;
      ice_server.urls.push_back(server.uri);
      ice_server.username = server.username;
      ice_server.password = server.credential;
      rtc_configuration.servers.push_back(std::move(ice_server));
    }

    webrtc::PeerConnectionDependencies peer_dependencies(this);
    auto created = factory_->CreatePeerConnectionOrError(
        rtc_configuration, std::move(peer_dependencies));
    if (!created.ok()) {
      factory_ = nullptr;
      signaling_thread_.reset();
      return false;
    }
    peer_ = created.MoveValue();

    // The track is what makes upstream instantiate an encoder and therefore
    // produce the EncodedImageCallback. Without AddTrack the passthrough
    // encoder is never created and the binder never binds.
    auto source = webrtc::make_ref_counted<ImcodesVideoTrackSource>(media_binder_);
    video_track_ = factory_->CreateVideoTrack(source, "imcodes-screen");
    if (video_track_ == nullptr) {
      CloseLocked();
      return false;
    }
    auto added = peer_->AddTrack(video_track_, {"imcodes-remote-desktop"});
    if (!added.ok()) {
      CloseLocked();
      return false;
    }
    // State the stream's bounds before negotiation, as Windows does: left
    // unset, libwebrtc holds the whole stream to 2.5 Mbps. The viewer's own
    // ceiling is the estimator bound (ApplyBitrate), never this.
    if (!imcodes::rd::ApplyVideoSenderBitrateLimits(
            *peer_, imcodes::rd::kMinVideoBitrateBps,
            imcodes::rd::kMaxViewerVideoBitrateBps)) {
      CloseLocked();
      return false;
    }

    // The browser is the offerer and creates the three negotiated channels.
    // Creating matching local channels here produces duplicates with different
    // SCTP ids and leaves the browser's payloads attached to ignored channels.
    return true;
  }

  // Lock discipline: `mutex_` guards only these members. It is never held
  // across a PeerConnection or DataChannel call. Those are proxies that block
  // until the signaling thread runs them, and the signaling thread takes
  // `mutex_` itself in OnDataChannel -- holding it across a proxy call
  // deadlocks the worker.
  bool AddRemoteIceCandidate(const common::IceCandidate& candidate) override {
    const auto peer = CurrentPeer();
    if (peer == nullptr)
      return false;
    webrtc::SdpParseError parse_error;
    std::unique_ptr<webrtc::IceCandidateInterface> parsed(
        webrtc::CreateIceCandidate(candidate.media_id, 0, candidate.candidate,
                                   &parse_error));
    if (parsed == nullptr)
      return false;
    // One candidate the peer cannot use (an address family it has no route
    // for, a stale generation) is not a transport failure. Browsers skip such
    // candidates and connect on the others; ending the session here would turn
    // any single unusable address into a dead route.
    (void)peer->AddIceCandidate(parsed.get());
    return true;
  }

  // Local candidates are produced by upstream ICE and surfaced through
  // OnIceCandidate; there is nothing to push down here. Reporting success for
  // a well-formed candidate keeps the adapter's contract total without
  // pretending this backend can inject one.
  bool EmitLocalIceCandidate(const common::IceCandidate& candidate) override {
    std::lock_guard lock(mutex_);
    return peer_ != nullptr && !candidate.candidate.empty();
  }

  bool SendDataChannel(common::DataChannelKind channel,
                       std::string_view payload) override {
    if (payload.empty() || payload.size() > imcodes::rd::kMaxDataMessageBytes)
      return false;
    webrtc::scoped_refptr<webrtc::DataChannelInterface> handle;
    {
      std::lock_guard lock(mutex_);
      if (peer_ == nullptr)
        return false;
      for (const auto& entry : channels_) {
        if (entry.kind == channel && entry.handle != nullptr) {
          handle = entry.handle;
          break;
        }
      }
    }
    if (handle == nullptr ||
        handle->state() != webrtc::DataChannelInterface::kOpen ||
        handle->buffered_amount() > 256 * 1024) {
      return false;
    }
    return handle->Send(webrtc::DataBuffer(std::string(payload)));
  }

  bool ApplyBitrate(std::uint32_t min_bps,
                    std::uint32_t start_bps,
                    std::uint32_t max_bps) override {
    const auto peer = CurrentPeer();
    if (peer == nullptr)
      return false;
    webrtc::BitrateSettings settings;
    settings.min_bitrate_bps = static_cast<int>(min_bps);
    // 0 leaves the running estimate alone (a ceiling change, not a reseed).
    if (start_bps > 0)
      settings.start_bitrate_bps = static_cast<int>(start_bps);
    settings.max_bitrate_bps = static_cast<int>(max_bps);
    return peer->SetBitrate(settings).ok();
  }

  void CloseDataChannel(common::DataChannelKind channel) noexcept override {
    std::vector<webrtc::scoped_refptr<webrtc::DataChannelInterface>> handles;
    {
      std::lock_guard lock(mutex_);
      for (auto& entry : channels_) {
        if (entry.kind != channel || entry.handle == nullptr)
          continue;
        handles.push_back(std::move(entry.handle));
        entry.handle = nullptr;
      }
    }
    for (auto& handle : handles) {
      handle->UnregisterObserver();
      handle->Close();
    }
  }

  [[nodiscard]] bool NegotiateOffer(std::string_view offer_sdp,
                                    std::string* answer_sdp) override {
    if (answer_sdp == nullptr)
      return false;
    auto state = std::make_shared<NegotiationState>();
    {
      std::lock_guard lock(mutex_);
      if (peer_ == nullptr)
        return false;
      // One at a time. A second offer while one is outstanding would race two
      // SetLocalDescription chains onto the same peer.
      if (negotiation_ != nullptr)
        return false;
      state->peer = peer_;
      negotiation_ = state;
    }

    webrtc::SdpParseError parse_error;
    std::unique_ptr<webrtc::SessionDescriptionInterface> offer =
        webrtc::CreateSessionDescription(webrtc::SdpType::kOffer, offer_sdp,
                                         &parse_error);
    if (offer == nullptr) {
      ClearNegotiation(state);
      return false;
    }

    state->peer->SetRemoteDescription(
        std::move(offer), webrtc::make_ref_counted<SetRemoteObserver>(state));

    bool succeeded = false;
    std::string produced;
    {
      std::unique_lock lock(state->mutex);
      // Bounded: upstream runs the chain on its signaling thread and a peer
      // that never completes must not wedge the single-threaded dispatch that
      // is blocked here. Close() also trips `finished` through Cancel().
      const bool settled = state->done.wait_for(
          lock, std::chrono::milliseconds(kNegotiationTimeoutMs),
          [&state] { return state->finished; });
      succeeded = settled && state->succeeded && !state->cancelled;
      if (succeeded)
        produced = state->answer_sdp;
    }

    ClearNegotiation(state);
    if (!succeeded || produced.empty())
      return false;
    *answer_sdp = std::move(produced);
    return true;
  }

  void Close() noexcept override {
    std::shared_ptr<NegotiationState> pending;
    ClosedResources closed;
    {
      std::lock_guard lock(mutex_);
      pending = negotiation_;
      closed = TakeResourcesLocked();
    }
    closed.Release();
    // Released outside the backend lock: the waiter wakes, observes
    // cancellation and returns false rather than blocking until the timeout.
    if (pending != nullptr)
      pending->Cancel();
  }

  // webrtc::PeerConnectionObserver
  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState /*state*/) override {}
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override {
    if (channel == nullptr)
      return;
    const std::optional<common::DataChannelKind> kind =
        ChannelKindForLabel(channel->label());
    const bool reliable_ordered = kind == common::DataChannelKind::kControl ||
                                  kind == common::DataChannelKind::kKeyboard;
    const bool valid =
        kind.has_value() &&
        (reliable_ordered
             ? channel->ordered() && !channel->maxRetransmitsOpt()
             : !channel->ordered() && channel->maxRetransmitsOpt() == 0);
    if (!valid) {
      channel->Close();
      return;
    }

    common::DataChannelState initial = common::DataChannelState::kFailed;
    {
      std::lock_guard lock(mutex_);
      if (peer_ == nullptr || std::any_of(channels_.begin(), channels_.end(),
                                          [kind](const ChannelEntry& entry) {
                                            return entry.kind == *kind;
                                          })) {
        channel->Close();
        return;
      }
      auto observer =
          std::make_unique<ChannelObserver>(adapter_, *kind, channel);
      channel->RegisterObserver(observer.get());
      initial = TranslateChannelState(channel->state());
      channels_.push_back({*kind, channel, std::move(observer)});
    }
    if (adapter_ != nullptr) {
      adapter_->ReportDataChannelState(adapter_->stamp(), *kind, initial);
    }
  }
  void OnRenegotiationNeeded() override {}
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState /*state*/) override {}

  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    if (adapter_ == nullptr)
      return;
    adapter_->ReportPeerConnectionState(adapter_->stamp(),
                                        TranslatePeerState(state));
  }

  void OnIceConnectionChange(
      webrtc::PeerConnectionInterface::IceConnectionState /*state*/) override {}

  void OnIceCandidate(const webrtc::IceCandidateInterface* candidate) override {
    if (adapter_ == nullptr || candidate == nullptr)
      return;
    std::string serialized;
    if (!candidate->ToString(&serialized))
      return;
    common::IceCandidate emitted;
    emitted.media_id = candidate->sdp_mid();
    emitted.candidate = std::move(serialized);
    adapter_->ReportLocalIceCandidate(adapter_->stamp(), std::move(emitted));
  }

  void OnIceSelectedCandidatePairChanged(
      const webrtc::CandidatePairChangeEvent& event) override {
    if (adapter_ == nullptr)
      return;
    const auto& local = event.selected_candidate_pair.local_candidate();
    const bool relayed = local.type() == webrtc::IceCandidateType::kRelay;
    adapter_->ReportTransportPath(adapter_->stamp(),
                                  relayed ? common::TransportPath::kRelay
                                          : common::TransportPath::kDirect);
  }

 private:
  struct ChannelEntry {
    common::DataChannelKind kind;
    webrtc::scoped_refptr<webrtc::DataChannelInterface> handle;
    std::unique_ptr<ChannelObserver> observer;
  };

  // Everything Close() tears down, detached from the backend under the lock so
  // the blocking upstream calls run without it.
  struct ClosedResources {
    std::vector<ChannelEntry> channels;
    webrtc::scoped_refptr<webrtc::VideoTrackInterface> video_track;
    webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer;
    webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
    std::unique_ptr<webrtc::Thread> signaling_thread;

    void Release() noexcept {
      for (auto& entry : channels) {
        if (entry.handle == nullptr)
          continue;
        entry.handle->UnregisterObserver();
        entry.handle->Close();
        entry.handle = nullptr;
      }
      channels.clear();
      video_track = nullptr;
      if (peer != nullptr) {
        peer->Close();
        peer = nullptr;
      }
      factory = nullptr;
      if (signaling_thread != nullptr) {
        signaling_thread->Stop();
        signaling_thread.reset();
      }
    }
  };

  ClosedResources TakeResourcesLocked() noexcept {
    ClosedResources closed;
    closed.channels = std::move(channels_);
    channels_.clear();
    closed.video_track = std::move(video_track_);
    closed.peer = std::move(peer_);
    closed.factory = std::move(factory_);
    closed.signaling_thread = std::move(signaling_thread_);
    video_track_ = nullptr;
    peer_ = nullptr;
    factory_ = nullptr;
    return closed;
  }

  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> CurrentPeer() {
    std::lock_guard lock(mutex_);
    return peer_;
  }

  void CloseLocked() noexcept {
    for (auto& entry : channels_) {
      if (entry.handle == nullptr)
        continue;
      entry.handle->UnregisterObserver();
      entry.handle->Close();
      entry.handle = nullptr;
    }
    channels_.clear();
    video_track_ = nullptr;
    if (peer_ != nullptr) {
      peer_->Close();
      peer_ = nullptr;
    }
    factory_ = nullptr;
    if (signaling_thread_ != nullptr) {
      signaling_thread_->Stop();
      signaling_thread_.reset();
    }
  }

  void ClearNegotiation(
      const std::shared_ptr<NegotiationState>& state) noexcept {
    std::lock_guard lock(mutex_);
    if (negotiation_ == state)
      negotiation_ = nullptr;
  }

  MacosTransportSessionAdapter* adapter_ = nullptr;
  MacosMediaSenderBinder* media_binder_ = nullptr;
  std::shared_ptr<NegotiationState> negotiation_;
  webrtc::scoped_refptr<webrtc::VideoTrackInterface> video_track_;
  std::mutex mutex_;
  std::unique_ptr<webrtc::Thread> signaling_thread_;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> peer_;
  std::vector<ChannelEntry> channels_;
};

}  // namespace

std::unique_ptr<MacosPeerConnectionBackend>
CreatePinnedLibwebrtcTransportBackend() {
  return std::make_unique<PinnedLibwebrtcTransportBackend>();
}

}  // namespace imcodes::remote_desktop::macos
