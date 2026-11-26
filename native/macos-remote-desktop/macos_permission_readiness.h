#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_READINESS_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_READINESS_H_

#include <cstdint>
#include <memory>

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::macos {

enum class MacosPermissionKind : std::uint8_t {
  kScreenRecording,
  kAccessibility,
};

enum class MacosPermissionActionOrigin : std::uint8_t {
  kUnknown,
  kLocalExplicit,
  kRemoteProtocol,
};

enum class MacosPermissionActionType : std::uint8_t {
  kOpenSettingsAndReprobe,
  kReprobe,
};

struct MacosPermissionReadinessSnapshot {
  common::WorkerGeneration worker_generation = 0;
  std::uint64_t observation_sequence = 0;
  std::uint64_t observed_at_monotonic_ms = 0;
  std::uint64_t valid_until_monotonic_ms = 0;
  common::ReadinessState screen_recording = common::ReadinessState::kUnknown;
  common::ReadinessState accessibility = common::ReadinessState::kUnknown;

  [[nodiscard]] bool IsFreshFor(common::WorkerGeneration expected_generation,
                                std::uint64_t now_monotonic_ms) const noexcept;
};

struct MacosPermissionActionRequest {
  MacosPermissionActionOrigin origin = MacosPermissionActionOrigin::kUnknown;
  MacosPermissionActionType type = MacosPermissionActionType::kReprobe;
  MacosPermissionKind permission = MacosPermissionKind::kScreenRecording;
  common::WorkerGeneration expected_worker_generation = 0;
  std::uint64_t expected_observation_sequence = 0;
};

enum class MacosPermissionActionResultCode : std::uint8_t {
  kCompleted,
  kRejectedNonLocal,
  kStaleGeneration,
  kStaleObservation,
  kStaleSnapshot,
  kUnsupportedAction,
  kOpenSettingsFailed,
};

struct MacosPermissionActionResult {
  MacosPermissionActionResultCode code =
      MacosPermissionActionResultCode::kUnsupportedAction;
  MacosPermissionReadinessSnapshot snapshot;

  [[nodiscard]] bool completed() const noexcept {
    return code == MacosPermissionActionResultCode::kCompleted;
  }
};

struct MacosPermissionReadinessConfig {
  // Permission observations are deliberately short lived. The implementation
  // clamps this value so a caller cannot turn one successful probe into
  // long-lived authority.
  std::uint64_t freshness_window_ms = 2'000;
};

// The production implementation keeps all Apple framework types behind this
// seam. Probes MUST be non-interactive: implementations may inspect current
// TCC state but must never request or approve permission.
class MacosPermissionReadinessBackend {
public:
  virtual ~MacosPermissionReadinessBackend() = default;
  [[nodiscard]] virtual std::uint64_t NowMonotonicMs() noexcept = 0;
  [[nodiscard]] virtual common::ReadinessState
  ProbeScreenRecording() noexcept = 0;
  [[nodiscard]] virtual common::ReadinessState
  ProbeAccessibility() noexcept = 0;
  virtual bool OpenSystemSettings(MacosPermissionKind permission) noexcept = 0;
};

std::unique_ptr<MacosPermissionReadinessBackend>
CreateMacosPermissionReadinessBackend();

class MacosPermissionReadiness final {
public:
  explicit MacosPermissionReadiness(common::WorkerGeneration worker_generation,
                                    MacosPermissionReadinessConfig config = {});
  MacosPermissionReadiness(
      common::WorkerGeneration worker_generation,
      std::unique_ptr<MacosPermissionReadinessBackend> backend,
      MacosPermissionReadinessConfig config = {});
  ~MacosPermissionReadiness();

  MacosPermissionReadiness(const MacosPermissionReadiness &) = delete;
  MacosPermissionReadiness &
  operator=(const MacosPermissionReadiness &) = delete;

  // Safe for status callers, including remote diagnostics: this only performs
  // non-interactive probes and can never open Settings or request TCC grants.
  [[nodiscard]] MacosPermissionReadinessSnapshot Probe();

  // Settings navigation is accepted only from a fresh, generation-bound local
  // action. Remote/protocol origins are rejected before touching the backend.
  [[nodiscard]] MacosPermissionActionResult
  HandleLocalAction(const MacosPermissionActionRequest &request);

  // A worker restart/user-session transition must advance the generation.
  // Advancing invalidates every observation/action issued by the old worker.
  bool AdvanceGeneration(common::WorkerGeneration worker_generation);

  [[nodiscard]] MacosPermissionReadinessSnapshot CurrentSnapshot() const;

  // Applies only fresh permission evidence to a broader readiness record.
  // Unknown, unsupported, expired or generation-invalid states fail closed.
  [[nodiscard]] common::CapabilityReadiness
  ApplyTo(common::CapabilityReadiness readiness);

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace imcodes::remote_desktop::macos

#endif // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_PERMISSION_READINESS_H_
