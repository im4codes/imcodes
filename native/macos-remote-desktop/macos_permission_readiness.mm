#include "macos_permission_readiness.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <chrono>
#include <limits>
#include <mutex>
#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint64_t kMinimumFreshnessWindowMs = 100;
constexpr std::uint64_t kMaximumFreshnessWindowMs = 10'000;

common::ReadinessState
NormalizeProbeState(common::ReadinessState state) noexcept {
  switch (state) {
  case common::ReadinessState::kReady:
  case common::ReadinessState::kUnavailable:
  case common::ReadinessState::kUnknown:
    return state;
  }
  return common::ReadinessState::kUnknown;
}

std::uint64_t AddBounded(std::uint64_t value, std::uint64_t delta) noexcept {
  if (value > std::numeric_limits<std::uint64_t>::max() - delta) {
    return value;
  }
  return value + delta;
}

class ApplePermissionReadinessBackend final
    : public MacosPermissionReadinessBackend {
public:
  std::uint64_t NowMonotonicMs() noexcept override {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
  }

  common::ReadinessState ProbeScreenRecording() noexcept override {
    if (@available(macOS 10.15, *)) {
      // CGRequestScreenCaptureAccess is intentionally never called here. A
      // status probe cannot coerce the local user into a TCC prompt.
      return CGPreflightScreenCaptureAccess()
                 ? common::ReadinessState::kReady
                 : common::ReadinessState::kUnavailable;
    }
    return common::ReadinessState::kUnknown;
  }

  common::ReadinessState ProbeAccessibility() noexcept override {
    // AXIsProcessTrustedWithOptions can request a prompt. Use the
    // non-interactive form exclusively.
    return AXIsProcessTrusted() ? common::ReadinessState::kReady
                                : common::ReadinessState::kUnavailable;
  }

  bool OpenSystemSettings(MacosPermissionKind permission) noexcept override {
    @autoreleasepool {
      NSString *url_string = nil;
      switch (permission) {
      case MacosPermissionKind::kScreenRecording:
        url_string = @"x-apple.systempreferences:com.apple.preference.security?"
                     @"Privacy_ScreenCapture";
        break;
      case MacosPermissionKind::kAccessibility:
        url_string = @"x-apple.systempreferences:com.apple.preference.security?"
                     @"Privacy_Accessibility";
        break;
      default:
        return false;
      }
      NSURL *url = [NSURL URLWithString:url_string];
      return url != nil && [[NSWorkspace sharedWorkspace] openURL:url];
    }
  }
};

} // namespace

bool MacosPermissionReadinessSnapshot::IsFreshFor(
    common::WorkerGeneration expected_generation,
    std::uint64_t now_monotonic_ms) const noexcept {
  return expected_generation != 0 && worker_generation == expected_generation &&
         observation_sequence != 0 &&
         observed_at_monotonic_ms <= now_monotonic_ms &&
         now_monotonic_ms <= valid_until_monotonic_ms;
}

std::unique_ptr<MacosPermissionReadinessBackend>
CreateMacosPermissionReadinessBackend() {
  return std::make_unique<ApplePermissionReadinessBackend>();
}

class MacosPermissionReadiness::Impl final {
public:
  Impl(common::WorkerGeneration worker_generation,
       std::unique_ptr<MacosPermissionReadinessBackend> backend,
       MacosPermissionReadinessConfig config)
      : worker_generation_(worker_generation), backend_(std::move(backend)) {
    freshness_window_ms_ =
        std::clamp(config.freshness_window_ms, kMinimumFreshnessWindowMs,
                   kMaximumFreshnessWindowMs);
  }

  MacosPermissionReadinessSnapshot Probe() {
    std::lock_guard lock(mutex_);
    return ProbeLocked();
  }

  MacosPermissionActionResult
  HandleLocalAction(const MacosPermissionActionRequest &request) {
    std::lock_guard lock(mutex_);
    if (request.origin != MacosPermissionActionOrigin::kLocalExplicit) {
      return Result(MacosPermissionActionResultCode::kRejectedNonLocal);
    }
    if (worker_generation_ == 0 ||
        request.expected_worker_generation != worker_generation_) {
      return Result(MacosPermissionActionResultCode::kStaleGeneration);
    }
    if (request.expected_observation_sequence == 0 ||
        request.expected_observation_sequence !=
            snapshot_.observation_sequence) {
      return Result(MacosPermissionActionResultCode::kStaleObservation);
    }
    const std::uint64_t now = backend_ ? backend_->NowMonotonicMs() : 0;
    if (!snapshot_.IsFreshFor(worker_generation_, now)) {
      return Result(MacosPermissionActionResultCode::kStaleSnapshot);
    }

    switch (request.type) {
    case MacosPermissionActionType::kReprobe:
      return {MacosPermissionActionResultCode::kCompleted, ProbeLocked()};
    case MacosPermissionActionType::kOpenSettingsAndReprobe:
      if (!backend_ || !backend_->OpenSystemSettings(request.permission)) {
        return Result(MacosPermissionActionResultCode::kOpenSettingsFailed);
      }
      return {MacosPermissionActionResultCode::kCompleted, ProbeLocked()};
    default:
      return Result(MacosPermissionActionResultCode::kUnsupportedAction);
    }
  }

  bool AdvanceGeneration(common::WorkerGeneration worker_generation) {
    std::lock_guard lock(mutex_);
    if (worker_generation == 0 || worker_generation <= worker_generation_) {
      return false;
    }
    worker_generation_ = worker_generation;
    snapshot_ = {};
    snapshot_.worker_generation = worker_generation_;
    return true;
  }

  MacosPermissionReadinessSnapshot CurrentSnapshot() const {
    std::lock_guard lock(mutex_);
    return snapshot_;
  }

  common::CapabilityReadiness ApplyTo(common::CapabilityReadiness readiness) {
    std::lock_guard lock(mutex_);
    const std::uint64_t now = backend_ ? backend_->NowMonotonicMs() : 0;
    if (!snapshot_.IsFreshFor(worker_generation_, now)) {
      readiness.capture = common::ReadinessState::kUnavailable;
      readiness.input = common::ReadinessState::kUnavailable;
      return readiness;
    }

    readiness.capture =
        snapshot_.screen_recording == common::ReadinessState::kReady
            ? common::ReadinessState::kReady
            : common::ReadinessState::kUnavailable;
    readiness.input =
        readiness.capture == common::ReadinessState::kReady &&
                snapshot_.accessibility == common::ReadinessState::kReady
            ? common::ReadinessState::kReady
            : common::ReadinessState::kUnavailable;
    return readiness;
  }

private:
  MacosPermissionReadinessSnapshot ProbeLocked() {
    MacosPermissionReadinessSnapshot next;
    next.worker_generation = worker_generation_;
    if (!backend_ || worker_generation_ == 0) {
      snapshot_ = next;
      return snapshot_;
    }

    const std::uint64_t now = backend_->NowMonotonicMs();
    next.observation_sequence = ++observation_sequence_;
    next.observed_at_monotonic_ms = now;
    next.valid_until_monotonic_ms = AddBounded(now, freshness_window_ms_);
    next.screen_recording =
        NormalizeProbeState(backend_->ProbeScreenRecording());
    next.accessibility = NormalizeProbeState(backend_->ProbeAccessibility());
    snapshot_ = next;
    return snapshot_;
  }

  MacosPermissionActionResult
  Result(MacosPermissionActionResultCode code) const {
    return {code, snapshot_};
  }

  mutable std::mutex mutex_;
  common::WorkerGeneration worker_generation_ = 0;
  std::unique_ptr<MacosPermissionReadinessBackend> backend_;
  std::uint64_t freshness_window_ms_ = kMinimumFreshnessWindowMs;
  std::uint64_t observation_sequence_ = 0;
  MacosPermissionReadinessSnapshot snapshot_;
};

MacosPermissionReadiness::MacosPermissionReadiness(
    common::WorkerGeneration worker_generation,
    MacosPermissionReadinessConfig config)
    : MacosPermissionReadiness(
          worker_generation, CreateMacosPermissionReadinessBackend(), config) {}

MacosPermissionReadiness::MacosPermissionReadiness(
    common::WorkerGeneration worker_generation,
    std::unique_ptr<MacosPermissionReadinessBackend> backend,
    MacosPermissionReadinessConfig config)
    : impl_(std::make_unique<Impl>(worker_generation, std::move(backend),
                                   config)) {}

MacosPermissionReadiness::~MacosPermissionReadiness() = default;

MacosPermissionReadinessSnapshot MacosPermissionReadiness::Probe() {
  return impl_->Probe();
}

MacosPermissionActionResult MacosPermissionReadiness::HandleLocalAction(
    const MacosPermissionActionRequest &request) {
  return impl_->HandleLocalAction(request);
}

bool MacosPermissionReadiness::AdvanceGeneration(
    common::WorkerGeneration worker_generation) {
  return impl_->AdvanceGeneration(worker_generation);
}

MacosPermissionReadinessSnapshot
MacosPermissionReadiness::CurrentSnapshot() const {
  return impl_->CurrentSnapshot();
}

common::CapabilityReadiness
MacosPermissionReadiness::ApplyTo(common::CapabilityReadiness readiness) {
  return impl_->ApplyTo(readiness);
}

} // namespace imcodes::remote_desktop::macos
