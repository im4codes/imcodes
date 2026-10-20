#include <cstdint>
#include <iostream>
#include <memory>

#include "macos_permission_readiness.h"

namespace macos = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
  }
  return condition;
}

class FakeBackend final : public macos::MacosPermissionReadinessBackend {
public:
  std::uint64_t now = 1'000;
  common::ReadinessState screen = common::ReadinessState::kUnavailable;
  common::ReadinessState accessibility = common::ReadinessState::kUnavailable;
  int screen_probes = 0;
  int accessibility_probes = 0;
  int settings_opens = 0;
  macos::MacosPermissionKind last_opened =
      macos::MacosPermissionKind::kScreenRecording;
  bool open_result = true;
  bool grant_screen_on_open = false;
  bool grant_accessibility_on_open = false;

  std::uint64_t NowMonotonicMs() noexcept override { return now; }

  common::ReadinessState ProbeScreenRecording() noexcept override {
    ++screen_probes;
    return screen;
  }

  common::ReadinessState ProbeAccessibility() noexcept override {
    ++accessibility_probes;
    return accessibility;
  }

  bool
  OpenSystemSettings(macos::MacosPermissionKind permission) noexcept override {
    ++settings_opens;
    last_opened = permission;
    if (open_result) {
      if (grant_screen_on_open) {
        screen = common::ReadinessState::kReady;
      }
      if (grant_accessibility_on_open) {
        accessibility = common::ReadinessState::kReady;
      }
    }
    return open_result;
  }
};

struct Fixture {
  std::unique_ptr<FakeBackend> owned = std::make_unique<FakeBackend>();
  FakeBackend *fake = owned.get();
  macos::MacosPermissionReadiness readiness{
      7, std::move(owned), {.freshness_window_ms = 250}};
};

common::CapabilityReadiness OtherwiseReady() {
  common::CapabilityReadiness readiness;
  readiness.capture = common::ReadinessState::kReady;
  readiness.encoder = common::ReadinessState::kReady;
  readiness.input = common::ReadinessState::kReady;
  readiness.clipboard = common::ReadinessState::kReady;
  readiness.display = common::ReadinessState::kReady;
  readiness.disclosure = common::ReadinessState::kReady;
  readiness.graphical_session = common::ReadinessState::kReady;
  return readiness;
}

macos::MacosPermissionActionRequest
LocalAction(const macos::MacosPermissionReadinessSnapshot &snapshot,
            macos::MacosPermissionKind permission,
            macos::MacosPermissionActionType type =
                macos::MacosPermissionActionType::kOpenSettingsAndReprobe) {
  return {.origin = macos::MacosPermissionActionOrigin::kLocalExplicit,
          .type = type,
          .permission = permission,
          .expected_worker_generation = snapshot.worker_generation,
          .expected_observation_sequence = snapshot.observation_sequence};
}

bool TestSeparateTruthfulStatesAndCapabilityDowngrade() {
  Fixture fixture;
  auto snapshot = fixture.readiness.Probe();
  auto effective = fixture.readiness.ApplyTo(OtherwiseReady());
  if (!Check(snapshot.screen_recording ==
                     common::ReadinessState::kUnavailable &&
                 snapshot.accessibility == common::ReadinessState::kUnavailable,
             "first probe must preserve both denied states") ||
      !Check(!effective.ViewReady() && !effective.ControlReady(),
             "missing Screen Recording must advertise no View or Control")) {
    return false;
  }

  fixture.fake->screen = common::ReadinessState::kReady;
  snapshot = fixture.readiness.Probe();
  effective = fixture.readiness.ApplyTo(OtherwiseReady());
  if (!Check(snapshot.screen_recording == common::ReadinessState::kReady &&
                 snapshot.accessibility == common::ReadinessState::kUnavailable,
             "partial grant must remain separately observable") ||
      !Check(effective.ViewReady() && !effective.ControlReady(),
             "capture-only grant must advertise View-only")) {
    return false;
  }

  fixture.fake->accessibility = common::ReadinessState::kReady;
  snapshot = fixture.readiness.Probe();
  effective = fixture.readiness.ApplyTo(OtherwiseReady());
  return Check(snapshot.screen_recording == common::ReadinessState::kReady &&
                   snapshot.accessibility == common::ReadinessState::kReady,
               "full grant must preserve both ready states") &&
         Check(effective.ViewReady() && effective.ControlReady(),
               "both grants may enable Control when all other readiness is "
               "true") &&
         Check(fixture.fake->settings_opens == 0,
               "probing must never open Settings or prompt");
}

bool TestUnknownAndExpiredEvidenceFailClosed() {
  Fixture fixture;
  fixture.fake->screen = common::ReadinessState::kUnknown;
  fixture.fake->accessibility = common::ReadinessState::kReady;
  const auto snapshot = fixture.readiness.Probe();
  auto effective = fixture.readiness.ApplyTo(OtherwiseReady());
  if (!Check(snapshot.screen_recording == common::ReadinessState::kUnknown,
             "unknown Screen Recording state must remain truthful") ||
      !Check(!effective.ViewReady() && !effective.ControlReady(),
             "unknown capture state must fail closed")) {
    return false;
  }

  fixture.fake->screen = common::ReadinessState::kReady;
  const auto refreshed = fixture.readiness.Probe();
  (void)refreshed;
  fixture.fake->now += 251;
  effective = fixture.readiness.ApplyTo(OtherwiseReady());
  return Check(!effective.ViewReady() && !effective.ControlReady(),
               "expired permission evidence must not retain authority");
}

bool TestOnlyFreshLocalActionsCanOpenSettings() {
  Fixture fixture;
  const auto snapshot = fixture.readiness.Probe();
  auto remote =
      LocalAction(snapshot, macos::MacosPermissionKind::kScreenRecording);
  remote.origin = macos::MacosPermissionActionOrigin::kRemoteProtocol;
  const auto remote_result = fixture.readiness.HandleLocalAction(remote);
  if (!Check(
          remote_result.code ==
                  macos::MacosPermissionActionResultCode::kRejectedNonLocal &&
              fixture.fake->settings_opens == 0,
          "remote protocol input must not open Settings")) {
    return false;
  }

  auto unknown = remote;
  unknown.origin = macos::MacosPermissionActionOrigin::kUnknown;
  if (!Check(
          fixture.readiness.HandleLocalAction(unknown).code ==
                  macos::MacosPermissionActionResultCode::kRejectedNonLocal &&
              fixture.fake->settings_opens == 0,
          "unknown action provenance must fail closed")) {
    return false;
  }

  fixture.fake->grant_screen_on_open = true;
  const auto local_result = fixture.readiness.HandleLocalAction(
      LocalAction(snapshot, macos::MacosPermissionKind::kScreenRecording));
  return Check(
             local_result.completed() && fixture.fake->settings_opens == 1 &&
                 fixture.fake->last_opened ==
                     macos::MacosPermissionKind::kScreenRecording,
             "fresh local action must open only the requested Settings pane") &&
         Check(local_result.snapshot.screen_recording ==
                       common::ReadinessState::kReady &&
                   local_result.snapshot.accessibility ==
                       common::ReadinessState::kUnavailable,
               "accepted local action must re-probe without synthesizing the "
               "other grant");
}

bool TestStaleGenerationAndObservationCannotWidenReadiness() {
  Fixture fixture;
  const auto old_snapshot = fixture.readiness.Probe();
  fixture.fake->screen = common::ReadinessState::kReady;
  const auto current_snapshot = fixture.readiness.Probe();

  const auto stale_observation = fixture.readiness.HandleLocalAction(
      LocalAction(old_snapshot, macos::MacosPermissionKind::kScreenRecording));
  if (!Check(
          stale_observation.code ==
                  macos::MacosPermissionActionResultCode::kStaleObservation &&
              fixture.fake->settings_opens == 0,
          "superseded local observation must not open Settings")) {
    return false;
  }

  if (!Check(fixture.readiness.AdvanceGeneration(8),
             "new worker generation must invalidate old permission evidence")) {
    return false;
  }
  const auto stale_generation = fixture.readiness.HandleLocalAction(LocalAction(
      current_snapshot, macos::MacosPermissionKind::kAccessibility));
  return Check(
             stale_generation.code ==
                     macos::MacosPermissionActionResultCode::kStaleGeneration &&
                 fixture.fake->settings_opens == 0,
             "old generation action must not open Settings") &&
         Check(!fixture.readiness.AdvanceGeneration(8) &&
                   !fixture.readiness.AdvanceGeneration(7),
               "generation must advance monotonically");
}

bool TestExpiredAndFailedLocalActionsDoNotSynthesizeReadiness() {
  Fixture fixture;
  auto snapshot = fixture.readiness.Probe();
  fixture.fake->now += 251;
  const auto expired = fixture.readiness.HandleLocalAction(
      LocalAction(snapshot, macos::MacosPermissionKind::kAccessibility));
  if (!Check(expired.code ==
                     macos::MacosPermissionActionResultCode::kStaleSnapshot &&
                 fixture.fake->settings_opens == 0,
             "expired action must be rejected before Settings")) {
    return false;
  }

  snapshot = fixture.readiness.Probe();
  fixture.fake->open_result = false;
  fixture.fake->screen = common::ReadinessState::kUnavailable;
  fixture.fake->accessibility = common::ReadinessState::kUnavailable;
  const auto failed = fixture.readiness.HandleLocalAction(
      LocalAction(snapshot, macos::MacosPermissionKind::kAccessibility));
  const auto effective = fixture.readiness.ApplyTo(OtherwiseReady());
  return Check(failed.code == macos::MacosPermissionActionResultCode::
                                  kOpenSettingsFailed &&
                   fixture.fake->settings_opens == 1,
               "Settings open failure must be explicit") &&
         Check(failed.snapshot.observation_sequence ==
                   snapshot.observation_sequence,
               "failed Settings action must not manufacture a fresh "
               "observation") &&
         Check(!effective.ViewReady() && !effective.ControlReady(),
               "failed local action must not synthesize readiness");
}

} // namespace

int main() {
  const bool passed =
      TestSeparateTruthfulStatesAndCapabilityDowngrade() &&
      TestUnknownAndExpiredEvidenceFailClosed() &&
      TestOnlyFreshLocalActionsCanOpenSettings() &&
      TestStaleGenerationAndObservationCannotWidenReadiness() &&
      TestExpiredAndFailedLocalActionsDoNotSynthesizeReadiness();
  return passed ? 0 : 1;
}
