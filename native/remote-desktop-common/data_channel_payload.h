// Bounded parser for the browser-created DataChannel payloads.
//
// The browser is the offerer and owns all three channels, so every byte here
// arrives from a peer the worker does not control. This is deliberately a
// structural parser over an exact key set rather than a general JSON parser:
// a permissive parser would accept members the validator never looks at, and
// an unknown member riding along into the input path is exactly the shape this
// contract exists to refuse.
//
// It is also deliberately free of JsonCpp so the same parser can be linked and
// sanitized without a Chromium checkout. Windows and macOS both consume it, so
// a divergence here would be a divergence in what each platform accepts as
// input.
//
// Every shape mirrors the authoritative validators in shared/remote-desktop.ts
// (validatePointer / validateKeyboard / validateControl and the release_all
// arm). Where that file constrains a field per `kind`, so does this one.

#ifndef IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_PAYLOAD_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_PAYLOAD_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "data_channel_constants.h"

namespace imcodes::rd {

// Field bounds, pinned to REMOTE_DESKTOP_LIMITS in shared/remote-desktop.ts.
inline constexpr std::size_t kMaxSessionIdBytes = 128;
inline constexpr std::size_t kMaxDisplayIdBytes = 128;
inline constexpr std::size_t kMaxKeyCodeBytes = 64;
inline constexpr std::size_t kMaxKeyValueBytes = 64;
inline constexpr std::size_t kMaxKeyTextBytes = 4 * 1024;
inline constexpr std::size_t kMaxRequestIdBytes = 128;

// Wheel deltas are bounded rather than free: an unbounded delta is a scroll the
// host would have to clamp anyway, and clamping silently is worse than
// refusing.
inline constexpr double kMaxWheelDelta = 10'000.0;

inline constexpr int kDataProtocolVersion = 2;

enum class DataChannelMessageKind {
  kPointer,
  kKeyboard,
  kControl,
  kReleaseAll,
};

enum class PointerKind {
  kMove,
  kButtonDown,
  kButtonUp,
  kButtonClick,
  kWheel,
};

enum class PointerButton {
  kLeft,
  kMiddle,
  kRight,
  kBack,
  kForward,
};

enum class KeyboardKind {
  kKeyDown,
  kKeyUp,
  kText,
};

/**
 * Correlation carried by every input message.
 *
 * Present on all four shapes so a stale route, a replayed sequence or a
 * superseded layout can be rejected before the payload reaches an injector.
 */
struct InputCorrelation {
  std::string session_id;
  std::uint64_t sequence = 0;
  std::uint64_t layout_revision = 0;
  std::uint64_t input_epoch = 0;
};

struct PointerPayload {
  PointerKind kind = PointerKind::kMove;
  // Normalized [0,1] display coordinates. Absent for a wheel that carries only
  // deltas, and required for a move.
  std::optional<double> x;
  std::optional<double> y;
  std::optional<PointerButton> button;
  std::optional<double> delta_x;
  std::optional<double> delta_y;
};

struct KeyboardPayload {
  KeyboardKind kind = KeyboardKind::kKeyDown;
  std::optional<std::string> code;
  std::optional<std::string> key;
  std::optional<bool> repeat;
  std::optional<std::string> text;
};

struct ControlPayload {
  // Kept as the exact validated wire token rather than a second enum. The
  // parser rejects unknown kinds and applies the shared per-kind field shape;
  // downstream dispatch can therefore answer unsupported-but-known controls
  // without duplicating a platform-specific vocabulary.
  std::string kind;
  std::optional<std::string> display_id;
  std::optional<std::uint64_t> width;
  std::optional<std::uint64_t> height;
  std::optional<std::uint64_t> dpi_scale_percent;
  std::optional<std::string> request_id;
  std::optional<std::uint64_t> frame_width;
  std::optional<std::uint64_t> frame_height;
  std::optional<std::uint64_t> acknowledged_sequence;
};

struct DataChannelMessage {
  DataChannelMessageKind kind = DataChannelMessageKind::kReleaseAll;
  InputCorrelation correlation;
  PointerPayload pointer;
  KeyboardPayload keyboard;
  ControlPayload control;
};

/**
 * Parses one DataChannel payload.
 *
 * Returns false and leaves `out` untouched for anything that is not exactly one
 * of the four accepted shapes: an oversized frame, a trailing byte, a duplicate
 * member, an unknown member, a nested value, a wrong `protocolVersion`, a
 * correlation field out of range, or a field that the message's own `kind`
 * forbids.
 */
[[nodiscard]] bool ParseDataChannelMessage(std::string_view payload,
                                           DataChannelMessage* out);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_PAYLOAD_H_
