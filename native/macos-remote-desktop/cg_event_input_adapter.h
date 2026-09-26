#ifndef IMCODES_MACOS_REMOTE_DESKTOP_CG_EVENT_INPUT_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_CG_EVENT_INPUT_ADAPTER_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include <string_view>

#include "../remote-desktop-common/latched_modifiers.h"
#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

// Stamped into kCGEventSourceUserData on every event this worker injects, so
// the local curtain's event tap can drop physical keyboard/mouse input while
// letting the remote controller's own events through.
inline constexpr std::int64_t kImcodesSyntheticEventMarker = 0x494D434F444553;

enum class CGEventInputErrorCode : std::uint8_t {
  kNone,
  kPermissionDenied,
  kInvalidTopology,
  kStaleTopology,
  kNoActiveTopology,
  kOutOfBounds,
  kUnsupportedInput,
  kEmissionFailed,
};

struct CGEventInputError {
  CGEventInputErrorCode code = CGEventInputErrorCode::kNone;
  std::string detail;

  [[nodiscard]] bool IsError() const noexcept {
    return code != CGEventInputErrorCode::kNone;
  }
};

enum class CGEventInputReleaseReason : std::uint8_t {
  kDowngrade,
  kDisconnect,
  kPermissionLoss,
  kUserChange,
  kAgentCrash,
  kShutdown,
};

struct CGEventInputStatistics {
  std::uint64_t emitted_pointer_moves = 0;
  std::uint64_t emitted_key_transitions = 0;
  std::uint64_t emitted_button_transitions = 0;
  std::uint64_t emitted_wheel_events = 0;
  std::uint64_t emitted_text_events = 0;
  std::uint64_t rejected_permission_events = 0;
  std::uint64_t rejected_topology_events = 0;
  std::uint64_t release_attempts = 0;
  std::uint64_t release_failures = 0;
  // Modifiers found latched by something other than this session and
  // released before it began.
  std::uint64_t released_latched_modifiers = 0;
  std::size_t emitted_keys = 0;
  std::size_t emitted_buttons = 0;
};

// Apple framework types remain in the production backend implementation. The
// injected seam is deliberately expressed only in common logical coordinates
// and validated browser tokens so lifecycle and stuck-input tests do not need
// TCC access or synthetic process-global CGEvents.
class CGEventInputBackend {
public:
  virtual ~CGEventInputBackend() = default;
  [[nodiscard]] virtual common::ReadinessState
  ProbeAccessibility() noexcept = 0;
  virtual bool MovePointer(const common::LogicalPoint &point) = 0;
  virtual bool EmitKey(std::string_view key, bool pressed) = 0;
  virtual bool EmitButton(std::string_view button, bool pressed) = 0;
  virtual bool EmitWheel(double delta_x, double delta_y) = 0;
  virtual bool EmitText(std::string_view text) = 0;
  // Modifier keys the window server still reports as held, whoever pressed
  // them. A key-up that never arrived -- a worker killed mid-press, a route
  // lost between a modifier's down and its up -- latches one until something
  // releases it or the Mac restarts, and on macOS a latched Control turns
  // every later click into a right-click. Named in this adapter's own key
  // vocabulary ("ControlLeft", ...).
  [[nodiscard]] virtual std::vector<std::string> LatchedModifierKeys() = 0;
};

// The CGEventFlags an injected event must carry. An event created without a
// source copies whatever the window server holds, so one latched modifier --
// Control/Shift/Option/Command, or the Fn (Globe) and numeric-pad state an
// arrow key leaves behind -- would turn every later letter into a shortcut
// (Fn+E opens the emoji picker). Nothing modifier-like is inherited:
//   - Control/Shift/Option/Command are exactly the modifiers this session
//     holds, named in the adapter's key vocabulary ("ShiftLeft", ...);
//   - Fn, numeric pad and Help are only what `key` itself carries on a real
//     keyboard (arrows: Fn + numeric pad; Home/End/Page/forward-Delete/Help
//     and F-keys: Fn; keypad keys: numeric pad). `key` is empty for mouse,
//     wheel and text events, which carry none;
//   - Caps Lock and every other bit are kept.
[[nodiscard]] std::uint64_t ComposeInjectedModifierFlags(
    std::uint64_t event_flags,
    const std::vector<std::string> &held_modifier_keys,
    std::string_view key) noexcept;

// Input ownership, epochs, sequence fencing and controller reference counts
// stay in common::InputLedger. This class is only the platform emission seam:
// it accepts ledger-approved transitions, verifies the active logical topology
// and records exactly the OS states it successfully emitted so terminal cleanup
// can release them once without guessing every possible key.
class CGEventInputAdapter final : public common::InputAdapter {
public:
  explicit CGEventInputAdapter(common::WorkerGeneration worker_generation);
  CGEventInputAdapter(common::WorkerGeneration worker_generation,
                      std::unique_ptr<CGEventInputBackend> backend);
  ~CGEventInputAdapter() override;

  CGEventInputAdapter(const CGEventInputAdapter &) = delete;
  CGEventInputAdapter &operator=(const CGEventInputAdapter &) = delete;

  // Binds one current display from a complete generation-scoped topology. A
  // lower revision or an equivocal reuse of the same revision is rejected.
  bool BindTopology(const common::DesktopTopology &topology,
                    std::string_view display_id);

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool MovePointer(const common::LogicalPoint &point) override;
  bool EmitKey(std::string_view key, bool pressed) override;
  bool EmitButton(std::string_view button, bool pressed) override;
  bool EmitWheel(double delta_x, double delta_y) override;
  bool EmitText(std::string_view text) override;
  // Emit one bounded Command-C/Command-V chord under the same topology,
  // Accessibility, state-tracking and release guarantees as ordinary input.
  // The absolute deadline comes from the clipboard operation that requested
  // the explicit action.
  bool EmitClipboardShortcut(std::string_view key,
                             std::uint64_t deadline_monotonic_ms);
  void ReleaseAllEmittedState() noexcept override;
  // Releases modifiers the window server holds that this adapter never
  // emitted. The common ledger calls it before every non-modifier press so a
  // latched modifier heals mid-session instead of until the next session.
  std::size_t ReleaseLatchedModifiers() noexcept override;

  // Session/authority owners call this on every named terminal boundary. It
  // releases emitted state idempotently and clears topology so later input
  // requires a fresh, current binding.
  void HandleLifecycleBoundary(CGEventInputReleaseReason reason) noexcept;

  [[nodiscard]] common::TopologyRevision topology_revision() const noexcept;
  [[nodiscard]] CGEventInputError LastError() const;
  [[nodiscard]] CGEventInputStatistics Statistics() const;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_CG_EVENT_INPUT_ADAPTER_H_
