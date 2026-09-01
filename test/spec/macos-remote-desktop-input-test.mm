#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "cg_event_input_adapter.h"
#include "input_ledger.h"

namespace input = imcodes::remote_desktop::macos;
namespace common = imcodes::remote_desktop::common;

namespace {

bool Check(bool condition, std::string_view message) {
  if (!condition)
    std::cerr << message << '\n';
  return condition;
}

struct Transition {
  std::string value;
  bool pressed = false;
  bool operator==(const Transition&) const = default;
};

class FakeBackend final : public input::CGEventInputBackend {
public:
  common::ReadinessState readiness = common::ReadinessState::kReady;
  std::vector<common::LogicalPoint> pointer_events;
  std::vector<Transition> key_events;
  std::vector<Transition> button_events;
  std::vector<std::pair<double, double>> wheel_events;
  std::vector<std::string> text_events;
  std::string fail_key_release_once;
  std::string fail_button_release_once;
  bool fail_next_emit = false;

  common::ReadinessState ProbeAccessibility() noexcept override {
    return readiness;
  }

  bool MovePointer(const common::LogicalPoint &point) override {
    if (readiness != common::ReadinessState::kReady)
      return false;
    if (ConsumeFailure())
      return false;
    pointer_events.push_back(point);
    return true;
  }

  bool EmitKey(std::string_view key, bool pressed) override {
    if (readiness != common::ReadinessState::kReady)
      return false;
    if (!pressed && key == fail_key_release_once) {
      fail_key_release_once.clear();
      return false;
    }
    if (ConsumeFailure())
      return false;
    key_events.push_back({std::string(key), pressed});
    return true;
  }

  bool EmitButton(std::string_view button, bool pressed) override {
    if (readiness != common::ReadinessState::kReady)
      return false;
    if (!pressed && button == fail_button_release_once) {
      fail_button_release_once.clear();
      return false;
    }
    if (ConsumeFailure())
      return false;
    button_events.push_back({std::string(button), pressed});
    return true;
  }

  bool EmitWheel(double delta_x, double delta_y) override {
    if (readiness != common::ReadinessState::kReady)
      return false;
    if (ConsumeFailure())
      return false;
    wheel_events.emplace_back(delta_x, delta_y);
    return true;
  }

  bool EmitText(std::string_view text) override {
    if (readiness != common::ReadinessState::kReady)
      return false;
    if (ConsumeFailure())
      return false;
    text_events.emplace_back(text);
    return true;
  }

private:
  bool ConsumeFailure() {
    if (!fail_next_emit)
      return false;
    fail_next_emit = false;
    return true;
  }
};

common::DesktopTopology Topology(common::TopologyRevision revision = 7,
                                 common::WorkerGeneration generation = 42,
                                 common::LogicalRect bounds = {-500.0, 20.0,
                                                               1500.0, 900.0}) {
  return common::DesktopTopology{
      generation,
      revision,
      {common::DisplayTopology{
          "macos-display:42:main",
          generation,
          {3000, 1800},
          bounds,
          2.0,
          common::DisplayRotation::k0,
          {true, false, false},
      }},
  };
}

common::InputStamp Stamp(std::string controller, common::InputSequence sequence,
                         common::TopologyRevision revision = 7,
                         common::InputEpoch epoch = 1) {
  return common::InputStamp{std::move(controller), epoch, sequence, revision};
}

std::size_t Count(const std::vector<Transition> &transitions,
                  std::string_view value, bool pressed) {
  std::size_t count = 0;
  for (const auto &transition : transitions) {
    if (transition.value == value && transition.pressed == pressed)
      ++count;
  }
  return count;
}

bool TestLedgerOnlyOperationsAndLogicalGeometry() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  common::InputLedger ledger(adapter);
  const auto topology = Topology();
  if (!Check(adapter.BindTopology(topology, topology.displays[0].display_id),
             "current topology must bind") ||
      !Check(adapter.ProbeReadiness() == common::ReadinessState::kReady,
             "trusted fake must be ready") ||
      !Check(
          ledger.ApplyPointer(Stamp("controller-a", 1), 7, {-250.5, 100.25}) ==
              common::InputResult::kApplied,
          "logical pointer transition should apply") ||
      !Check(ledger.ApplyKey(Stamp("controller-a", 2), 7, "KeyA", true) ==
                 common::InputResult::kApplied,
             "key down should apply") ||
      !Check(ledger.ApplyButton(Stamp("controller-a", 3), 7, "left", true) ==
                 common::InputResult::kApplied,
             "button down should apply") ||
      !Check(ledger.ApplyWheel(Stamp("controller-a", 4), 7, 4.5, -8.25) ==
                 common::InputResult::kApplied,
             "wheel should apply") ||
      !Check(ledger.ApplyText(Stamp("controller-a", 5), 7, "Hello, 世界") ==
                 common::InputResult::kApplied,
             "bounded UTF-8 text should apply") ||
      !Check(ledger.ApplyButton(Stamp("controller-a", 6), 7, "left", false) ==
                 common::InputResult::kApplied,
             "button up should apply") ||
      !Check(ledger.ApplyKey(Stamp("controller-a", 7), 7, "KeyA", false) ==
                 common::InputResult::kApplied,
             "key up should apply")) {
    return false;
  }
  const auto statistics = adapter.Statistics();
  return Check(
             fake->pointer_events.size() == 1 &&
                 fake->pointer_events[0].x == -250.5 &&
                 fake->pointer_events[0].y == 100.25,
             "pointer must use logical Quartz coordinates, not frame pixels") &&
         Check(Count(fake->key_events, "KeyA", true) == 1 &&
                   Count(fake->key_events, "KeyA", false) == 1,
               "ledger-approved key transitions must reach the backend once") &&
         Check(Count(fake->button_events, "left", true) == 1 &&
                   Count(fake->button_events, "left", false) == 1,
               "ledger-approved button transitions must reach the backend "
               "once") &&
         Check(fake->wheel_events.size() == 1 &&
                   fake->text_events == std::vector<std::string>{"Hello, 世界"},
               "wheel and bounded text must reach the backend") &&
         Check(statistics.emitted_keys == 0 && statistics.emitted_buttons == 0,
               "released input must not remain in adapter bookkeeping");
}

bool TestClipboardShortcutsUseRealBoundInputAndReleaseEveryKey() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend* fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  const auto topology = Topology();
  if (!Check(adapter.BindTopology(topology, topology.displays[0].display_id),
             "clipboard shortcut needs the current real topology") ||
      !Check(adapter.EmitClipboardShortcut(
                 "KeyC", std::numeric_limits<std::uint64_t>::max()),
             "Command-C must use the real input adapter") ||
      !Check(adapter.EmitClipboardShortcut(
                 "KeyV", std::numeric_limits<std::uint64_t>::max()),
             "Command-V must use the real input adapter")) {
    return false;
  }
  const std::vector<Transition> expected = {
      {"MetaLeft", true}, {"KeyC", true}, {"KeyC", false},
      {"MetaLeft", false}, {"MetaLeft", true}, {"KeyV", true},
      {"KeyV", false}, {"MetaLeft", false},
  };
  if (!Check(fake->key_events == expected,
             "clipboard callbacks must emit two bounded released chords") ||
      !Check(adapter.Statistics().emitted_keys == 0,
             "clipboard callbacks must never leave a held modifier")) {
    return false;
  }
  const std::size_t before = fake->key_events.size();
  return Check(!adapter.EmitClipboardShortcut("KeyC", 0),
               "expired clipboard action must fail closed") &&
         Check(!adapter.EmitClipboardShortcut(
                   "KeyX", std::numeric_limits<std::uint64_t>::max()),
               "only copy and paste shortcuts are admitted") &&
         Check(fake->key_events.size() == before,
               "rejected clipboard action must emit nothing");
}

bool TestTopologyAndSequenceFences() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  common::InputLedger ledger(adapter);
  auto topology = Topology();
  if (!Check(!adapter.BindTopology(Topology(7, 41), "macos-display:42:main"),
             "foreign worker generation must be rejected") ||
      !Check(adapter.BindTopology(topology, topology.displays[0].display_id),
             "valid topology must bind") ||
      !Check(ledger.ApplyPointer(Stamp("controller-a", 1, 6), 7, {0, 100}) ==
                 common::InputResult::kStaleTopology,
             "old topology input must be rejected by the common ledger") ||
      !Check(ledger.ApplyPointer(Stamp("controller-a", 1), 7, {0, 100}) ==
                 common::InputResult::kApplied,
             "current topology input must apply") ||
      !Check(ledger.ApplyPointer(Stamp("controller-a", 1), 7, {1, 100}) ==
                 common::InputResult::kStaleSequence,
             "replayed sequence must be rejected by the common ledger") ||
      !Check(ledger.ApplyPointer(Stamp("controller-a", 2), 7, {1'001, 100}) ==
                 common::InputResult::kAdapterFailure,
             "point outside logical bounds must fail at the adapter") ||
      !Check(
          !adapter.BindTopology(Topology(6), topology.displays[0].display_id),
          "topology revision regression must be rejected")) {
    return false;
  }
  auto equivocal = topology;
  equivocal.displays[0].logical_input_bounds.width = 1400;
  return Check(
             !adapter.BindTopology(equivocal, equivocal.displays[0].display_id),
             "same revision must not be reused for different bounds") &&
         Check(fake->pointer_events.size() == 1,
               "stale, replayed and out-of-bounds input must not emit");
}

bool TestMultiControllerAndLifecycleRelease() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  common::InputLedger ledger(adapter);
  const auto topology = Topology();
  if (!Check(adapter.BindTopology(topology, topology.displays[0].display_id),
             "release topology must bind") ||
      !Check(ledger.ApplyKey(Stamp("controller-a", 1), 7, "ShiftLeft", true) ==
                 common::InputResult::kApplied,
             "first key owner must apply") ||
      !Check(ledger.ApplyKey(Stamp("controller-b", 1), 7, "ShiftLeft", true) ==
                 common::InputResult::kApplied,
             "second key owner must apply without a duplicate event") ||
      !Check(ledger.ApplyButton(Stamp("controller-b", 2), 7, "left", true) ==
                 common::InputResult::kApplied,
             "held button must apply") ||
      !Check(ledger.ReleaseController("controller-a") ==
                 common::InputResult::kApplied,
             "one controller can release without releasing the other")) {
    return false;
  }
  if (!Check(Count(fake->key_events, "ShiftLeft", false) == 0,
             "shared ownership must keep the key held")) {
    return false;
  }
  adapter.HandleLifecycleBoundary(
      input::CGEventInputReleaseReason::kDisconnect);
  const std::size_t key_events = fake->key_events.size();
  const std::size_t button_events = fake->button_events.size();
  adapter.HandleLifecycleBoundary(
      input::CGEventInputReleaseReason::kDisconnect);
  ledger.ReleaseAll();
  return Check(Count(fake->key_events, "ShiftLeft", true) == 1 &&
                   Count(fake->key_events, "ShiftLeft", false) == 1,
               "terminal release must emit exactly one key up") &&
         Check(Count(fake->button_events, "left", true) == 1 &&
                   Count(fake->button_events, "left", false) == 1,
               "terminal release must emit exactly one button up") &&
         Check(fake->key_events.size() == key_events &&
                   fake->button_events.size() == button_events,
               "double release and later ledger cleanup must be idempotent") &&
         Check(adapter.topology_revision() == 0,
               "a lifecycle boundary must require a fresh topology binding");
}

bool TestEveryLifecycleReasonReleasesOnlyEmittedState() {
  const input::CGEventInputReleaseReason reasons[] = {
      input::CGEventInputReleaseReason::kDowngrade,
      input::CGEventInputReleaseReason::kDisconnect,
      input::CGEventInputReleaseReason::kPermissionLoss,
      input::CGEventInputReleaseReason::kUserChange,
      input::CGEventInputReleaseReason::kAgentCrash,
      input::CGEventInputReleaseReason::kShutdown,
  };
  for (const auto reason : reasons) {
    auto backend = std::make_unique<FakeBackend>();
    FakeBackend *fake = backend.get();
    input::CGEventInputAdapter adapter(42, std::move(backend));
    common::InputLedger ledger(adapter);
    const auto topology = Topology();
    if (!adapter.BindTopology(topology, topology.displays[0].display_id) ||
        ledger.ApplyKey(Stamp("controller-a", 1), 7, "KeyA", true) !=
            common::InputResult::kApplied ||
        ledger.ApplyButton(Stamp("controller-a", 2), 7, "right", true) !=
            common::InputResult::kApplied) {
      return Check(false, "lifecycle fixture setup failed");
    }
    fake->fail_next_emit = true;
    if (!Check(ledger.ApplyKey(Stamp("controller-a", 3), 7, "KeyB", true) ==
                   common::InputResult::kAdapterFailure,
               "failed down must not become emitted state")) {
      return false;
    }
    adapter.HandleLifecycleBoundary(reason);
    adapter.HandleLifecycleBoundary(reason);
    if (!Check(
            Count(fake->key_events, "KeyA", false) == 1 &&
                Count(fake->button_events, "right", false) == 1 &&
                Count(fake->key_events, "KeyB", false) == 0,
            "each lifecycle reason must release only successful downs once")) {
      return false;
    }
  }
  return true;
}

bool TestPermissionRevocationAndReleaseRetry() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  common::InputLedger ledger(adapter);
  const auto topology = Topology();
  if (!adapter.BindTopology(topology, topology.displays[0].display_id) ||
      ledger.ApplyKey(Stamp("controller-a", 1), 7, "KeyA", true) !=
          common::InputResult::kApplied ||
      ledger.ApplyButton(Stamp("controller-a", 2), 7, "left", true) !=
          common::InputResult::kApplied) {
    return Check(false, "permission fixture setup failed");
  }
  fake->readiness = common::ReadinessState::kUnavailable;
  if (!Check(adapter.ProbeReadiness() == common::ReadinessState::kUnavailable,
             "revoked Accessibility trust must become unavailable") ||
      !Check(Count(fake->button_events, "left", false) == 0 &&
                 Count(fake->key_events, "KeyA", false) == 0,
             "permission loss must not claim rejected releases succeeded") ||
      !Check(adapter.Statistics().emitted_keys == 1 &&
                 adapter.Statistics().emitted_buttons == 1,
             "permission-denied releases must stay recorded for retry")) {
    return false;
  }
  fake->readiness = common::ReadinessState::kReady;
  fake->fail_key_release_once = "KeyA";
  if (!Check(
          adapter.ProbeReadiness() == common::ReadinessState::kUnavailable,
          "partial release after permission recovery must stay fail-closed") ||
      !Check(Count(fake->button_events, "left", false) == 1 &&
                 Count(fake->key_events, "KeyA", false) == 0,
             "permission recovery may drain only successful releases") ||
      !Check(
          adapter.ProbeReadiness() == common::ReadinessState::kReady,
          "readiness may recover only after every held transition releases")) {
    return false;
  }
  adapter.HandleLifecycleBoundary(input::CGEventInputReleaseReason::kShutdown);
  return Check(Count(fake->key_events, "KeyA", false) == 1,
               "a later terminal boundary must retry the one failed key up") &&
         Check(Count(fake->button_events, "left", false) == 1,
               "successful releases must never be duplicated") &&
         Check(adapter.Statistics().emitted_keys == 0 &&
                   adapter.Statistics().emitted_buttons == 0 &&
                   adapter.Statistics().release_failures == 3,
               "retry must drain stuck state and preserve failure evidence") &&
         Check(ledger.ApplyPointer(Stamp("controller-a", 3), 7, {0, 100}) ==
                   common::InputResult::kAdapterFailure,
               "permission loss must reject subsequent input");
}

bool TestBoundedTextCounterfactual() {
  auto backend = std::make_unique<FakeBackend>();
  FakeBackend *fake = backend.get();
  input::CGEventInputAdapter adapter(42, std::move(backend));
  common::InputLedger ledger(adapter);
  const auto topology = Topology();
  if (!adapter.BindTopology(topology, topology.displays[0].display_id)) {
    return Check(false, "text topology must bind");
  }
  const std::string too_large(common::kMaximumInputTextBytes + 1, 'x');
  const std::string invalid_utf8("\xc0\xaf", 2);
  return Check(ledger.ApplyText(Stamp("controller-a", 1), 7, too_large) ==
                   common::InputResult::kInvalidInput,
               "oversized text must be rejected before the adapter") &&
         Check(ledger.ApplyText(Stamp("controller-a", 2), 7, invalid_utf8) ==
                   common::InputResult::kInvalidInput,
               "invalid UTF-8 must be rejected before the adapter") &&
         Check(fake->text_events.empty(),
               "invalid text must never reach the CGEvent backend");
}

} // namespace

int main() {
  @autoreleasepool {
    return TestLedgerOnlyOperationsAndLogicalGeometry() &&
                   TestClipboardShortcutsUseRealBoundInputAndReleaseEveryKey() &&
                   TestTopologyAndSequenceFences() &&
                   TestMultiControllerAndLifecycleRelease() &&
                   TestEveryLifecycleReasonReleasesOnlyEmittedState() &&
                   TestPermissionRevocationAndReleaseRetry() &&
                   TestBoundedTextCounterfactual()
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
  }
}
