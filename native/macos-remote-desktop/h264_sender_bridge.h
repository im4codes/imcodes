#ifndef IMCODES_MACOS_REMOTE_DESKTOP_H264_SENDER_BRIDGE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_H264_SENDER_BRIDGE_H_

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <vector>

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::macos {

enum class H264SenderProfile : std::uint8_t {
  kConstrainedBaseline,
  kMain,
  kHigh,
};

enum class H264SenderCompletion : std::uint8_t {
  kAccepted,
  kDropped,
  kFatal,
};

struct H264SenderConfiguration {
  common::WorkerGeneration generation = 0;
  common::PixelSize encoded_pixels;
  H264SenderProfile profile = H264SenderProfile::kConstrainedBaseline;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct H264SenderFrame {
  common::WorkerGeneration generation = 0;
  std::uint64_t submission_id = 0;
  std::vector<std::byte> bytes;
  std::int64_t presentation_time_us = 0;
  std::int64_t capture_time_ms = 0;
  std::uint32_t rtp_timestamp_90khz = 0;
  H264SenderProfile profile = H264SenderProfile::kConstrainedBaseline;
  bool keyframe = false;
};

using H264SenderCompletionCallback =
    std::function<void(H264SenderCompletion, std::size_t)>;

// Injected sender seam. The production implementation submits an EncodedImage
// to the repository-pinned libwebrtc callback. A successful Submit owns the
// frame and must invoke completion exactly once; a false return transfers no
// ownership and must not invoke completion.
class H264SenderBackend {
public:
  virtual ~H264SenderBackend() = default;
  virtual bool Start(const H264SenderConfiguration &configuration) = 0;
  virtual bool Submit(H264SenderFrame frame,
                      H264SenderCompletionCallback completion) = 0;
  virtual void Cancel(common::WorkerGeneration generation) noexcept = 0;
};

struct H264SenderBridgeLimits {
  std::uint32_t max_pending_access_units = 3;
  std::size_t max_pending_bytes = 48U * 1024U * 1024U;
  std::size_t max_access_unit_bytes = 32U * 1024U * 1024U;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct H264SenderBridgeStatistics {
  std::uint64_t accepted_access_units = 0;
  std::uint64_t delivered_access_units = 0;
  std::uint64_t dropped_backpressure_access_units = 0;
  std::uint64_t rejected_invalid_access_units = 0;
  std::uint64_t rejected_stale_generation_access_units = 0;
  std::uint64_t ignored_late_callbacks = 0;
  std::uint64_t terminal_failures = 0;
  std::uint64_t submitted_payload_bytes = 0;
  // The production backend reports its one bounded copy from the moved
  // access-unit vector into libwebrtc-owned EncodedImageBuffer storage.
  std::uint64_t webrtc_owned_copy_bytes = 0;
  std::uint32_t pending_access_units = 0;
  std::size_t pending_bytes = 0;
};

// Converts validated VideoToolbox Annex-B access units into bounded sender
// submissions. It deliberately knows nothing about RTP packetization, RTCP,
// pacing, congestion control, retransmission, ICE, sockets or TURN; those are
// owned by the injected pinned-libwebrtc backend.
class H264SenderBridge final {
public:
  explicit H264SenderBridge(std::unique_ptr<H264SenderBackend> backend,
                            H264SenderBridgeLimits limits = {});
  ~H264SenderBridge();

  H264SenderBridge(const H264SenderBridge &) = delete;
  H264SenderBridge &operator=(const H264SenderBridge &) = delete;

  bool Start(common::WorkerGeneration generation,
             common::PixelSize encoded_pixels, common::H264Profile profile);
  bool Submit(common::WorkerGeneration generation,
              common::H264AccessUnit access_unit);
  void Stop() noexcept;

  [[nodiscard]] bool IsActive() const noexcept;
  [[nodiscard]] std::optional<common::WorkerGeneration>
  ActiveGeneration() const noexcept;
  [[nodiscard]] H264SenderBridgeStatistics Statistics() const noexcept;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_H264_SENDER_BRIDGE_H_
