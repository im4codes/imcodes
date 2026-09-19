#ifndef IMCODES_REMOTE_DESKTOP_COMMON_PROTOCOL_CONTRACTS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_PROTOCOL_CONTRACTS_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "quality_ladder.h"
#include "value_types.h"

namespace imcodes::remote_desktop::common {

// Platform sessions may layer typed envelopes on top of the shared strict JSON
// parser while keeping serialized payload ownership explicit at this seam.
struct ProtocolEnvelope {
  std::string type;
  std::string serialized_json;
};

class JsonProtocolCodec {
 public:
  virtual ~JsonProtocolCodec() = default;
  virtual std::optional<ProtocolEnvelope> Decode(
      std::string_view serialized_json, TerminalError* error) const = 0;
  virtual std::optional<std::string> Encode(
      const ProtocolEnvelope& envelope, TerminalError* error) const = 0;
};

struct IceCandidate {
  std::string media_id;
  std::string candidate;
};

class IceCandidateQueue {
 public:
  virtual ~IceCandidateQueue() = default;
  virtual bool Push(IceCandidate candidate) = 0;
  virtual std::vector<IceCandidate> TakeAll() = 0;
  virtual void Clear() noexcept = 0;
  [[nodiscard]] virtual std::size_t size() const noexcept = 0;
};

struct QualityTarget {
  std::uint32_t bitrate_bps = 0;
  PixelSize source_pixels;
  // The viewer's preference with the relay cap already folded in. Filled by
  // TransportSessionCore; a ladder passes it straight to SelectQuality.
  imcodes::rd::QualityPreference preference{};
};

struct QualitySelection {
  std::string preset_id;
  PixelSize encoded_pixels;
  std::uint32_t frame_rate = 0;
  std::uint32_t bitrate_bps = 0;
  // The viewer's stream ceiling (ViewerVideoBitrateCeiling), which the
  // transport applies to its RTP encoding and bandwidth estimator. Filled by
  // TransportSessionCore.
  std::uint32_t maximum_bitrate_bps = 0;
};

class QualityLadder {
 public:
  virtual ~QualityLadder() = default;
  [[nodiscard]] virtual QualitySelection Select(
      const QualityTarget& target) const noexcept = 0;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_PROTOCOL_CONTRACTS_H_
