#ifndef IMCODES_REMOTE_DESKTOP_WINDOWS_PLATFORM_ADAPTERS_H_
#define IMCODES_REMOTE_DESKTOP_WINDOWS_PLATFORM_ADAPTERS_H_

#include <windows.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "api/video_codecs/video_encoder_factory.h"
#include "third_party/imcodes_remote_desktop/common/platform_interfaces.h"
#include "third_party/imcodes_remote_desktop/display_capture.h"
#include "third_party/imcodes_remote_desktop/input_injector.h"

namespace imcodes::rd {

namespace common = imcodes::remote_desktop::common;

using WindowsDisplayList = std::function<const std::vector<DisplayInfo> &()>;
using WindowsClipboardSequence = std::function<DWORD()>;
using WindowsReadClipboardText =
    std::function<std::optional<std::u16string>(DWORD)>;
using WindowsEnvironmentSink = std::function<void(std::uint32_t)>;
using WindowsIndicatorStart = std::function<bool(WindowsEnvironmentSink)>;
using WindowsIndicatorShow = std::function<bool(std::uint32_t, std::uint32_t)>;
using WindowsIndicatorAction = std::function<void()>;
using WindowsAcquireCaptureTrack =
    std::function<webrtc::scoped_refptr<DxgiDesktopSource>(
        const common::DisplayTopology &)>;
using WindowsReleaseCaptureTrack = std::function<void(const DisplayInfo &)>;

// Windows v2 capture already enters libwebrtc as a VideoTrackSource.  Keep
// that source object intact at the platform boundary: converting it to the
// current common CaptureAdapter's CPU-addressable packed-BGRA CapturedFrame
// would add a second readback/conversion and would bypass the proven source
// pooling, privacy-shield and track-replacement path.
//
class WindowsDxgiCaptureTrackAdapter final
    : public common::NativeCaptureAdapter {
 public:
  WindowsDxgiCaptureTrackAdapter(WindowsAcquireCaptureTrack acquire,
                                 WindowsReleaseCaptureTrack release);

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  [[nodiscard]] std::unique_ptr<common::NativeVideoSourceLease> Acquire(
      const common::DisplayTopology &display) override;

 private:
  WindowsAcquireCaptureTrack acquire_;
  WindowsReleaseCaptureTrack release_;
};

// Media Foundation is already installed behind libwebrtc's
// VideoEncoderFactory.  Keeping that factory boundary preserves PLI/keyframe,
// SetRates, pacing, retransmission and congestion-control ownership in
// libwebrtc.  Adapting it to common::EncoderAdapter would instead create an
// out-of-band H264AccessUnit vector path, so this zero-copy seam exposes the
// exact factory consumed by the production PeerConnection stack.
class WindowsWebRtcEncoderFactoryAdapter final
    : public common::NativeEncoderFactoryAdapter {
 public:
  explicit WindowsWebRtcEncoderFactoryAdapter(
      std::unique_ptr<webrtc::VideoEncoderFactory> factory) noexcept;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  [[nodiscard]] std::unique_ptr<webrtc::VideoEncoderFactory> TakeFactory()
      override;

 private:
  std::unique_ptr<webrtc::VideoEncoderFactory> factory_;
};

// LocalIndicator receives Windows event-mask values because display/DWM
// events remain Windows-only. Graphical-session and power transitions cross
// the common SessionMonitor boundary; only the residual display/compositor
// events stay on the Windows callback.
[[nodiscard]] std::optional<common::GraphicalSessionEvent>
ToCommonGraphicalSessionEvent(std::uint32_t event_mask) noexcept;
[[nodiscard]] std::uint32_t WindowsEnvironmentMask(
    common::GraphicalSessionEvent event) noexcept;

// Windows keeps the established v2 DisplayInfo and wire bytes, but converts
// them at this boundary so encoded pixels can never be reused as input-space
// authority. Desktop coordinates are the SendInput logical coordinate space;
// width/height are the post-rotation encoded surface.
[[nodiscard]] common::PixelSize WindowsEncodedPixels(
    const DisplayInfo &display) noexcept;
[[nodiscard]] common::LogicalRect WindowsLogicalInputBounds(
    const DisplayInfo &display) noexcept;
[[nodiscard]] common::DisplayTopology ToCommonDisplayTopology(
    const DisplayInfo &display, common::WorkerGeneration generation) noexcept;
[[nodiscard]] std::optional<common::DesktopTopology> ToCommonDesktopTopology(
    const std::vector<DisplayInfo> &displays,
    common::WorkerGeneration generation, common::TopologyRevision revision);

// This is the Windows implementation of the common display seam. PeerSession
// retains protocol/status orchestration and capture-track replacement; native
// mode/scale mutation and topology conversion live here.
class WindowsDisplayAdapter final : public common::DisplayAdapter {
 public:
  explicit WindowsDisplayAdapter(WindowsDisplayList displays);

  void SetTopologyVersion(common::WorkerGeneration generation,
                          common::TopologyRevision revision) noexcept;
  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  std::optional<common::DesktopTopology> EnumerateTopology() override;
  bool SelectDisplay(std::string_view display_id) override;
  bool SetMode(std::string_view display_id, common::PixelSize pixels) override;
  bool SetScale(std::string_view display_id, double scale) override;

 private:
  const DisplayInfo *Find(std::string_view display_id) const noexcept;

  WindowsDisplayList displays_;
  common::WorkerGeneration generation_ = 1;
  common::TopologyRevision revision_ = 1;
};

// Explicit clipboard remains a caller-triggered operation. The adapter owns
// the Windows clipboard sequence/correlation wait and emits no background
// synchronization or requester-controlled UI.
class WindowsClipboardAdapter final : public common::ClipboardAdapter {
 public:
  WindowsClipboardAdapter(InputArbiter &input,
                          WindowsClipboardSequence sequence,
                          WindowsReadClipboardText read_text,
                          std::string controller_id);

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool PasteText(std::string_view text) override;
  bool CopySelection(std::string *text) override;

 private:
  InputArbiter &input_;
  WindowsClipboardSequence sequence_;
  WindowsReadClipboardText read_text_;
  std::string controller_id_;
};

// The Windows disclosure window also owns the WTS/power notification pump.
// This adapter separates those two common contracts without changing the
// existing LocalIndicator thread, desktop binding, Stop action or event-mask
// policy. Callback injection keeps the common-facing lifecycle executable in
// native tests without creating a real topmost window.
class WindowsDisclosureSessionAdapter final : public common::DisclosureAdapter,
                                              public common::SessionMonitor {
 public:
  WindowsDisclosureSessionAdapter(WindowsIndicatorStart start,
                                  WindowsIndicatorShow show,
                                  WindowsIndicatorAction hide,
                                  WindowsIndicatorAction stop,
                                  WindowsEnvironmentSink residual_environment);
  ~WindowsDisclosureSessionAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override;
  void Hide() noexcept override;
  bool Start(Observer observer) override;
  void Stop() noexcept override;

 private:
  WindowsIndicatorStart start_;
  WindowsIndicatorShow show_;
  WindowsIndicatorAction hide_;
  WindowsIndicatorAction stop_;
  WindowsEnvironmentSink residual_environment_;
  Observer observer_;
  bool start_attempted_ = false;
  bool started_ = false;
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_WINDOWS_PLATFORM_ADAPTERS_H_
