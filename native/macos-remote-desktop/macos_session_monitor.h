#ifndef IMCODES_REMOTE_DESKTOP_MACOS_SESSION_MONITOR_H_
#define IMCODES_REMOTE_DESKTOP_MACOS_SESSION_MONITOR_H_

#include <cstdint>
#include <functional>
#include <memory>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

using MacosSessionEventSink =
    std::function<void(common::GraphicalSessionEvent, std::uint64_t)>;

class MacosSessionMonitorBackend {
public:
  virtual ~MacosSessionMonitorBackend() = default;
  [[nodiscard]] virtual common::ReadinessState ProbeReadiness() = 0;
  virtual bool Start(std::uint64_t generation,
                     MacosSessionEventSink event_sink) = 0;
  virtual void Stop() noexcept = 0;
};

// Active-user LaunchAgent observer. Notifications from an older registration
// generation are ignored after Stop/Start so they cannot revive stale routes.
class MacosSessionMonitor final : public common::SessionMonitor {
public:
  MacosSessionMonitor();
  explicit MacosSessionMonitor(
      std::unique_ptr<MacosSessionMonitorBackend> backend);
  ~MacosSessionMonitor() override;

  MacosSessionMonitor(const MacosSessionMonitor &) = delete;
  MacosSessionMonitor &operator=(const MacosSessionMonitor &) = delete;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Start(Observer observer) override;
  void Stop() noexcept override;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_REMOTE_DESKTOP_MACOS_SESSION_MONITOR_H_
