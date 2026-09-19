#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "../../native/macos-remote-desktop/macos_slvirtual_display_backend.h"

namespace rd = imcodes::remote_desktop::macos;

namespace {

void Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

struct FakeState {
  bool probe = true;
  bool construct = true;
  bool endorsement = true;
  bool apply_settings = true;
  bool invoke_destroy = true;
  bool active = true;
  bool visible = true;
  bool disappear_after_destroy = true;
  std::uintptr_t expected_object = 0xA11CE;
  imcodes::remote_desktop::common::WorkerGeneration returned_generation = 0;
  int create_calls = 0;
  int endorse_calls = 0;
  int apply_calls = 0;
  int destroy_calls = 0;
  int release_calls = 0;
  int query_calls = 0;
};

class FakeRuntime final : public rd::SLVirtualDisplayRuntime {
 public:
  explicit FakeRuntime(std::shared_ptr<FakeState> state)
      : state_(std::move(state)) {}

  bool ProbeVerifiedRuntime(std::string* error) noexcept override {
    if (!state_->probe && error)
      *error = "unverified runtime";
    return state_->probe;
  }
  bool CreateExact(const rd::MacosVirtualDisplayConfiguration& configuration,
                   rd::SLVirtualDisplayInstance* instance,
                   std::string* error) override {
    ++state_->create_calls;
    if (!state_->construct) {
      *error = "construction failed";
      return false;
    }
    *instance = {
        state_->expected_object, 0xD35720,
        state_->returned_generation == 0 ? configuration.worker_generation
                                         : state_->returned_generation,
        73};
    return true;
  }
  bool ExactInstanceEndorsesDestroy(
      const rd::SLVirtualDisplayInstance& instance) noexcept override {
    ++state_->endorse_calls;
    return state_->endorsement && instance.object == state_->expected_object &&
           instance.destroy_implementation == 0xD35720;
  }
  bool ApplySettings(const rd::SLVirtualDisplayInstance& instance,
                     const rd::MacosVirtualDisplayMode&,
                     const std::vector<rd::MacosVirtualDisplayMode>&,
                     std::string* error) override {
    ++state_->apply_calls;
    if (!state_->apply_settings || instance.object != state_->expected_object) {
      *error = "activation failed";
      return false;
    }
    return true;
  }
  bool QueryPresence(const rd::SLVirtualDisplayInstance& instance,
                     bool* active,
                     bool* visible) noexcept override {
    ++state_->query_calls;
    if (instance.object != state_->expected_object)
      return false;
    *active = state_->active;
    *visible = state_->visible;
    return true;
  }
  bool InvokeExactDestroy(const rd::SLVirtualDisplayInstance& instance,
                          std::string* error) noexcept override {
    if (instance.object != state_->expected_object) {
      *error = "different object";
      return false;
    }
    ++state_->destroy_calls;
    if (!state_->invoke_destroy) {
      *error = "destroy selector failed";
      return false;
    }
    if (state_->disappear_after_destroy) {
      state_->active = false;
      state_->visible = false;
    }
    return true;
  }
  void SleepForRemovalPoll() noexcept override {}
  void ReleaseObject(const rd::SLVirtualDisplayInstance&) noexcept override {
    ++state_->release_calls;
  }

 private:
  std::shared_ptr<FakeState> state_;
};

rd::MacosVirtualDisplayConfiguration Configuration() {
  rd::MacosVirtualDisplayConfiguration configuration;
  configuration.worker_generation = 41;
  configuration.serial_number = 41;
  return configuration;
}

std::unique_ptr<rd::SLVirtualDisplayBackend> Backend(
    const std::shared_ptr<FakeState>& state) {
  return std::make_unique<rd::SLVirtualDisplayBackend>(
      std::make_unique<FakeRuntime>(state), 3);
}

void ProbeAndConstructionFailClosed() {
  {
    auto state = std::make_shared<FakeState>();
    state->probe = false;
    auto backend = Backend(state);
    std::uint32_t id = 0;
    std::string error;
    Check(backend->ProbeSupport() ==
              imcodes::remote_desktop::common::ReadinessState::kUnavailable,
          "missing class/signature must be unavailable");
    Check(!backend->Create(Configuration(), &id, &error),
          "unverified runtime must not create");
    Check(state->create_calls == 0, "probe failure must stop before construction");
  }
  {
    auto state = std::make_shared<FakeState>();
    state->construct = false;
    auto backend = Backend(state);
    std::uint32_t id = 0;
    std::string error;
    Check(!backend->Create(Configuration(), &id, &error),
          "construction failure must fail closed");
    Check(state->create_calls == 1 && id == 0, "failed construction cannot claim id");
  }
}

void ExactObjectEndorsementIsRequired() {
  auto state = std::make_shared<FakeState>();
  state->endorsement = false;  // global class availability would still be true.
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(!backend->Create(Configuration(), &id, &error),
        "exact object without destroy must be refused");
  Check(state->create_calls == 1 && state->release_calls == 1 &&
            state->destroy_calls == 0,
        "unendorsed object must never invoke an unrelated destroy IMP");
}

void WorkerGenerationMustMatchRequestedGeneration() {
  auto state = std::make_shared<FakeState>();
  state->returned_generation = Configuration().worker_generation + 1;
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(!backend->Create(Configuration(), &id, &error),
        "mismatched worker generation must be rejected");
  Check(id == 0 && state->apply_calls == 0 && state->release_calls == 1,
        "generation mismatch must not activate and must release candidate");
}

void ActivationFailureFailsClosedAndCleansExactObject() {
  auto state = std::make_shared<FakeState>();
  state->apply_settings = false;
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(!backend->Create(Configuration(), &id, &error),
        "activation failure must fail factory creation");
  Check(id == 0 && state->apply_calls == 1 && state->destroy_calls == 1 &&
            state->release_calls == 1 && backend->removal_verified(),
        "activation failure must destroy and verify the exact partial object");
}

void DestroyFailureNeverClaimsRemoval() {
  auto state = std::make_shared<FakeState>();
  state->invoke_destroy = false;
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(backend->Create(Configuration(), &id, &error), "create baseline");
  Check(!backend->DestroyAndVerify(&error), "selector failure must fail");
  Check(!backend->removal_verified() && backend->owned_instance().object != 0,
        "destroy failure must retain ownership and not claim removal");
  state->invoke_destroy = true;
  state->disappear_after_destroy = false;
  Check(!backend->DestroyAndVerify(&error), "still-visible object must fail");
  Check(state->destroy_calls == 2 && state->release_calls == 0,
        "failed invocation may retry but unverified removal may not release");
}

void StaleOrDifferentObjectIsRejected() {
  auto state = std::make_shared<FakeState>();
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(backend->Create(Configuration(), &id, &error), "create baseline");
  state->expected_object = 0xBADC0DE;
  Check(!backend->DestroyAndVerify(&error), "stale object identity must fail");
  Check(state->destroy_calls == 0 && !backend->removal_verified(),
        "stale identity must not dispatch destroy");
}

void ExactObjectDestroyIsOnceAndIdempotent() {
  auto state = std::make_shared<FakeState>();
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(backend->Create(Configuration(), &id, &error) && id == 73,
        "exact object creates");
  Check(backend->DestroyAndVerify(&error), "exact object destroy verifies");
  Check(backend->removal_verified() && state->destroy_calls == 1 &&
            state->release_calls == 1,
        "matching object's destroy must be called and released exactly once");
  Check(backend->DestroyAndVerify(&error), "double destroy is idempotent success");
  Check(state->destroy_calls == 1 && state->release_calls == 1,
        "double destroy must not redispatch or over-release");
}

void PresenceRetryNeverReinvokesDestroy() {
  auto state = std::make_shared<FakeState>();
  state->disappear_after_destroy = false;
  auto backend = Backend(state);
  std::uint32_t id = 0;
  std::string error;
  Check(backend->Create(Configuration(), &id, &error), "create retry baseline");
  Check(!backend->DestroyAndVerify(&error),
        "first still-present destroy verification must fail");
  Check(state->destroy_calls == 1 && backend->owned_instance().object != 0,
        "first failed verification retains ownership after one destroy");
  Check(!backend->DestroyAndVerify(&error),
        "second still-present destroy verification must fail");
  Check(state->destroy_calls == 1 && backend->owned_instance().object != 0,
        "presence retry must not invoke exact destroy more than once");
}

void PartialPresenceEvidenceNeverReleases() {
  {
    auto state = std::make_shared<FakeState>();
    state->disappear_after_destroy = false;
    auto backend = Backend(state);
    std::uint32_t id = 0;
    std::string error;
    Check(backend->Create(Configuration(), &id, &error),
          "create active-only presence baseline");
    state->active = true;
    state->visible = false;
    Check(!backend->DestroyAndVerify(&error),
          "active-only presence must block premature release");
    Check(state->release_calls == 0 && backend->owned_instance().object != 0,
          "active-only presence must retain exact-object ownership");
  }
  {
    auto state = std::make_shared<FakeState>();
    state->disappear_after_destroy = false;
    auto backend = Backend(state);
    std::uint32_t id = 0;
    std::string error;
    Check(backend->Create(Configuration(), &id, &error),
          "create visible-only presence baseline");
    state->active = false;
    state->visible = true;
    Check(!backend->DestroyAndVerify(&error),
          "visible-only presence must block premature release");
    Check(state->release_calls == 0 && backend->owned_instance().object != 0,
          "visible-only presence must retain exact-object ownership");
  }
}

}  // namespace

int main() {
  ProbeAndConstructionFailClosed();
  ExactObjectEndorsementIsRequired();
  WorkerGenerationMustMatchRequestedGeneration();
  ActivationFailureFailsClosedAndCleansExactObject();
  DestroyFailureNeverClaimsRemoval();
  StaleOrDifferentObjectIsRejected();
  ExactObjectDestroyIsOnceAndIdempotent();
  PresenceRetryNeverReinvokesDestroy();
  PartialPresenceEvidenceNeverReleases();
  std::cout << "SLVirtualDisplay exact-instance backend counterfactuals passed\n";
  return 0;
}
