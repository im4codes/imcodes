#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ADAPTER_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

struct MacosVirtualDisplayMode {
  common::PixelSize pixels;
  double scale = 1.0;
  double refresh_rate_hz = 60.0;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct MacosVirtualDisplayConfiguration {
  common::WorkerGeneration worker_generation = 0;
  std::string name = "aiDesk.to Virtual Display";
  std::uint32_t vendor_id = 0x4149;   // "AI"
  std::uint32_t product_id = 0x4445;  // "DE"
  std::uint32_t serial_number = 1;
  std::uint32_t online_timeout_ms = 5'000;
  std::vector<MacosVirtualDisplayMode> modes = {
      {{1920, 1080}, 1.0, 60.0}, {{2560, 1440}, 1.0, 60.0},
      {{3840, 2160}, 1.0, 60.0}, {{1920, 1080}, 2.0, 60.0},
      {{2560, 1440}, 2.0, 60.0},
  };

  [[nodiscard]] bool IsValid() const noexcept;
};

[[nodiscard]] std::uint32_t MacosVirtualDisplaySerialForGeneration(
    common::WorkerGeneration generation) noexcept;

// Owns the private CoreGraphics object behind a narrow, testable boundary.
// Implementations must retain the object until Destroy(), and Create/Apply
// must fail rather than infer that an undocumented runtime shape still works.
class MacosVirtualDisplayBackend {
 public:
  virtual ~MacosVirtualDisplayBackend() = default;
  [[nodiscard]] virtual common::ReadinessState ProbeSupport() noexcept = 0;
  virtual bool Create(const MacosVirtualDisplayConfiguration& configuration,
                      std::uint32_t* native_display_id,
                      std::string* error) = 0;
  virtual bool ApplyMode(std::uint32_t native_display_id,
                         const MacosVirtualDisplayMode& mode,
                         const std::vector<MacosVirtualDisplayMode>& modes,
                         std::string* error) = 0;
  virtual bool WaitUntilOnline(std::uint32_t native_display_id,
                               std::uint32_t timeout_ms,
                               std::string* error) = 0;
  virtual void Destroy() noexcept = 0;
};

using MacosVirtualDisplayCreationPredicate = std::function<bool()>;

// Decorates the ordinary ScreenCaptureKit display adapter. Physical displays
// remain untouched. If enumeration truthfully reports no presentable display,
// one generation-owned virtual display is created and then re-enumerated by
// the ordinary adapter; capture and input never receive synthetic topology.
class MacosVirtualDisplayAdapter final : public common::DisplayAdapter {
 public:
  MacosVirtualDisplayAdapter(
      common::DisplayAdapter& display,
      std::unique_ptr<MacosVirtualDisplayBackend> backend,
      MacosVirtualDisplayConfiguration configuration,
      MacosVirtualDisplayCreationPredicate should_create);
  ~MacosVirtualDisplayAdapter() override;

  MacosVirtualDisplayAdapter(const MacosVirtualDisplayAdapter&) = delete;
  MacosVirtualDisplayAdapter& operator=(const MacosVirtualDisplayAdapter&) =
      delete;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  [[nodiscard]] std::optional<common::DesktopTopology> EnumerateTopology()
      override;
  bool SelectDisplay(std::string_view display_id) override;
  bool SetMode(std::string_view display_id, common::PixelSize pixels) override;
  bool SetScale(std::string_view display_id, double scale) override;

  [[nodiscard]] common::ReadinessState ProbeVirtualDisplayReadiness() noexcept;
  [[nodiscard]] bool owns_virtual_display() const noexcept;
  [[nodiscard]] std::uint32_t native_virtual_display_id() const noexcept;
  [[nodiscard]] std::string virtual_display_id() const;
  [[nodiscard]] std::string last_error() const;
  void ReleaseVirtualDisplay() noexcept;

 private:
  [[nodiscard]] bool EnsureVirtualDisplay();
  [[nodiscard]] std::optional<common::DesktopTopology> DecorateTopology(
      std::optional<common::DesktopTopology> topology);
  [[nodiscard]] const MacosVirtualDisplayMode* FindMode(
      common::PixelSize pixels,
      double scale) const noexcept;

  common::DisplayAdapter& display_;
  std::unique_ptr<MacosVirtualDisplayBackend> backend_;
  MacosVirtualDisplayConfiguration configuration_;
  MacosVirtualDisplayCreationPredicate should_create_;
  std::uint32_t native_display_id_ = 0;
  MacosVirtualDisplayMode current_mode_;
  std::string display_id_;
  std::string last_error_;
};

[[nodiscard]] std::unique_ptr<MacosVirtualDisplayBackend>
CreateAppleMacosVirtualDisplayBackend();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_ADAPTER_H_
