#ifndef IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_
#define IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_

#include <windows.h>

#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <string_view>

#include "third_party/imcodes_remote_desktop/common/input_ledger.h"
#include "third_party/imcodes_remote_desktop/common/platform_interfaces.h"
#include "third_party/imcodes_remote_desktop/display_capture.h"

namespace imcodes::rd {

namespace common = imcodes::remote_desktop::common;

using WindowsSendInputFn = std::function<UINT(UINT, LPINPUT, int)>;
using WindowsInputAvailableFn = std::function<bool()>;
using WindowsMovePointerFn = std::function<bool(int, int)>;

// Windows owns only native token mapping and the state that SendInput actually
// accepted. Controller identity, epochs, sequences, topology fencing and
// multi-controller reference counts stay exclusively in common::InputLedger.
class WindowsSendInputBackend final : public common::InputAdapter {
 public:
  explicit WindowsSendInputBackend(
      WindowsSendInputFn send_input = {},
      WindowsInputAvailableFn input_available = {},
      WindowsMovePointerFn move_pointer = {});
  ~WindowsSendInputBackend() override;

  WindowsSendInputBackend(const WindowsSendInputBackend&) = delete;
  WindowsSendInputBackend& operator=(const WindowsSendInputBackend&) = delete;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool MovePointer(const common::LogicalPoint& point) override;
  bool EmitKey(std::string_view key, bool pressed) override;
  bool EmitButton(std::string_view button, bool pressed) override;
  bool EmitWheel(double delta_x, double delta_y) override;
  bool EmitText(std::string_view text) override;
  void ReleaseAllEmittedState() noexcept override;

  // Legacy Windows v2 compatibility helpers. They never own controller state;
  // they only preserve native batching/repeat and retry semantics around the
  // transitions approved by InputLedger.
  [[nodiscard]] bool SupportsKey(std::string_view key) const;
  [[nodiscard]] bool SupportsButton(std::string_view button) const;
  bool PrepareKeyDown(std::string_view key);
  bool PrepareButtonDown(std::string_view button);
  bool EmitKeyRepeat(std::string_view key);
  bool EmitClick(std::string_view button);
  bool RetryPendingReleases() noexcept;
  [[nodiscard]] bool HasPendingReleases() const noexcept;
  [[nodiscard]] bool IsKeyEmitted(std::string_view key) const noexcept;
  [[nodiscard]] bool IsButtonEmitted(std::string_view button) const noexcept;

 private:
  bool Dispatch(INPUT* inputs, UINT count);
  bool SendKeyLocked(std::string_view key, bool pressed);
  bool SendButtonLocked(std::string_view button, bool pressed);
  bool ReleaseKeyLocked(const std::string& key) noexcept;
  bool ReleaseButtonLocked(const std::string& button) noexcept;

  const WindowsSendInputFn send_input_;
  const WindowsInputAvailableFn input_available_;
  const WindowsMovePointerFn move_pointer_;
  mutable std::mutex mutex_;
  std::set<std::string> emitted_keys_;
  std::set<std::string> emitted_buttons_;
  std::set<std::string> pending_key_releases_;
  std::set<std::string> pending_button_releases_;
};

// Compatibility facade consumed by the existing Windows v2 PeerSession. Its
// public methods keep their prior signatures and return values, but every
// ownership-bearing transition now passes through common::InputLedger.
class InputArbiter {
 public:
  using SendInputFn = WindowsSendInputFn;
  using InputAvailableFn = WindowsInputAvailableFn;
  using MovePointerFn = WindowsMovePointerFn;

  explicit InputArbiter(SendInputFn send_input = {},
                        InputAvailableFn input_available = {},
                        MovePointerFn move_pointer = {});
  ~InputArbiter();

  InputArbiter(const InputArbiter&) = delete;
  InputArbiter& operator=(const InputArbiter&) = delete;

  bool Available() const;
  bool KeyDown(const std::string& owner, const std::string& code, bool repeat);
  bool KeyUp(const std::string& owner, const std::string& code);
  bool ButtonDown(const std::string& owner, const std::string& button);
  bool ButtonUp(const std::string& owner, const std::string& button);
  bool Click(const std::string& button);
  bool Move(const DisplayInfo& display, double x, double y);
  bool Wheel(double delta_x, double delta_y);
  bool Text(const std::u16string& value);
  bool CopyShortcut(const std::string& owner);
  bool ReleaseOwner(const std::string& owner);
  bool RetryPendingReleases();
  void ReleaseAll() noexcept;

  // Stamped seam used by the cross-platform session core and native tests. It
  // proves the Windows backend consumes the common replay/topology authority
  // rather than reimplementing those rules in a second platform ledger.
  common::InputResult ApplyKeyStamped(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      std::string_view code, bool pressed, bool repeat = false);
  common::InputResult ApplyButtonStamped(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      std::string_view button, bool pressed);
  common::InputResult ApplyPointerStamped(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      const DisplayInfo& display, double x, double y);
  common::InputResult ApplyWheelStamped(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      double delta_x, double delta_y);
  common::InputResult ApplyTextStamped(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      std::string_view utf8_text);
  common::InputResult ReleaseControllerStamped(
      std::string_view controller_id) noexcept;

 private:
  struct LegacyStampState {
    common::InputEpoch epoch = 1;
    common::InputSequence sequence = 0;
  };

  common::InputStamp NextLegacyStamp(const std::string& owner);
  common::InputResult ApplyKeyStampedLocked(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      std::string_view code, bool pressed, bool repeat);
  common::InputResult ApplyButtonStampedLocked(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      std::string_view button, bool pressed);
  common::InputResult ApplyPointerStampedLocked(
      const common::InputStamp& stamp,
      common::TopologyRevision current_topology_revision,
      const DisplayInfo& display, double x, double y);

  mutable std::mutex mutex_;
  WindowsSendInputBackend backend_;
  common::InputLedger ledger_;
  std::map<std::string, LegacyStampState> legacy_stamps_;
};

// Crash-recovery path used by the service after the worker pipe disappears.
// It emits key/button-up only for the documented remote-input allowlist and
// carries no session, key history, credential, or user content.
bool ReleaseAllSupportedInput(InputArbiter::SendInputFn send_input = {});

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_INPUT_INJECTOR_H_
