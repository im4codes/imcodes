#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RAW_VIDEO_PATH_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RAW_VIDEO_PATH_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "../remote-desktop-common/value_types.h"
#include "raw_codec_policy.h"
#include "raw_codec_settings.h"

namespace imcodes::remote_desktop::macos {

// Which video codec the browser's offer and this node's answer settled on.
enum class NegotiatedVideoCodec : std::uint8_t {
  kUnknown,  // nothing negotiated yet
  kH264,     // the VideoToolbox access units go out as before
  kVp9,      // raw frames go to libvpx inside libwebrtc
  kVp8,
};

[[nodiscard]] constexpr bool IsRawCodec(NegotiatedVideoCodec codec) noexcept {
  return codec == NegotiatedVideoCodec::kVp9 ||
         codec == NegotiatedVideoCodec::kVp8;
}

// NV12 -> packed BGRA, up to a byte ceiling. Installed by the composition that
// links libyuv, so the session-side code (and its tests) need no libyuv.
using Nv12ToBgraConverter = std::function<std::optional<common::CapturedFrame>(
    const common::CapturedFrame&, std::size_t max_bytes)>;

// What libwebrtc's libvpx encoder actually came up as. Written by the libwebrtc
// side when it initialises the encoder, read by the worker to tell the viewer and
// the log what is really encoding.
struct RawEncoderFacts {
  NegotiatedVideoCodec codec = NegotiatedVideoCodec::kUnknown;
  std::string implementation;  // the encoder's own name, e.g. "libvpx"
  int cores = 0;               // the capped core count libvpx was told it has
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

// The node's raw-codec decision for this route and where the setting came from,
// kept beside the path so the viewer and the log can say what was decided and why.
struct RawCodecPolicyState {
  RawCodecReason reason = RawCodecReason::kHardwareH264;
  RawCodecSettingSource setting_source = RawCodecSettingSource::kDefault;
  bool nv12_capture = false;
  bool invalid_value_ignored = false;
};

// Where a raw (not yet encoded) frame goes. Implemented by the libwebrtc side,
// which converts it to I420 and hands it to the track source; kept as an
// interface so the session-side adapters need no libwebrtc header.
class RawFrameSink {
 public:
  virtual ~RawFrameSink() = default;
  // True when the frame was taken or deliberately dropped (the encoder is busy
  // with a newer one); false only when it cannot be delivered at all.
  virtual bool Push(const common::CapturedFrame& frame) = 0;
};

// The one rendezvous between the session (which owns capture and the encoder
// choice) and the transport (which owns the SDP exchange and libwebrtc): the
// policy "may this node send a codec libwebrtc encodes itself", what was
// negotiated, where raw frames go, and the encoded-byte counter the media
// watchdog reads.
//
// Raw codecs are for a Mac with no hardware H.264 encoder: there Apple's
// software H.264 encoder is the slow, blurry link, while libvpx VP9 -- already
// part of the pinned libwebrtc SDK -- encodes the same picture several times
// faster on the same cores. A Mac with a hardware encoder never enables this and
// behaves exactly as before.
class RawVideoPath {
 public:
  // `accepted_bytes` is the same counter the media sender binder exposes as its
  // media-progress signal: bytes libvpx produces are added to it, otherwise the
  // watchdog would read a healthy VP9 stream as a stall.
  explicit RawVideoPath(
      std::shared_ptr<std::atomic<std::uint64_t>> accepted_bytes)
      : accepted_bytes_(std::move(accepted_bytes)) {}

  RawVideoPath(const RawVideoPath&) = delete;
  RawVideoPath& operator=(const RawVideoPath&) = delete;

  // Policy, set once while the route is composed (before any negotiation).
  void AllowRawCodecs(bool allowed) noexcept {
    raw_codecs_allowed_.store(allowed, std::memory_order_release);
  }
  [[nodiscard]] bool raw_codecs_allowed() const noexcept {
    return raw_codecs_allowed_.load(std::memory_order_acquire);
  }

  // Opt-in (default off): ask the capture for NV12 rather than BGRA while raw codecs
  // are allowed. See raw_codec_settings.h for why BGRA is the default.
  void PreferNv12Capture(bool prefer) noexcept {
    prefer_nv12_capture_.store(prefer, std::memory_order_release);
  }
  [[nodiscard]] bool prefer_nv12_capture() const noexcept {
    return prefer_nv12_capture_.load(std::memory_order_acquire);
  }

  void SetNegotiatedCodec(NegotiatedVideoCodec codec) noexcept {
    negotiated_.store(codec, std::memory_order_release);
  }
  [[nodiscard]] NegotiatedVideoCodec negotiated_codec() const noexcept {
    return negotiated_.load(std::memory_order_acquire);
  }
  // True while frames must go to the raw sink rather than to VideoToolbox.
  [[nodiscard]] bool raw_active() const noexcept {
    return raw_codecs_allowed() && IsRawCodec(negotiated_codec());
  }

  // The transport installs its sink when its peer is built and clears it (null)
  // when the peer closes; a frame pushed after that is refused, never buffered.
  void SetSink(std::shared_ptr<RawFrameSink> sink) {
    std::lock_guard lock(mutex_);
    sink_ = std::move(sink);
  }
  // Delivers one frame. Returns false when there is no sink. The sink is called
  // WITHOUT the lock held: it converts a multi-megabyte frame.
  bool PushFrame(const common::CapturedFrame& frame) {
    std::shared_ptr<RawFrameSink> sink;
    {
      std::lock_guard lock(mutex_);
      sink = sink_;
    }
    if (sink == nullptr) {
      no_sink_frames_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    return sink->Push(frame);
  }

  // The H.264 fallback needs BGRA while an NV12 capture is running. Installed once
  // while the route is composed; with none installed the raw path is not offered
  // an NV12 capture (the switch would have no way back to H.264).
  void SetNv12ToBgraConverter(Nv12ToBgraConverter converter) {
    auto shared = converter ? std::make_shared<const Nv12ToBgraConverter>(
                                  std::move(converter))
                            : nullptr;
    std::lock_guard lock(mutex_);
    nv12_to_bgra_ = std::move(shared);
  }
  [[nodiscard]] bool has_nv12_to_bgra() const {
    std::lock_guard lock(mutex_);
    return nv12_to_bgra_ != nullptr;
  }
  [[nodiscard]] std::optional<common::CapturedFrame> ConvertNv12ToBgra(
      const common::CapturedFrame& frame, std::size_t max_bytes) const {
    std::shared_ptr<const Nv12ToBgraConverter> converter;
    {
      std::lock_guard lock(mutex_);
      converter = nv12_to_bgra_;
    }
    if (converter == nullptr) return std::nullopt;
    return (*converter)(frame, max_bytes);
  }

  void SetEncoderFacts(RawEncoderFacts facts) {
    std::lock_guard lock(mutex_);
    encoder_facts_ = std::move(facts);
  }
  void ClearEncoderFacts() {
    std::lock_guard lock(mutex_);
    encoder_facts_.reset();
  }
  [[nodiscard]] std::optional<RawEncoderFacts> encoder_facts() const {
    std::lock_guard lock(mutex_);
    return encoder_facts_;
  }
  void SetPolicyState(const RawCodecPolicyState& state) {
    std::lock_guard lock(mutex_);
    policy_state_ = state;
  }
  [[nodiscard]] RawCodecPolicyState policy_state() const {
    std::lock_guard lock(mutex_);
    return policy_state_;
  }

  void AddAcceptedBytes(std::size_t bytes) noexcept {
    if (accepted_bytes_ != nullptr)
      accepted_bytes_->fetch_add(bytes, std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t no_sink_frames() const noexcept {
    return no_sink_frames_.load(std::memory_order_relaxed);
  }

 private:
  const std::shared_ptr<std::atomic<std::uint64_t>> accepted_bytes_;
  std::atomic<bool> raw_codecs_allowed_{false};
  std::atomic<bool> prefer_nv12_capture_{false};
  std::atomic<NegotiatedVideoCodec> negotiated_{NegotiatedVideoCodec::kUnknown};
  std::atomic<std::uint64_t> no_sink_frames_{0};
  mutable std::mutex mutex_;
  std::shared_ptr<RawFrameSink> sink_;
  std::shared_ptr<const Nv12ToBgraConverter> nv12_to_bgra_;
  std::optional<RawEncoderFacts> encoder_facts_;
  RawCodecPolicyState policy_state_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RAW_VIDEO_PATH_H_
