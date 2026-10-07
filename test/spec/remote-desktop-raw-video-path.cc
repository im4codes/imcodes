// Counterfactual tests for the raw (libvpx) video path's session-side pieces:
// the RawVideoPath rendezvous, the RawFrameEncoderAdapter and the
// CodecSwitchingEncoderAdapter. Free of libwebrtc, Apple and libyuv: the NV12 ->
// BGRA conversion the switch uses on the H.264 fallback is injected as a stub
// (the real one is covered by remote-desktop-raw-frame-conversion.cc).
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <optional>
#include <string_view>
#include <vector>

#include "codec_encoder_adapters.h"
#include "macos_media_sender_binder.h"
#include "raw_video_path.h"

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;

namespace {

void Require(bool condition, std::string_view message) {
  if (condition) return;
  std::cerr << "raw video path failure: " << message << '\n';
  std::exit(1);
}

class Storage final : public common::FrameStorage {
 public:
  explicit Storage(std::size_t n) : bytes_(n) {}
  const std::byte* data() const noexcept override { return bytes_.data(); }
  std::size_t size() const noexcept override { return bytes_.size(); }
 private:
  std::vector<std::byte> bytes_;
};

common::CapturedFrame Bgra(std::uint32_t w, std::uint32_t h) {
  common::CapturedFrame f;
  f.encoded_pixels = {w, h};
  f.pixel_format = common::PixelFormat::kBgra8888;
  f.row_bytes = w * 4;
  f.storage = std::make_shared<Storage>(static_cast<std::size_t>(w) * 4 * h);
  return f;
}

common::CapturedFrame Nv12(std::uint32_t w, std::uint32_t h) {
  common::CapturedFrame f;
  f.encoded_pixels = {w, h};
  f.pixel_format = common::PixelFormat::kNv12;
  f.row_bytes = w;
  f.uv_offset = w * h;
  f.uv_row_bytes = w;
  f.storage = std::make_shared<Storage>(static_cast<std::size_t>(w) * h * 3 / 2);
  return f;
}

common::EncoderConfiguration Config(std::uint32_t w, std::uint32_t h) {
  common::EncoderConfiguration c;
  c.encoded_pixels = {w, h};
  c.frame_rate = 30;
  c.bitrate_bps = 8'000'000;
  return c;
}

class CountingSink final : public macos::RawFrameSink {
 public:
  bool Push(const common::CapturedFrame& frame) override {
    ++frames;
    last_width = frame.encoded_pixels.width;
    last_format = frame.pixel_format;
    return accept;
  }
  int frames = 0;
  std::uint32_t last_width = 0;
  common::PixelFormat last_format = common::PixelFormat::kBgra8888;
  bool accept = true;
};

// A stand-in for the VideoToolbox encoder.
class FakeEncoder final : public macos::ReconfigurableEncoder {
 public:
  common::ReadinessState ProbeReadiness() override { return common::ReadinessState::kReady; }
  bool Configure(const common::EncoderConfiguration& c, common::H264AccessUnitSink) override {
    ++configures;
    if (!configure_ok) return false;
    config = c;
    return true;
  }
  bool Encode(common::CapturedFrame frame, bool key) override {
    ++encodes;
    last_format = frame.pixel_format;
    last_key = key;
    keys += key ? 1 : 0;
    return true;
  }
  void Stop() noexcept override { ++stops; config.reset(); }
  common::EncoderClass ImplementationClass() const noexcept override { return cls; }
  std::uint64_t DroppedFrames() const noexcept override { return dropped; }
  common::PixelFormat PreferredInputFormat() const noexcept override { return preferred; }
  bool ReconfigureFromQualitySelection(const imcodes::rd::QualitySelection&) override {
    ++reconfigures;
    return config.has_value();
  }
  std::optional<common::EncoderConfiguration> Configuration() const override { return config; }
  void SetConfigurationObserver(std::function<void()> o) override { observer = std::move(o); }

  common::PixelFormat preferred = common::PixelFormat::kBgra8888;
  bool configure_ok = true;
  int configures = 0, encodes = 0, stops = 0, keys = 0, reconfigures = 0;
  bool last_key = false;
  common::PixelFormat last_format = common::PixelFormat::kBgra8888;
  common::EncoderClass cls = common::EncoderClass::kSoftware;
  std::uint64_t dropped = 0;
  std::optional<common::EncoderConfiguration> config;
  std::function<void()> observer;
};

// Stands in for the libyuv conversion: marks the result BGRA so the test can tell
// a converted frame from the original.
std::optional<common::CapturedFrame> StubNv12ToBgra(
    const common::CapturedFrame& frame, std::size_t max_bytes) {
  if (frame.pixel_format != common::PixelFormat::kNv12) return std::nullopt;
  const std::size_t total = static_cast<std::size_t>(frame.encoded_pixels.width) * 4 *
                            frame.encoded_pixels.height;
  if (total > max_bytes) return std::nullopt;
  common::CapturedFrame out = frame;
  out.pixel_format = common::PixelFormat::kBgra8888;
  out.row_bytes = frame.encoded_pixels.width * 4;
  out.uv_offset = 0;
  out.uv_row_bytes = 0;
  out.storage = std::make_shared<Storage>(total);
  return out;
}

std::shared_ptr<macos::RawVideoPath> MakePath(bool allowed, bool converter = true) {
  auto counter = std::make_shared<std::atomic<std::uint64_t>>(0);
  auto path = std::make_shared<macos::RawVideoPath>(counter);
  path->AllowRawCodecs(allowed);
  if (converter) path->SetNv12ToBgraConverter(StubNv12ToBgra);
  return path;
}

void PathStartsInertAndTracksTheNegotiatedCodec() {
  auto counter = std::make_shared<std::atomic<std::uint64_t>>(0);
  macos::RawVideoPath path(counter);
  Require(!path.raw_codecs_allowed(), "raw codecs are off until a route allows them");
  Require(path.negotiated_codec() == macos::NegotiatedVideoCodec::kUnknown, "nothing negotiated");
  path.SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);
  Require(!path.raw_active(), "VP9 negotiated but not allowed: not active (hardware Macs never use it)");
  path.AllowRawCodecs(true);
  Require(path.raw_active(), "allowed + VP9: active");
  path.SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  Require(!path.raw_active(), "H.264 negotiated: not active");
  path.SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp8);
  Require(path.raw_active(), "VP8 is a raw codec too");
}

void EncodedBytesReachTheMediaProgressCounter() {
  auto counter = std::make_shared<std::atomic<std::uint64_t>>(5);
  macos::RawVideoPath path(counter);
  path.AddAcceptedBytes(1200);
  path.AddAcceptedBytes(34);
  Require(counter->load() == 5 + 1234, "libvpx output feeds the counter the watchdog reads");
}

void TheBindersWatchdogCounterSeesRawBytes() {
  macos::MacosMediaSenderBinder binder;
  Require(binder.raw_video() != nullptr, "every route has a raw-video rendezvous");
  Require(binder.accepted_bytes() == 0, "starts at zero");
  binder.raw_video()->AddAcceptedBytes(700);
  Require(binder.accepted_bytes() == 700,
          "bytes libvpx produces are the media progress the watchdog reads (else VP9 reads as a stall)");
  Require(!binder.raw_video()->raw_codecs_allowed(), "inert by default");
}

void NoSinkRefusesInsteadOfBuffering() {
  auto path = MakePath(true);
  Require(!path.get()->PushFrame(Bgra(64, 64)), "no sink: refused");
  Require(path->no_sink_frames() == 1, "counted");
  auto sink = std::make_shared<CountingSink>();
  path->SetSink(sink);
  Require(path->PushFrame(Bgra(64, 64)) && sink->frames == 1, "delivered once a sink exists");
  path->SetSink(nullptr);
  Require(!path->PushFrame(Bgra(64, 64)) && sink->frames == 1, "cleared sink: refused, nothing buffered");
}

void SinkMayReenterThePathWithoutDeadlock() {
  class Reentrant final : public macos::RawFrameSink {
   public:
    explicit Reentrant(macos::RawVideoPath* p) : path_(p) {}
    bool Push(const common::CapturedFrame&) override {
      path_->SetSink(nullptr);  // would deadlock if Push ran under the path's lock
      return true;
    }
   private:
    macos::RawVideoPath* path_;
  };
  auto path = MakePath(true);
  path->SetSink(std::make_shared<Reentrant>(path.get()));
  Require(path->PushFrame(Bgra(64, 64)), "the sink ran outside the lock");
}

void RawAdapterIsOnlyConfigurableWhenAllowed() {
  auto off = MakePath(false);
  macos::RawFrameEncoderAdapter refused(off);
  Require(!refused.Configure(Config(1280, 720), {}), "a hardware Mac cannot configure the raw encoder");
  Require(refused.ProbeReadiness() == common::ReadinessState::kUnavailable, "and it is not ready");

  auto on = MakePath(true);
  macos::RawFrameEncoderAdapter raw(on);
  Require(raw.ProbeReadiness() == common::ReadinessState::kReady, "ready when allowed");
  Require(raw.PreferredInputFormat() == common::PixelFormat::kNv12, "prefers NV12");
  Require(raw.ImplementationClass() == common::EncoderClass::kSoftware, "reported as software");
  Require(!raw.Encode(Bgra(64, 64), false), "unconfigured: refused");
  Require(raw.Configure(Config(1281, 721), {}), "configures");
  Require(raw.Configuration()->encoded_pixels.width == 1280 &&
              raw.Configuration()->encoded_pixels.height == 720,
          "odd sizes are rounded down to even (I420 chroma)");
}

void RawAdapterForwardsFramesAndCountsRefusals() {
  auto path = MakePath(true);
  auto sink = std::make_shared<CountingSink>();
  macos::RawFrameEncoderAdapter raw(path);
  Require(raw.Configure(Config(1280, 720), {}), "configure");
  Require(!raw.Encode(Bgra(1280, 720), false) && raw.DroppedFrames() == 1, "no sink yet: refused and counted");
  path->SetSink(sink);
  Require(raw.Encode(Nv12(1280, 720), false) && sink->frames == 1, "forwarded");
  Require(sink->last_format == common::PixelFormat::kNv12, "untouched: no copy or conversion on this side");
  sink->accept = false;
  Require(!raw.Encode(Bgra(1280, 720), false) && raw.DroppedFrames() == 2, "a refusing sink is counted");
  raw.Stop();
  Require(!raw.Encode(Bgra(1280, 720), false), "stopped: refused");
  Require(!raw.Configuration().has_value(), "stopped: no configuration");
}

void RawAdapterReconfigureNotifiesOnlyOnASizeChangeAndOutsideItsLock() {
  auto path = MakePath(true);
  macos::RawFrameEncoderAdapter raw(path);
  Require(!raw.ReconfigureFromQualitySelection({"x", 640, 360, 15, 1'000'000}), "unconfigured: refused");
  Require(raw.Configure(Config(1280, 720), {}), "configure");
  int notified = 0;
  std::optional<common::EncoderConfiguration> seen;
  raw.SetConfigurationObserver([&] {
    ++notified;
    seen = raw.Configuration();  // would deadlock if the observer ran under the lock
  });
  Require(raw.ReconfigureFromQualitySelection({"x", 1280, 720, 15, 2'000'000}), "same size, new rate");
  Require(notified == 0, "no capture retarget for a rate-only change");
  Require(raw.Configuration()->bitrate_bps == 2'000'000 && raw.Configuration()->frame_rate == 15, "rate applied");
  Require(raw.ReconfigureFromQualitySelection({"x", 960, 541, 15, 2'000'000}), "new size");
  Require(notified == 1 && seen.has_value() && seen->encoded_pixels.width == 960 &&
              seen->encoded_pixels.height == 540,
          "observer ran once, saw the even-rounded new size");
  Require(!raw.ReconfigureFromQualitySelection({"x", 0, 360, 15, 1}), "invalid selection refused");
}

struct Rig {
  explicit Rig(bool allowed, bool converter = true)
      : path(MakePath(allowed, converter)), sink(std::make_shared<CountingSink>()),
        sw(h264, raw_fake, path) {
    raw_fake.preferred = common::PixelFormat::kNv12;  // as the real raw adapter
    path->SetSink(sink);
  }
  std::shared_ptr<macos::RawVideoPath> path;
  std::shared_ptr<CountingSink> sink;
  FakeEncoder h264;
  FakeEncoder raw_fake;
  macos::CodecSwitchingEncoderAdapter sw;
};

void SwitchSendsFramesByTheNegotiatedCodec() {
  Rig rig(true);
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  Require(rig.h264.configures == 1 && rig.raw_fake.configures == 1, "both encoders configured");
  // Before the offer is answered the codec is unknown: the old path.
  Require(rig.sw.Encode(Bgra(1280, 720), false), "unknown codec");
  Require(rig.h264.encodes == 1 && rig.raw_fake.encodes == 0, "unknown -> VideoToolbox, as before");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  Require(rig.sw.Encode(Bgra(1280, 720), false) && rig.h264.encodes == 2, "H.264 -> VideoToolbox");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);
  Require(rig.sw.Encode(Nv12(1280, 720), false), "VP9");
  Require(rig.raw_fake.encodes == 1 && rig.h264.encodes == 2, "VP9 -> raw path; VideoToolbox idle");
  Require(rig.raw_fake.last_format == common::PixelFormat::kNv12, "NV12 handed over untouched");
}

void ARouteSwitchBackToH264AsksForAKeyframe() {
  Rig rig(true);
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);
  (void)rig.sw.Encode(Bgra(1280, 720), false);
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  (void)rig.sw.Encode(Bgra(1280, 720), false);
  Require(rig.h264.last_key && rig.h264.keys == 1, "the idle H.264 session restarts on a keyframe");
  (void)rig.sw.Encode(Bgra(1280, 720), false);
  Require(rig.h264.keys == 1, "only the first frame after the switch");
}

void ANode_WithHardwareH264_NeverUsesTheRawPath() {
  Rig rig(false);
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  Require(rig.raw_fake.configures == 0, "the raw encoder is not even configured");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);  // even if something claimed VP9
  Require(rig.sw.Encode(Bgra(1280, 720), false), "encode");
  Require(rig.h264.encodes == 1 && rig.raw_fake.encodes == 0, "always VideoToolbox");
  Require(rig.sw.PreferredInputFormat() == common::PixelFormat::kBgra8888, "BGRA capture, as before");
  Require(rig.sw.ImplementationClass() == rig.h264.ImplementationClass(), "reports the VideoToolbox encoder");
}

void H264FallbackConvertsNv12BackToBgra() {
  Rig rig(true);
  Require(rig.sw.PreferredInputFormat() == common::PixelFormat::kNv12, "NV12 capture on a no-hardware Mac");
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  Require(rig.sw.Encode(Nv12(1280, 720), false), "NV12 frame, H.264 negotiated");
  Require(rig.h264.last_format == common::PixelFormat::kBgra8888, "VideoToolbox is fed BGRA");
  Require(rig.sw.fallback_conversions() == 1, "counted");
  Require(rig.sw.Encode(Bgra(1280, 720), false) && rig.sw.fallback_conversions() == 1,
          "a BGRA frame needs no conversion");
}

void WithoutAConverterTheCaptureStaysBgra() {
  Rig rig(true, /*converter=*/false);
  Require(rig.sw.PreferredInputFormat() == common::PixelFormat::kBgra8888,
          "no way back to H.264 from NV12: do not ask the capture for it");
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  Require(!rig.sw.Encode(Nv12(1280, 720), false), "an NV12 frame with H.264 and no converter is refused");
  Require(rig.sw.Encode(Bgra(1280, 720), false), "BGRA still works");
}

void SwitchConfigureSucceedsWithEitherEncoder() {
  Rig rig(true);
  rig.h264.configure_ok = false;
  Require(rig.sw.Configure(Config(1280, 720), {}), "VideoToolbox could not start but VP9 can");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);
  Require(rig.sw.Encode(Bgra(1280, 720), false) && rig.raw_fake.encodes == 1, "VP9 works");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kH264);
  Require(!rig.sw.Encode(Bgra(1280, 720), false), "H.264 has no encoder: refused, never silently dropped");

  Rig neither(true);
  neither.h264.configure_ok = false;
  neither.raw_fake.configure_ok = false;
  Require(!neither.sw.Configure(Config(1280, 720), {}), "neither: fails");
}

void SwitchReconfigureDoesNotRebuildTheIdleSession() {
  Rig rig(true);
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  Require(rig.sw.ReconfigureFromQualitySelection({"x", 960, 540, 15, 1'000'000}), "before negotiation");
  Require(rig.h264.reconfigures == 1 && rig.raw_fake.reconfigures == 1, "both follow the ladder before the codec is known");
  rig.path->SetNegotiatedCodec(macos::NegotiatedVideoCodec::kVp9);
  Require(rig.sw.ReconfigureFromQualitySelection({"x", 640, 360, 15, 500'000}), "VP9 active");
  Require(rig.h264.reconfigures == 1 && rig.raw_fake.reconfigures == 2,
          "an idle VideoToolbox session is not rebuilt for a ladder step");
}

void SwitchStopsBothAndForgetsTheRoute() {
  Rig rig(true);
  Require(rig.sw.Configure(Config(1280, 720), {}), "configure");
  rig.sw.Stop();
  Require(rig.h264.stops == 1 && rig.raw_fake.stops == 1, "both stopped");
  Require(!rig.sw.Encode(Bgra(1280, 720), false), "stopped: refused");
}

void SwitchObserverReachesBothEncoders() {
  Rig rig(true);
  int notified = 0;
  rig.sw.SetConfigurationObserver([&] { ++notified; });
  rig.h264.observer();
  rig.raw_fake.observer();
  Require(notified == 2, "a size change from either encoder moves the capture");
}

}  // namespace

int main() {
  PathStartsInertAndTracksTheNegotiatedCodec();
  EncodedBytesReachTheMediaProgressCounter();
  TheBindersWatchdogCounterSeesRawBytes();
  NoSinkRefusesInsteadOfBuffering();
  SinkMayReenterThePathWithoutDeadlock();
  RawAdapterIsOnlyConfigurableWhenAllowed();
  RawAdapterForwardsFramesAndCountsRefusals();
  RawAdapterReconfigureNotifiesOnlyOnASizeChangeAndOutsideItsLock();
  SwitchSendsFramesByTheNegotiatedCodec();
  ARouteSwitchBackToH264AsksForAKeyframe();
  ANode_WithHardwareH264_NeverUsesTheRawPath();
  H264FallbackConvertsNv12BackToBgra();
  WithoutAConverterTheCaptureStaysBgra();
  SwitchConfigureSucceedsWithEitherEncoder();
  SwitchReconfigureDoesNotRebuildTheIdleSession();
  SwitchStopsBothAndForgetsTheRoute();
  SwitchObserverReachesBothEncoders();
  std::cout << "raw video path counterfactuals passed\n";
  return 0;
}
