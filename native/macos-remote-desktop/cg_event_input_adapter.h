#ifndef IMCODES_MACOS_REMOTE_DESKTOP_CG_EVENT_INPUT_ADAPTER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_CG_EVENT_INPUT_ADAPTER_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include "../remote-desktop-common/platform_interfaces.h"

namespace imcodes::remote_desktop::macos {

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
};

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
  void ReleaseAllEmittedState() noexcept override;

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
