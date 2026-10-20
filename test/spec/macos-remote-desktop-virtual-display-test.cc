#include <cstdio>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "macos_virtual_display_adapter.h"

namespace common = imcodes::remote_desktop::common;
namespace macos = imcodes::remote_desktop::macos;

namespace {

int failures = 0;

void Check(bool condition, const char* label) {
  if (condition)
    return;
  std::fprintf(stderr, "FAIL %s\n", label);
  ++failures;
}

common::DesktopTopology Topology(std::uint32_t native_id,
                                 bool physical = false) {
  return {
      .generation = 7,
      .revision = 1,
      .displays = {{
          .display_id = "macos-display:7:" + std::to_string(native_id),
          .generation = 7,
          .encoded_pixels = {1920, 1080},
          .logical_input_bounds = {0, 0, 1920, 1080},
          .scale = 1.0,
          .rotation = common::DisplayRotation::k0,
          .operations = {.selectable = true,
                         .set_mode = physical,
                         .set_scale = physical},
      }},
  };
}

struct SharedState {
  bool virtual_online = false;
  bool fail_create = false;
  bool fail_wait = false;
  bool fail_apply = false;
  int create_calls = 0;
  int wait_calls = 0;
  int apply_calls = 0;
  int destroy_calls = 0;
  std::uint32_t native_id = 9001;
};

class FakeDisplay final : public common::DisplayAdapter {
 public:
  explicit FakeDisplay(std::shared_ptr<SharedState> state)
      : state_(std::move(state)) {}

  common::ReadinessState ProbeReadiness() override { return readiness; }

  std::optional<common::DesktopTopology> EnumerateTopology() override {
    ++enumerate_calls;
    if (physical_online)
      return Topology(42, true);
    if (state_->virtual_online)
      return Topology(state_->native_id);
    return std::nullopt;
  }

  bool SelectDisplay(std::string_view display_id) override {
    selected.assign(display_id);
    return display_id == "macos-display:7:42" ||
           display_id == "macos-display:7:9001";
  }

  bool SetMode(std::string_view, common::PixelSize) override {
    ++physical_mode_calls;
    return true;
  }
  bool SetScale(std::string_view, double) override {
    ++physical_scale_calls;
    return true;
  }

  std::shared_ptr<SharedState> state_;
  common::ReadinessState readiness = common::ReadinessState::kReady;
  bool physical_online = false;
  int enumerate_calls = 0;
  int physical_mode_calls = 0;
  int physical_scale_calls = 0;
  std::string selected;
};

class FakeBackend final : public macos::MacosVirtualDisplayBackend {
 public:
  explicit FakeBackend(std::shared_ptr<SharedState> state)
      : state_(std::move(state)) {}

  common::ReadinessState ProbeSupport() noexcept override { return support; }

  bool Create(const macos::MacosVirtualDisplayConfiguration&,
              std::uint32_t* native_display_id,
              std::string* error) override {
    ++state_->create_calls;
    if (state_->fail_create) {
      *error = "create failed";
      return false;
    }
    *native_display_id = state_->native_id;
    state_->virtual_online = true;
    return true;
  }

  bool ApplyMode(std::uint32_t native_display_id,
                 const macos::MacosVirtualDisplayMode&,
                 const std::vector<macos::MacosVirtualDisplayMode>&,
                 std::string* error) override {
    ++state_->apply_calls;
    if (state_->fail_apply || native_display_id != state_->native_id) {
      *error = "apply failed";
      return false;
    }
    return true;
  }

  bool WaitUntilOnline(std::uint32_t native_display_id,
                       std::uint32_t,
                       std::string* error) override {
    ++state_->wait_calls;
    if (state_->fail_wait || native_display_id != state_->native_id) {
      *error = "wait failed";
      return false;
    }
    return state_->virtual_online;
  }

  void Destroy() noexcept override {
    ++state_->destroy_calls;
    state_->virtual_online = false;
  }

  std::shared_ptr<SharedState> state_;
  common::ReadinessState support = common::ReadinessState::kReady;
};

void PhysicalDisplayIsNeverReplacedOrMutated() {
  auto state = std::make_shared<SharedState>();
  FakeDisplay display(state);
  display.physical_online = true;
  auto backend = std::make_unique<FakeBackend>(state);
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  const auto topology = adapter.EnumerateTopology();
  Check(topology.has_value(), "physical topology remains available");
  Check(state->create_calls == 0,
        "physical topology does not create virtual display");
  Check(!adapter.SetMode("macos-display:7:42", {1920, 1080}),
        "physical mode mutation is refused");
  Check(!adapter.SetScale("macos-display:7:42", 2.0),
        "physical scale mutation is refused");
  Check(display.physical_mode_calls == 0 && display.physical_scale_calls == 0,
        "physical adapter is never asked to mutate");
}

void HeadlessCreatesThenPublishesOrdinaryTopology() {
  auto state = std::make_shared<SharedState>();
  FakeDisplay display(state);
  auto backend = std::make_unique<FakeBackend>(state);
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  const auto topology = adapter.EnumerateTopology();
  Check(topology.has_value(), "headless topology becomes available");
  Check(state->create_calls == 1 && state->wait_calls == 1,
        "headless path creates and waits exactly once");
  Check(display.enumerate_calls == 2,
        "topology is re-enumerated instead of synthesized");
  Check(adapter.owns_virtual_display(), "adapter owns created display");
  Check(adapter.virtual_display_id() == "macos-display:7:9001",
        "virtual identity is generation scoped");
  Check(topology->displays[0].operations.set_mode &&
            topology->displays[0].operations.set_scale,
        "only owned topology advertises mode operations");
  Check(adapter.SelectDisplay(adapter.virtual_display_id()),
        "selection remains delegated to ordinary display adapter");
}

void CreationFailureNeverPublishesSyntheticTopology() {
  auto state = std::make_shared<SharedState>();
  state->fail_create = true;
  FakeDisplay display(state);
  auto backend = std::make_unique<FakeBackend>(state);
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  Check(!adapter.EnumerateTopology().has_value(),
        "failed creation leaves topology unavailable");
  Check(!adapter.owns_virtual_display(), "failed creation owns no display");
  Check(state->destroy_calls == 1, "partial creation is destroyed");
}

void MissingOwnedDisplayIsDestroyedNotAliased() {
  auto state = std::make_shared<SharedState>();
  FakeDisplay display(state);
  auto backend = std::make_unique<FakeBackend>(state);
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  Check(adapter.EnumerateTopology().has_value(),
        "initial virtual topology exists");
  state->native_id = 9002;
  Check(!adapter.EnumerateTopology().has_value(),
        "different display cannot inherit owned capability");
  Check(!adapter.owns_virtual_display(), "missing owned display is released");
}

void ApprovedModesOnlyAndTeardownIsIdempotent() {
  auto state = std::make_shared<SharedState>();
  FakeDisplay display(state);
  auto backend = std::make_unique<FakeBackend>(state);
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  Check(adapter.EnumerateTopology().has_value(),
        "virtual display exists for mode test");
  Check(adapter.SetMode(adapter.virtual_display_id(), {2560, 1440}),
        "approved mode applies");
  Check(!adapter.SetMode(adapter.virtual_display_id(), {3000, 2000}),
        "unapproved mode is rejected before backend");
  Check(adapter.SetScale(adapter.virtual_display_id(), 2.0),
        "approved scale applies");
  Check(!adapter.SetScale(adapter.virtual_display_id(), 1.5),
        "unapproved scale is rejected");
  Check(state->apply_calls == 2, "backend sees approved mutations only");
  adapter.ReleaseVirtualDisplay();
  adapter.ReleaseVirtualDisplay();
  Check(state->destroy_calls == 1, "explicit teardown is idempotent");
}

void PredicateAndRuntimeSupportRemainFailClosed() {
  auto state = std::make_shared<SharedState>();
  FakeDisplay display(state);
  auto backend = std::make_unique<FakeBackend>(state);
  backend->support = common::ReadinessState::kUnavailable;
  macos::MacosVirtualDisplayAdapter adapter(display, std::move(backend),
                                            {.worker_generation = 7},
                                            [] { return true; });
  Check(!adapter.EnumerateTopology().has_value(),
        "unsupported runtime leaves headless unavailable");
  Check(state->create_calls == 0, "unsupported runtime is not invoked");

  auto state2 = std::make_shared<SharedState>();
  FakeDisplay display2(state2);
  auto backend2 = std::make_unique<FakeBackend>(state2);
  macos::MacosVirtualDisplayAdapter denied(display2, std::move(backend2),
                                           {.worker_generation = 7},
                                           [] { return false; });
  Check(!denied.EnumerateTopology().has_value(),
        "non-headless enumeration failure does not create a display");
  Check(state2->create_calls == 0, "creation predicate is load bearing");
}

void VirtualIdentitySerialIsGenerationScopedAndNonzero() {
  Check(macos::MacosVirtualDisplaySerialForGeneration(0) == 0,
        "generation zero has no virtual identity serial");
  Check(macos::MacosVirtualDisplaySerialForGeneration(7) == 7,
        "small generations preserve their serial identity");
  Check(macos::MacosVirtualDisplaySerialForGeneration(0x1'0000'0001ULL) == 1,
        "folded generation serial never becomes zero");
  Check(macos::MacosVirtualDisplaySerialForGeneration(7) !=
            macos::MacosVirtualDisplaySerialForGeneration(8),
        "different live generations use different serial identities");
}

}  // namespace

int main() {
  PhysicalDisplayIsNeverReplacedOrMutated();
  HeadlessCreatesThenPublishesOrdinaryTopology();
  CreationFailureNeverPublishesSyntheticTopology();
  MissingOwnedDisplayIsDestroyedNotAliased();
  ApprovedModesOnlyAndTeardownIsIdempotent();
  PredicateAndRuntimeSupportRemainFailClosed();
  VirtualIdentitySerialIsGenerationScopedAndNonzero();
  if (failures != 0)
    return 1;
  std::puts("macos virtual display adapter counterfactual ok");
  return 0;
}
