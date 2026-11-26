#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RAW_FRAME_CONVERSION_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RAW_FRAME_CONVERSION_H_

#include <cstdint>
#include <optional>

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::macos {

// Writable I420 planes, owned by the caller (libwebrtc's I420Buffer in
// production, plain vectors in tests).
struct I420Planes {
  std::uint8_t* y = nullptr;
  int y_stride = 0;
  std::uint8_t* u = nullptr;
  int u_stride = 0;
  std::uint8_t* v = nullptr;
  int v_stride = 0;
  int width = 0;
  int height = 0;
};

// Converts a captured frame into I420 of the SAME size, for libvpx.
//
// COLOUR. Everything here is ITU-R BT.709, limited ("video") range, and the
// caller must tag the resulting frame that way. 709 because a viewer that is not
// told otherwise assumes it for an HD picture, and because the conversion and
// the capture must agree: BGRA goes through libyuv's BT.709 limited matrix, and
// a CGDisplayStream NV12 capture is requested with the 709 matrix and video range
// (cg_display_stream_backend.mm), so for NV12 the conversion is a pure plane
// split with no colour arithmetic at all. Disagreement would shift every colour.
//
// Returns false (writing nothing the caller may rely on) for an invalid frame, a
// destination that does not match the frame size, or odd dimensions.
[[nodiscard]] bool ConvertFrameToI420(const common::CapturedFrame& frame,
                                      const I420Planes& destination);

// NV12 -> packed BGRA, for the H.264 fallback: VideoToolbox here is fed BGRA.
// Same BT.709 limited-range matrix. nullopt for an invalid frame, a frame that
// is not NV12, or an allocation that would exceed `max_bytes`.
[[nodiscard]] std::optional<common::CapturedFrame> ConvertNv12FrameToBgra(
    const common::CapturedFrame& frame, std::size_t max_bytes);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RAW_FRAME_CONVERSION_H_
