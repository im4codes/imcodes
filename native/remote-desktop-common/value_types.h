#ifndef IMCODES_REMOTE_DESKTOP_COMMON_VALUE_TYPES_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_VALUE_TYPES_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::common {

using WorkerGeneration = std::uint64_t;
using TopologyRevision = std::uint64_t;
using InputEpoch = std::uint64_t;
using InputSequence = std::uint64_t;

struct PixelSize {
  std::uint32_t width = 0;
  std::uint32_t height = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct LogicalPoint {
  double x = 0.0;
  double y = 0.0;
};

struct LogicalRect {
  double x = 0.0;
  double y = 0.0;
  double width = 0.0;
  double height = 0.0;

  [[nodiscard]] bool IsValid() const noexcept;
  [[nodiscard]] LogicalPoint MapNormalized(double normalized_x,
                                           double normalized_y) const noexcept;
};

enum class DisplayRotation : std::uint16_t {
  k0 = 0,
  k90 = 90,
  k180 = 180,
  k270 = 270,
};

struct DisplayOperations {
  bool selectable = true;
  bool set_mode = false;
  bool set_scale = false;
};

struct DisplayTopology {
  std::string display_id;
  WorkerGeneration generation = 0;
  PixelSize encoded_pixels;
  LogicalRect logical_input_bounds;
  double scale = 1.0;
  DisplayRotation rotation = DisplayRotation::k0;
  DisplayOperations operations;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct DesktopTopology {
  WorkerGeneration generation = 0;
  TopologyRevision revision = 0;
  std::vector<DisplayTopology> displays;

  [[nodiscard]] bool IsValid() const noexcept;
  [[nodiscard]] const DisplayTopology* FindDisplay(
      const std::string& display_id) const noexcept;
};

enum class ColorPrimaries : std::uint8_t {
  kUnspecified,
  kBt709,
  kDisplayP3,
};

// The first common capture/encoder seam deliberately standardizes on packed
// BGRA. A row stride is part of the frame contract because platform capture
// buffers may pad rows; encoded dimensions alone never authorize an adapter
// to assume width * 4 contiguous bytes.
enum class PixelFormat : std::uint8_t {
  kBgra8888,
};

class FrameStorage {
 public:
  virtual ~FrameStorage() = default;
  [[nodiscard]] virtual const std::byte* data() const noexcept = 0;
  [[nodiscard]] virtual std::size_t size() const noexcept = 0;
};

struct CapturedFrame {
  PixelSize encoded_pixels;
  PixelFormat pixel_format = PixelFormat::kBgra8888;
  std::uint32_t row_bytes = 0;
  std::int64_t capture_time_us = 0;
  ColorPrimaries color_primaries = ColorPrimaries::kUnspecified;
  std::shared_ptr<const FrameStorage> storage;

  [[nodiscard]] bool IsValid() const noexcept;
};

enum class H264Profile : std::uint8_t {
  kConstrainedBaseline,
  kMain,
  kHigh,
};

struct H264AccessUnit {
  std::vector<std::byte> bytes;
  std::int64_t presentation_time_us = 0;
  H264Profile profile = H264Profile::kConstrainedBaseline;
  bool keyframe = false;

  [[nodiscard]] bool IsValid() const noexcept;
};

enum class SessionState : std::uint8_t {
  kIdle,
  kViewing,
  kControlling,
  kTerminal,
};

enum class ReadinessState : std::uint8_t {
  kUnknown,
  kReady,
  kUnavailable,
};

struct CapabilityReadiness {
  ReadinessState capture = ReadinessState::kUnknown;
  ReadinessState encoder = ReadinessState::kUnknown;
  ReadinessState input = ReadinessState::kUnknown;
  ReadinessState clipboard = ReadinessState::kUnknown;
  ReadinessState display = ReadinessState::kUnknown;
  ReadinessState disclosure = ReadinessState::kUnknown;
  ReadinessState graphical_session = ReadinessState::kUnknown;

  [[nodiscard]] bool ViewReady() const noexcept;
  [[nodiscard]] bool ControlReady() const noexcept;
};

enum class TerminalErrorCode : std::uint8_t {
  kNone,
  kCaptureUnavailable,
  kEncoderUnavailable,
  kInputUnavailable,
  kDisclosureUnavailable,
  kGraphicalSessionEnded,
  kAdapterFailure,
  kProtocolViolation,
  kStopped,
};

struct TerminalError {
  TerminalErrorCode code = TerminalErrorCode::kNone;
  std::string detail;

  [[nodiscard]] bool IsTerminal() const noexcept {
    return code != TerminalErrorCode::kNone;
  }
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_VALUE_TYPES_H_
