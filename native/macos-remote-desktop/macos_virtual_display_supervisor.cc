#include "macos_virtual_display_supervisor.h"

#include <algorithm>
#include <utility>

namespace imcodes::remote_desktop::macos {

bool SupervisorPolicy::IsValid() const noexcept {
  return ready_timeout_ms > 0 && ready_timeout_ms <= 30'000 &&
         max_spawns_per_generation > 0 && max_spawns_per_generation <= 8 &&
         initial_backoff_ms > 0 && initial_backoff_ms <= max_backoff_ms &&
         max_backoff_ms <= 60'000 && teardown_timeout_ms > 0 &&
         teardown_timeout_ms <= 30'000;
}

bool SupervisorLaunchRequest::IsValid() const noexcept {
  // A zero uid is root, and root has no Aqua session. A zero generation cannot
  // be attributed to a route. Neither is a default worth tolerating.
  if (generation == 0 || console_uid == 0 || release_identity.empty() ||
      release_identity.size() > 96) {
    return false;
  }
  // A malformed or absent digest must not be tolerated: it is the only field
  // that ties the spawned bytes to the verified release.
  if (expected_helper_sha256.size() != 64)
    return false;
  // The signer check is not optional: a blank requirement would silently skip
  // SecStaticCodeCheckValidity and leave only the digest standing.
  if (expected_helper_designated_requirement.empty() ||
      expected_helper_designated_requirement.size() > 512) {
    return false;
  }
  for (const char character : expected_helper_sha256) {
    const bool hex = (character >= '0' && character <= '9') ||
                     (character >= 'a' && character <= 'f');
    if (!hex)
      return false;
  }
  return true;
}

bool SupervisorSeam::IsComplete() const noexcept {
  return effective_uid && resolve_verified_helper && random_u64 &&
         spawn_helper && await_ready && still_running && terminate_and_reap &&
         close_fd && now_ms;
}

MacosVirtualDisplaySupervisor::MacosVirtualDisplaySupervisor(
    SupervisorPolicy policy,
    SupervisorSeam seam,
    AuthorityRevokedCallback on_revoked)
    : policy_(std::move(policy)),
      seam_(std::move(seam)),
      on_revoked_(std::move(on_revoked)) {
  if (!policy_.IsValid() || !seam_.IsComplete()) {
    // An incomplete seam is a permanently refused supervisor, not one that
    // might work later. Anything else would let a misconfigured composition
    // look merely "not started yet".
    state_ = SupervisorState::kRefused;
    last_error_ = "supervisor policy or OS seam is incomplete";
  }
}

MacosVirtualDisplaySupervisor::~MacosVirtualDisplaySupervisor() {
  Stop(AuthorityRevocation::kStopRequested);
}

std::uint32_t MacosVirtualDisplaySupervisor::open_descriptor_count()
    const noexcept {
  std::uint32_t count = 0;
  if (helper_.binding_write_fd >= 0) ++count;
  if (helper_.control_fd >= 0) ++count;
  return count;
}

std::uint32_t MacosVirtualDisplaySupervisor::BackoffMs() const noexcept {
  std::uint64_t backoff = policy_.initial_backoff_ms;
  for (std::uint32_t index = 1; index < spawns_used_; ++index) {
    backoff *= 2U;
    if (backoff >= policy_.max_backoff_ms)
      return policy_.max_backoff_ms;
  }
  return static_cast<std::uint32_t>(
      std::min<std::uint64_t>(backoff, policy_.max_backoff_ms));
}

void MacosVirtualDisplaySupervisor::ReleaseDescriptors() {
  // Exactly once each, and reset to -1 so a second Stop cannot double-close.
  if (helper_.binding_write_fd >= 0) {
    seam_.close_fd(helper_.binding_write_fd);
    helper_.binding_write_fd = -1;
  }
  if (helper_.control_fd >= 0) {
    seam_.close_fd(helper_.control_fd);
    helper_.control_fd = -1;
  }
}

void MacosVirtualDisplaySupervisor::Revoke(AuthorityRevocation reason) {
  const std::uint64_t revoked_epoch = helper_.epoch;
  last_revocation_ = reason;
  // The binding is cleared BEFORE anything else so that a caller reading it
  // during the callback cannot still act under the dead helper's authority.
  binding_ = VirtualDisplayHelperBinding{};
  if (on_revoked_)
    on_revoked_(reason, revoked_epoch);
}

bool MacosVirtualDisplaySupervisor::Start(const SupervisorLaunchRequest& request,
                                          std::string* error) {
  const auto fail = [&](const std::string& message) {
    last_error_ = message;
    if (error != nullptr) *error = message;
    return false;
  };
  if (state_ == SupervisorState::kRefused)
    return fail(last_error_);
  if (!request.IsValid())
    return fail("invalid supervisor launch request");

  // A generation change retires the previous helper outright. Reusing it would
  // let a display owned by a finished route be adopted by a new one.
  if (state_ != SupervisorState::kIdle && generation_ != request.generation) {
    Stop(AuthorityRevocation::kGenerationChanged);
    spawns_used_ = 0;
    next_spawn_allowed_at_ms_ = 0;
  }
  if (state_ == SupervisorState::kReady && generation_ == request.generation)
    return true;  // already serving this generation
  if (state_ == SupervisorState::kExhausted && generation_ == request.generation)
    return fail("virtual-display helper restart budget is exhausted");

  // Root has no Aqua session, so a display it created would not belong to the
  // console user's topology. Refuse before doing anything else.
  const std::uint32_t euid = seam_.effective_uid();
  if (euid == 0)
    return fail("virtual-display helper must not be supervised by root");
  // No cross-user or cross-ASID migration: the helper must run as the console
  // user this supervisor is actually running as.
  if (euid != request.console_uid)
    return fail("supervisor uid does not match the console session uid");

  if (spawns_used_ >= policy_.max_spawns_per_generation) {
    state_ = SupervisorState::kExhausted;
    Revoke(AuthorityRevocation::kBudgetExhausted);
    return fail("virtual-display helper restart budget is exhausted");
  }
  const std::uint64_t now = seam_.now_ms();
  if (now < next_spawn_allowed_at_ms_)
    return fail("virtual-display helper respawn is backing off");

  std::string path;
  std::string resolve_error;
  if (!seam_.resolve_verified_helper(
          request.release_identity, request.expected_helper_sha256,
          request.expected_helper_designated_requirement, &path,
          &resolve_error)) {
    // Not a warning. A symlink or a mismatched identity at the sibling path
    // means handing display ownership to something we did not ship.
    return fail(resolve_error.empty()
                    ? "virtual-display helper could not be verified"
                    : resolve_error);
  }

  VirtualDisplayHelperBinding binding;
  binding.uid = request.console_uid;
  binding.generation = request.generation;
  binding.release_identity = request.release_identity;
  // A NEW epoch on every spawn, including restarts. This is what makes a late
  // frame from the previous helper harmless: it carries the old epoch and can
  // never restore authority.
  binding.epoch = seam_.random_u64();
  binding.cookie_seed = seam_.random_u64();
  if (binding.epoch == 0) binding.epoch = 1;
  if (binding.cookie_seed == 0) binding.cookie_seed = 1;
  if (!binding.IsValid())
    return fail("could not mint a valid helper binding");

  SupervisedHelper spawned;
  std::string spawn_error;
  ++spawns_used_;
  generation_ = request.generation;
  state_ = SupervisorState::kSpawning;
  if (!seam_.spawn_helper(path, binding, &spawned, &spawn_error)) {
    next_spawn_allowed_at_ms_ = now + BackoffMs();
    state_ = spawns_used_ >= policy_.max_spawns_per_generation
                 ? SupervisorState::kExhausted
                 : SupervisorState::kIdle;
    Revoke(AuthorityRevocation::kSpawnFailed);
    return fail(spawn_error.empty() ? "could not spawn the virtual-display helper"
                                    : spawn_error);
  }
  helper_ = spawned;
  helper_.epoch = binding.epoch;

  // Bounded ready handshake. A helper that never reports ready is a dead
  // helper, and waiting longer only delays failing closed.
  if (!seam_.await_ready(helper_, policy_.ready_timeout_ms)) {
    seam_.terminate_and_reap(helper_.pid, policy_.teardown_timeout_ms);
    helper_.pid = 0;
    ReleaseDescriptors();
    next_spawn_allowed_at_ms_ = seam_.now_ms() + BackoffMs();
    state_ = spawns_used_ >= policy_.max_spawns_per_generation
                 ? SupervisorState::kExhausted
                 : SupervisorState::kIdle;
    Revoke(AuthorityRevocation::kReadyTimeout);
    return fail("virtual-display helper did not report ready in time");
  }

  binding_ = binding;
  state_ = SupervisorState::kReady;
  last_revocation_ = AuthorityRevocation::kNone;
  last_error_.clear();
  return true;
}

bool MacosVirtualDisplaySupervisor::Poll() {
  if (state_ != SupervisorState::kReady)
    return false;
  if (helper_.pid > 0 && seam_.still_running(helper_.pid))
    return true;
  // Crash or clean exit -- either way the display's owner is gone, so authority
  // must already be false by the time anyone can observe it.
  seam_.terminate_and_reap(helper_.pid, policy_.teardown_timeout_ms);
  helper_.pid = 0;
  ReleaseDescriptors();
  next_spawn_allowed_at_ms_ = seam_.now_ms() + BackoffMs();
  state_ = spawns_used_ >= policy_.max_spawns_per_generation
               ? SupervisorState::kExhausted
               : SupervisorState::kIdle;
  Revoke(AuthorityRevocation::kHelperCrashed);
  return false;
}

void MacosVirtualDisplaySupervisor::Stop(AuthorityRevocation reason) {
  if (state_ == SupervisorState::kRefused)
    return;
  if (state_ == SupervisorState::kIdle && helper_.pid == 0 &&
      open_descriptor_count() == 0) {
    return;  // idempotent
  }
  state_ = SupervisorState::kStopping;
  if (helper_.pid > 0) {
    seam_.terminate_and_reap(helper_.pid, policy_.teardown_timeout_ms);
    helper_.pid = 0;
  }
  ReleaseDescriptors();
  // The epoch is cleared last: a reply that arrives during teardown carries the
  // old epoch and, with the binding already gone, has nothing to restore.
  Revoke(reason);
  helper_.epoch = 0;
  state_ = SupervisorState::kIdle;
}

}  // namespace imcodes::remote_desktop::macos
