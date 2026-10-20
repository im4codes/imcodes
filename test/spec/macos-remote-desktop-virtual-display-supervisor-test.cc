// Counterfactuals for helper supervision. Every case is a named failure mode:
// the helper process is the display's lifetime, so a supervision bug strands a
// real display on a real machine.
#include "macos_virtual_display_supervisor.h"

#include <cassert>
#include <cstdio>
#include <set>
#include <utility>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

// A fake OS. Nothing is spawned, no descriptor is opened, no display exists.
struct FakeOs {
  std::uint32_t euid = 501;
  bool resolve_ok = true;
  std::string expected_release = "aidesk-v4";
  std::string expected_digest = std::string(64, 'a');
  std::string expected_dr =
      "identifier \"cc.imcodes.node.virtual-display-helper\" and anchor apple generic";
  std::string resolve_error = "helper identity does not match the release";
  bool spawn_ok = true;
  bool ready_ok = true;
  bool running = true;
  std::uint64_t clock_ms = 1'000;
  std::uint64_t random_next = 0x1000;

  std::int32_t next_pid = 4242;
  int next_fd = 10;
  std::set<int> open_fds;          // parent-side descriptors we handed out
  std::vector<int> double_closed;  // any fd closed twice
  std::vector<std::int32_t> reaped;
  std::vector<std::uint64_t> epochs_issued;
  std::uint32_t spawn_calls = 0;

  rd::SupervisorSeam Seam() {
    rd::SupervisorSeam seam;
    seam.effective_uid = [this] { return euid; };
    seam.resolve_verified_helper = [this](const std::string& release_identity,
                                          const std::string& expected_sha256,
                                          const std::string& expected_requirement,
                                          std::string* path,
                                          std::string* error) {
      // The fake enforces the same contract the real seam does: ALL THREE
      // inputs are compared. A seam that accepts any identity, digest or
      // requirement would make the production checks untested.
      if (!resolve_ok || release_identity != expected_release ||
          expected_sha256 != expected_digest ||
          expected_requirement != expected_dr) {
        if (error) *error = resolve_error;
        return false;
      }
      *path = "/verified/imcodes-virtual-display-helper";
      return true;
    };
    seam.random_u64 = [this] { return ++random_next; };
    seam.spawn_helper = [this](const std::string&,
                               const rd::VirtualDisplayHelperBinding& binding,
                               rd::SupervisedHelper* helper,
                               std::string* error) {
      ++spawn_calls;
      if (!spawn_ok) {
        if (error) *error = "posix_spawn failed";
        return false;
      }
      epochs_issued.push_back(binding.epoch);
      helper->pid = next_pid++;
      helper->binding_write_fd = next_fd++;
      helper->control_fd = next_fd++;
      open_fds.insert(helper->binding_write_fd);
      open_fds.insert(helper->control_fd);
      return true;
    };
    seam.await_ready = [this](const rd::SupervisedHelper&, std::uint32_t) {
      return ready_ok;
    };
    seam.still_running = [this](std::int32_t) { return running; };
    seam.terminate_and_reap = [this](std::int32_t pid, std::uint32_t) {
      reaped.push_back(pid);
    };
    seam.close_fd = [this](int fd) {
      if (open_fds.erase(fd) == 0)
        double_closed.push_back(fd);
    };
    seam.now_ms = [this] { return clock_ms; };
    return seam;
  }
};

struct Revocations {
  std::vector<std::pair<rd::AuthorityRevocation, std::uint64_t>> entries;
  rd::AuthorityRevocation back_entry_reason() const {
    return entries.empty() ? rd::AuthorityRevocation::kNone : entries.back().first;
  }
  rd::AuthorityRevokedCallback Callback() {
    return [this](rd::AuthorityRevocation reason, std::uint64_t epoch) {
      entries.emplace_back(reason, epoch);
    };
  }
};

rd::SupervisorLaunchRequest Request(std::uint64_t generation = 7) {
  rd::SupervisorLaunchRequest request;
  request.generation = generation;
  request.console_uid = 501;
  request.release_identity = "aidesk-v4";
  request.expected_helper_sha256 = std::string(64, 'a');
  request.expected_helper_designated_requirement =
      "identifier \"cc.imcodes.node.virtual-display-helper\" and anchor apple generic";
  return request;
}

void NobodySpawnedMeansNoAuthority() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  // Before Start there is no helper, so there is nothing to advertise.
  assert(supervisor.state() == rd::SupervisorState::kIdle);
  assert(!supervisor.admits_display_control());
  assert(!supervisor.binding().IsValid());
  assert(!supervisor.Poll());
  assert(os.spawn_calls == 0);
}

void RootIsRefusedBeforeAnythingIsSpawned() {
  FakeOs os;
  os.euid = 0;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("root") != std::string::npos);
  // Refused BEFORE spawning: a root helper has no Aqua session at all.
  assert(os.spawn_calls == 0);
  assert(!supervisor.admits_display_control());
}

void CrossUserSupervisionIsRefused() {
  FakeOs os;
  os.euid = 502;  // not the console uid in the request
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("uid") != std::string::npos);
  assert(os.spawn_calls == 0);
}

void UnverifiableHelperPathIsRefused() {
  FakeOs os;
  os.resolve_ok = false;  // symlink, or an identity that is not our release
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("identity") != std::string::npos);
  // Never spawned: refusing is the point, warning would not be.
  assert(os.spawn_calls == 0);
  assert(!supervisor.admits_display_control());
}

void WrongReleaseIdentityOrDigestIsRefused() {
  {
    FakeOs os;
    Revocations revocations;
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    rd::SupervisorLaunchRequest request = Request();
    request.release_identity = "some-other-release";
    std::string error;
    assert(!supervisor.Start(request, &error));
    assert(os.spawn_calls == 0);
  }
  {
    FakeOs os;
    Revocations revocations;
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    rd::SupervisorLaunchRequest request = Request();
    request.expected_helper_sha256 = std::string(64, 'b');  // replaced binary
    std::string error;
    assert(!supervisor.Start(request, &error));
    assert(os.spawn_calls == 0);
  }
  {
    // A blank designated requirement would silently skip the signer check and
    // leave only the digest standing.
    FakeOs os;
    Revocations revocations;
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    rd::SupervisorLaunchRequest request = Request();
    request.expected_helper_designated_requirement.clear();
    std::string error;
    assert(!supervisor.Start(request, &error));
    assert(os.spawn_calls == 0);
  }
  {
    // A requirement naming somebody else must be refused.
    FakeOs os;
    Revocations revocations;
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    rd::SupervisorLaunchRequest request = Request();
    request.expected_helper_designated_requirement =
        "identifier \"cc.imcodes.node.somebody-else\" and anchor apple generic";
    std::string error;
    assert(!supervisor.Start(request, &error));
    assert(os.spawn_calls == 0);
  }
  {
    // A malformed or absent digest is not a "skip the check" signal.
    FakeOs os;
    Revocations revocations;
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    rd::SupervisorLaunchRequest request = Request();
    request.expected_helper_sha256.clear();
    std::string error;
    assert(!supervisor.Start(request, &error));
    assert(os.spawn_calls == 0);
  }
}

void ReadyTimeoutRevokesAndReapsWithoutLeaking() {
  FakeOs os;
  os.ready_ok = false;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(!supervisor.Start(Request(), &error));
  assert(!supervisor.admits_display_control());
  assert(revocations.entries.size() == 1);
  assert(revocations.entries[0].first == rd::AuthorityRevocation::kReadyTimeout);
  // The hung helper is killed and reaped, and both descriptors are returned.
  assert(os.reaped.size() == 1);
  assert(supervisor.open_descriptor_count() == 0);
  assert(os.open_fds.empty());
  assert(os.double_closed.empty());
}

void CrashRevokesImmediatelyAndPollReportsFalse() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(supervisor.Start(Request(), &error));
  assert(supervisor.admits_display_control());
  assert(supervisor.binding().IsValid());

  os.running = false;  // the helper died
  assert(!supervisor.Poll());
  // Authority is gone by the time Poll returns, not "eventually".
  assert(!supervisor.admits_display_control());
  assert(!supervisor.binding().IsValid());
  assert(revocations.back_entry_reason() == rd::AuthorityRevocation::kHelperCrashed);
  assert(os.open_fds.empty());
  assert(os.double_closed.empty());
}

void CrashStormExhaustsTheBudgetInsteadOfRespawningForever() {
  FakeOs os;
  Revocations revocations;
  rd::SupervisorPolicy policy;
  policy.max_spawns_per_generation = 3;
  rd::MacosVirtualDisplaySupervisor supervisor(policy, os.Seam(),
                                               revocations.Callback());
  std::string error;
  for (int attempt = 0; attempt < 3; ++attempt) {
    os.running = true;
    assert(supervisor.Start(Request(), &error));
    os.running = false;
    assert(!supervisor.Poll());
    os.clock_ms += 60'000;  // wait out the backoff each time
  }
  // Budget spent: display control is permanently off for this generation
  // rather than becoming an unbounded respawn loop.
  assert(supervisor.state() == rd::SupervisorState::kExhausted);
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("budget") != std::string::npos);
  assert(os.spawn_calls == 3);
  assert(os.open_fds.empty());
}

void StopDoesNotRefundTheRestartBudget() {
  // Stop() returns the supervisor to kIdle, but a route that has already burned
  // its spawns must not get them back by stopping and starting again -- that
  // would turn a bounded budget into an unbounded loop with extra steps.
  FakeOs os;
  Revocations revocations;
  rd::SupervisorPolicy policy;
  policy.max_spawns_per_generation = 2;
  rd::MacosVirtualDisplaySupervisor supervisor(policy, os.Seam(),
                                               revocations.Callback());
  std::string error;
  for (int attempt = 0; attempt < 2; ++attempt) {
    os.running = true;
    assert(supervisor.Start(Request(), &error));
    supervisor.Stop(rd::AuthorityRevocation::kStopRequested);
    os.clock_ms += 60'000;
  }
  // State is kIdle after Stop, so the kExhausted early-return does NOT fire;
  // only the explicit budget check stands between here and a third spawn.
  assert(supervisor.state() == rd::SupervisorState::kIdle);
  assert(supervisor.spawns_used() == 2);
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("budget") != std::string::npos);
  assert(os.spawn_calls == 2);
  assert(os.open_fds.empty());
}

void BackoffPreventsAnImmediateRespawn() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(supervisor.Start(Request(), &error));
  os.running = false;
  assert(!supervisor.Poll());
  // Immediately retrying must be refused; the clock has not advanced.
  assert(!supervisor.Start(Request(), &error));
  assert(error.find("backing off") != std::string::npos);
  os.clock_ms += 60'000;
  os.running = true;
  assert(supervisor.Start(Request(), &error));
}

void EveryRespawnMintsANewEpochSoStaleFramesCannotRestoreAuthority() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(supervisor.Start(Request(), &error));
  const std::uint64_t first_epoch = supervisor.binding().epoch;
  const std::uint64_t first_seed = supervisor.binding().cookie_seed;
  os.running = false;
  assert(!supervisor.Poll());
  os.clock_ms += 60'000;
  os.running = true;
  assert(supervisor.Start(Request(), &error));
  const std::uint64_t second_epoch = supervisor.binding().epoch;
  // A restart under the SAME generation must not reuse the epoch, or a late
  // frame from the dead helper would authenticate against the new one.
  assert(second_epoch != first_epoch);
  assert(supervisor.binding().cookie_seed != first_seed);
  assert(os.epochs_issued.size() == 2);
  assert(os.epochs_issued[0] != os.epochs_issued[1]);
}

void GenerationChangeRetiresThePreviousHelper() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(supervisor.Start(Request(7), &error));
  const std::int32_t first_pid = 4242;
  const std::uint64_t first_epoch = supervisor.binding().epoch;

  assert(supervisor.Start(Request(8), &error));
  // The old helper is killed and reaped rather than adopted: a display owned by
  // a finished route must not be inherited by a new one.
  assert(!os.reaped.empty() && os.reaped[0] == first_pid);
  assert(supervisor.generation() == 8);
  assert(supervisor.binding().generation == 8);
  assert(supervisor.binding().epoch != first_epoch);
  // Descriptors from the retired helper are not leaked.
  assert(supervisor.open_descriptor_count() == 2);
  assert(os.open_fds.size() == 2);
  assert(os.double_closed.empty());
  // Budget resets with the new generation, so one bad route cannot starve the
  // next one.
  assert(supervisor.spawns_used() == 1);
}

void StopIsBoundedIdempotentAndSurvivesLateReplies() {
  FakeOs os;
  Revocations revocations;
  rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                               revocations.Callback());
  std::string error;
  assert(supervisor.Start(Request(), &error));
  supervisor.Stop(rd::AuthorityRevocation::kStopRequested);
  assert(!supervisor.admits_display_control());
  // A reply arriving now carries an epoch the supervisor no longer holds, and
  // the binding is already gone, so there is nothing for it to restore.
  assert(!supervisor.binding().IsValid());
  assert(supervisor.epoch() == 0);
  assert(os.open_fds.empty());
  assert(os.reaped.size() == 1);
  // Idempotent: a second Stop must not double-close or double-reap.
  supervisor.Stop(rd::AuthorityRevocation::kStopRequested);
  assert(os.reaped.size() == 1);
  assert(os.double_closed.empty());
}

void DestructorReclaimsEverything() {
  FakeOs os;
  Revocations revocations;
  {
    rd::MacosVirtualDisplaySupervisor supervisor({}, os.Seam(),
                                                 revocations.Callback());
    std::string error;
    assert(supervisor.Start(Request(), &error));
    assert(os.open_fds.size() == 2);
  }
  // Leaving scope must reap the pid and return both descriptors: a leaked
  // helper keeps a display alive with nobody owning it.
  assert(os.open_fds.empty());
  assert(os.reaped.size() == 1);
  assert(os.double_closed.empty());
}

void IncompleteSeamIsPermanentlyRefused() {
  Revocations revocations;
  rd::SupervisorSeam empty;
  rd::MacosVirtualDisplaySupervisor supervisor({}, empty, revocations.Callback());
  assert(supervisor.state() == rd::SupervisorState::kRefused);
  std::string error;
  assert(!supervisor.Start(Request(), &error));
  assert(!supervisor.admits_display_control());
}

}  // namespace

int main() {
  NobodySpawnedMeansNoAuthority();
  RootIsRefusedBeforeAnythingIsSpawned();
  CrossUserSupervisionIsRefused();
  UnverifiableHelperPathIsRefused();
  WrongReleaseIdentityOrDigestIsRefused();
  ReadyTimeoutRevokesAndReapsWithoutLeaking();
  CrashRevokesImmediatelyAndPollReportsFalse();
  CrashStormExhaustsTheBudgetInsteadOfRespawningForever();
  StopDoesNotRefundTheRestartBudget();
  BackoffPreventsAnImmediateRespawn();
  EveryRespawnMintsANewEpochSoStaleFramesCannotRestoreAuthority();
  GenerationChangeRetiresThePreviousHelper();
  StopIsBoundedIdempotentAndSurvivesLateReplies();
  DestructorReclaimsEverything();
  IncompleteSeamIsPermanentlyRefused();
  std::printf("macos virtual display supervisor counterfactual ok\n");
  return 0;
}
