#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_DISCLOSURE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_DISCLOSURE_H_

#include <cstdint>
#include <functional>
#include <memory>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

inline constexpr std::uint32_t kMacosDisclosureMaxViewers = 64;
inline constexpr std::uint32_t kMacosDisclosureMaxControllers = 64;

struct MacosLocalDisclosureOptions {
  std::uint32_t max_viewers = kMacosDisclosureMaxViewers;
  std::uint32_t max_controllers = kMacosDisclosureMaxControllers;
};

enum class MacosDisclosureEvent : std::uint8_t {
  kLocalStop,
  kWindowClosed,
  kWindowFailed,
};

using MacosDisclosureEventSink =
    std::function<void(MacosDisclosureEvent, std::uint64_t)>;
using MacosDisclosureStopAllRoutes = std::function<void(std::uint64_t)>;

// Project-owned seam around AppKit. The only remotely influenced values are
// bounded counts. Branding, explanatory copy, controls and window policy are
// wholly owned by the production backend.
class MacosLocalDisclosureBackend {
public:
  virtual ~MacosLocalDisclosureBackend() = default;
  [[nodiscard]] virtual common::ReadinessState ProbeReadiness() noexcept = 0;
  virtual bool Show(std::uint32_t viewers, std::uint32_t controllers,
                    std::uint64_t generation,
                    MacosDisclosureEventSink event_sink) noexcept = 0;
  virtual void Hide() noexcept = 0;
};

class MacosLocalDisclosureAdapter final : public common::DisclosureAdapter {
public:
  explicit MacosLocalDisclosureAdapter(
      MacosDisclosureStopAllRoutes stop_all_routes,
      MacosLocalDisclosureOptions options = {});
  MacosLocalDisclosureAdapter(
      std::unique_ptr<MacosLocalDisclosureBackend> backend,
      MacosDisclosureStopAllRoutes stop_all_routes,
      MacosLocalDisclosureOptions options = {});
  ~MacosLocalDisclosureAdapter() override;

  MacosLocalDisclosureAdapter(const MacosLocalDisclosureAdapter &) = delete;
  MacosLocalDisclosureAdapter &
  operator=(const MacosLocalDisclosureAdapter &) = delete;

  // The trusted active-user session owner supplies a monotonically increasing
  // worker generation before any route can be admitted. A disclosure is not
  // ready until Show has synchronously confirmed a visible local window.
  bool BeginSession(std::uint64_t generation);
  void ReportProcessCrash(std::uint64_t generation) noexcept;
  [[nodiscard]] bool IsVisible() const noexcept;
  [[nodiscard]] std::uint64_t generation() const noexcept;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override;
  void Hide() noexcept override;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

// Narrow control-flow seam for the production disclosure main.
//
// The OLD production code called ProbeReadiness BEFORE Show. BeginSession
// leaves visible=false and Show is the only call that flips visible=true;
// a pre-Show ProbeReadiness therefore returned kUnavailable unconditionally
// and the disclosure was unreachable (the process exited EX_UNAVAILABLE before
// any window was created). RunDisclosureStartup enforces the correct
// BeginSession -> Show -> IsVisible/ProbeReadiness order so the production
// main and tests share one ordering and the seam itself is the load-bearing
// invariant.
//
// Outcomes:
//   kVisibleAndReady    — BeginSession succeeded, Show succeeded, IsVisible
//                         and ProbeReadiness both confirmed a live window.
//   kBeginSessionFailed — BeginSession refused (dead state, stale generation,
//                         or missing stop callback).
//   kShowFailed         — bounds rejected, backend refused, or the adapter
//                         became dead before the window opened.
//   kNotVisible         — Show reported success but the adapter does not see
//                         the window (AppKit failure path).
//   kReadinessLost      — Show succeeded and IsVisible was true but the
//                         backend's readiness probe went away before the
//                         confirmation step completed.
enum class DisclosureStartupOutcome : std::uint8_t {
  kVisibleAndReady,
  kBeginSessionFailed,
  kShowFailed,
  kNotVisible,
  kReadinessLost,
};

[[nodiscard]] DisclosureStartupOutcome RunDisclosureStartup(
    MacosLocalDisclosureAdapter& adapter,
    std::uint64_t generation,
    std::uint32_t viewers,
    std::uint32_t controllers) noexcept;

// Process-level continuation seam used directly by the production executable.
// It owns the fail-closed outcome gate: every failed startup emits Failed and
// returns EX_UNAVAILABLE before Ready or the visible event loop can run.
struct DisclosureProcessCallbacks {
  std::function<bool(std::uint64_t)> emit_ready;
  std::function<void(std::uint64_t)> emit_failed;
  std::function<void()> report_probe_success;
  std::function<int()> run_visible_loop;
};

[[nodiscard]] int RunDisclosureProcessAfterStartup(
    DisclosureStartupOutcome outcome,
    std::uint64_t generation,
    bool probe_only,
    MacosLocalDisclosureAdapter& adapter,
    DisclosureProcessCallbacks callbacks);

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_LOCAL_DISCLOSURE_H_
