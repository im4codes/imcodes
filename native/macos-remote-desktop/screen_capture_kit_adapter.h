#ifndef IMCODES_MACOS_REMOTE_DESKTOP_SCREEN_CAPTURE_KIT_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_SCREEN_CAPTURE_KIT_ADAPTER_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

enum class CaptureErrorCode : std::uint8_t {
  kNone,
  kPermissionDenied,
  kEnumerationTimedOut,
  kEnumerationFailed,
  kNoPresentableDisplay,
  kInvalidDisplay,
  kStreamStartFailed,
  kFirstFrameTimedOut,
  kStreamStopped,
  kInvalidFrame,
};

struct CaptureError {
  CaptureErrorCode code = CaptureErrorCode::kNone;
  std::string detail;

  [[nodiscard]] bool IsError() const noexcept {
    return code != CaptureErrorCode::kNone;
  }
};

struct ScreenCaptureKitLimits {
  std::uint32_t enumeration_timeout_ms = 3'000;
  std::uint32_t stream_start_timeout_ms = 3'000;
  std::uint32_t first_frame_timeout_ms = 3'000;
  std::uint32_t stream_stop_timeout_ms = 2'000;
  std::uint32_t frame_rate = 30;
  std::uint32_t max_displays = 16;
  std::uint32_t max_pending_frames = 2;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct ScreenCaptureKitStatistics {
  std::uint64_t accepted_frames = 0;
  std::uint64_t dropped_backpressure_frames = 0;
  std::uint64_t rejected_invalid_frames = 0;
  std::uint64_t ignored_late_frames = 0;
  std::uint32_t pending_frames = 0;
};

// Backend-facing display data deliberately contains no Apple SDK types. This
// keeps ScreenCaptureKit, CoreGraphics and Objective-C ownership out of the
// common/native public headers and gives native tests a deterministic seam.
struct ScreenCaptureKitBackendDisplay {
  std::uint32_t native_display_id = 0;
  common::PixelSize encoded_pixels;
  common::LogicalRect logical_input_bounds;
  double scale = 1.0;
  common::DisplayRotation rotation = common::DisplayRotation::k0;
  bool cursor_supported = true;
};

struct ScreenCaptureKitStreamConfiguration {
  std::uint32_t native_display_id = 0;
  common::PixelSize encoded_pixels;
  std::uint32_t display_lookup_timeout_ms = 3'000;
  std::uint32_t frame_rate = 30;
  std::uint32_t max_pending_frames = 2;
  bool show_cursor = true;
};

using ScreenCaptureKitBackendFrameSink =
    std::function<void(common::CapturedFrame)>;
using ScreenCaptureKitBackendErrorSink = std::function<void(CaptureError)>;

class ScreenCaptureKitBackendStream {
 public:
  virtual ~ScreenCaptureKitBackendStream() = default;
  virtual bool Start(std::uint32_t timeout_ms, std::string* error) = 0;
  virtual bool WaitForFirstFrame(std::uint32_t timeout_ms,
                                 std::string* error) = 0;
  virtual void Stop(std::uint32_t timeout_ms) noexcept = 0;
};

class ScreenCaptureKitBackend {
 public:
  virtual ~ScreenCaptureKitBackend() = default;
  [[nodiscard]] virtual common::ReadinessState ProbeReadiness() noexcept = 0;
  virtual bool EnumerateDisplays(
      std::uint32_t timeout_ms,
      std::uint32_t max_displays,
      std::vector<ScreenCaptureKitBackendDisplay>* displays,
      CaptureError* error) = 0;
  virtual std::unique_ptr<ScreenCaptureKitBackendStream> CreateStream(
      const ScreenCaptureKitStreamConfiguration& configuration,
      ScreenCaptureKitBackendFrameSink frame_sink,
      ScreenCaptureKitBackendErrorSink error_sink,
      CaptureError* error) = 0;
};

/**
 * Creates the real ScreenCaptureKit backend.
 *
 * Exposed alongside `CreateCgDisplayStreamBackend` so the LaunchAgent
 * composition names the backend it wants explicitly. That matters at the login
 * window: which backend can see that surface depends on the running release,
 * and a caller that silently inherited a default would be making that decision
 * by omission.
 */
[[nodiscard]] std::unique_ptr<ScreenCaptureKitBackend>
CreateAppleScreenCaptureKitBackend();

// Implements the common capture/display interfaces for one active graphical
// user's ScreenCaptureKit session. It probes but never requests TCC access;
// permission onboarding remains an explicit local-product responsibility.
class ScreenCaptureKitAdapter final : public common::CaptureAdapter,
                                      public common::DisplayAdapter {
 public:
  explicit ScreenCaptureKitAdapter(
      common::WorkerGeneration worker_generation,
      ScreenCaptureKitLimits limits = {});
  ScreenCaptureKitAdapter(common::WorkerGeneration worker_generation,
                          std::unique_ptr<ScreenCaptureKitBackend> backend,
                          ScreenCaptureKitLimits limits = {});
  ~ScreenCaptureKitAdapter() override;

  ScreenCaptureKitAdapter(const ScreenCaptureKitAdapter&) = delete;
  ScreenCaptureKitAdapter& operator=(const ScreenCaptureKitAdapter&) = delete;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  [[nodiscard]] std::optional<common::DesktopTopology> EnumerateTopology()
      override;
  bool SelectDisplay(std::string_view display_id) override;
  bool SetMode(std::string_view display_id, common::PixelSize pixels) override;
  bool SetScale(std::string_view display_id, double scale) override;

  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) override;
  void Stop() noexcept override;

  [[nodiscard]] bool CursorCaptureSupported(
      std::string_view display_id) const noexcept;
  [[nodiscard]] CaptureError LastError() const;
  [[nodiscard]] ScreenCaptureKitStatistics Statistics() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_SCREEN_CAPTURE_KIT_ADAPTER_H_
