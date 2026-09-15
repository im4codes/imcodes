#ifndef IMCODES_REMOTE_DESKTOP_COMMON_SESSION_CORE_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_SESSION_CORE_H_

#include <optional>
#include <string>
#include <string_view>

#include "input_ledger.h"
#include "platform_interfaces.h"

namespace imcodes::remote_desktop::common {

struct PointerMove {
  InputStamp stamp;
  std::string display_id;
  double normalized_x = 0.0;
  double normalized_y = 0.0;
};

struct KeyTransition {
  InputStamp stamp;
  std::string key;
  bool pressed = false;
};

struct ButtonTransition {
  InputStamp stamp;
  std::string button;
  bool pressed = false;
};

struct WheelInput {
  InputStamp stamp;
  double delta_x = 0.0;
  double delta_y = 0.0;
};

struct TextInput {
  InputStamp stamp;
  std::string text;
};

class SessionCore {
 public:
  explicit SessionCore(PlatformAdapters adapters);
  ~SessionCore();

  SessionCore(const SessionCore&) = delete;
  SessionCore& operator=(const SessionCore&) = delete;

  bool Start(CapabilityReadiness readiness, DesktopTopology topology);
  bool UpdateReadiness(CapabilityReadiness readiness);
  bool UpdateTopology(DesktopTopology topology);
  bool SetControlActive(bool active);

  InputResult ApplyPointerMove(const PointerMove& move);
  InputResult ApplyKey(const KeyTransition& transition);
  InputResult ApplyButton(const ButtonTransition& transition);
  InputResult ClickButton(const ButtonTransition& transition);
  InputResult ApplyWheel(const WheelInput& input);
  InputResult ApplyText(const TextInput& input);

  void ReleaseController(std::string_view controller_id) noexcept;
  void ReportAdapterFailure(TerminalError error) noexcept;
  void Stop(TerminalError error) noexcept;

  [[nodiscard]] SessionState state() const noexcept { return state_; }
  [[nodiscard]] const CapabilityReadiness& readiness() const noexcept {
    return readiness_;
  }
  [[nodiscard]] const DesktopTopology* topology() const noexcept {
    return topology_ ? &*topology_ : nullptr;
  }
  [[nodiscard]] const TerminalError& terminal_error() const noexcept {
    return terminal_error_;
  }

 private:
  InputResult EnsureControlAvailable() const noexcept;
  InputResult HandleLedgerResult(InputResult result,
                                 std::string_view operation);
  void ReleaseAllControllers() noexcept;
  void StopPlatformResources() noexcept;

  PlatformAdapters adapters_;
  InputLedger input_ledger_;
  SessionState state_ = SessionState::kIdle;
  CapabilityReadiness readiness_;
  std::optional<DesktopTopology> topology_;
  TerminalError terminal_error_;
  bool resources_stopped_ = false;
};

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_SESSION_CORE_H_
