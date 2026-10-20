#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_NATIVE_VIDEO_SOURCE_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_NATIVE_VIDEO_SOURCE_H_

// Bridges the existing X11CaptureAdapter (common::CaptureAdapter, a
// CapturedFrame push callback) into libwebrtc's OWN video pipeline via
// common::NativeCaptureAdapter/NativeVideoSourceLease -- the same delivery
// model platform_interfaces.h documents Windows using ("a pooled
// VideoTrackSource... installs its... codec through VideoEncoderFactory"),
// not macOS's H264-access-unit-injection one.
//
// The initial Linux worker has no bespoke hardware encoder (see
// libwebrtc-sdk.gni), so unlike Windows there is no NativeEncoderFactoryAdapter
// here either: the caller registers libwebrtc's own builtin video encoder
// factory directly, and this class only ever produces I420 VideoFrames for it
// to encode.

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include "api/scoped_refptr.h"
#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::linux_platform {

class LinuxNativeCaptureAdapter final : public common::NativeCaptureAdapter {
 public:
  // `capture` must outlive every lease this produces.
  explicit LinuxNativeCaptureAdapter(common::CaptureAdapter& capture) noexcept;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  [[nodiscard]] std::unique_ptr<common::NativeVideoSourceLease> Acquire(
      const common::DisplayTopology& display) override;

 private:
  common::CaptureAdapter& capture_;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_NATIVE_VIDEO_SOURCE_H_
