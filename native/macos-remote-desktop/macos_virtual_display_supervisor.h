// Lifecycle owner for the resident virtual-display helper.
//
// The helper process IS the display's lifetime, so whoever supervises it holds
// the only teardown primitive this OS honours. That makes the supervision rules
// safety rules, not hygiene:
//
//   * A helper is spawned ONLY from the verified same-release sibling path. A
//     symlink there, or a binary whose identity does not match the selected
//     release, is refused outright -- not "warned about". The alternative is
//     handing display ownership to something we did not ship.
//   * It runs as the console (Aqua) uid. A root helper has no Aqua session, so
//     its display would not belong to the console user's topology at all.
//   * Its binding (uid, release identity, generation, unpredictable epoch and
//     challenge) is delivered on inherited fd 3. NEVER argv -- `ps` exposes
//     argv to every process of this uid, and a readable epoch is a forgeable
//     one. NEVER the environment either, for the same reason plus inheritance.
//   * Every failure -- crash, EOF, hung handshake -- revokes display authority
//     IMMEDIATELY. Readiness drops to false and the session fails closed. A
//     supervisor that waits to be sure is a supervisor that lets a stranded
//     display keep being advertised.
//   * A restart mints a NEW epoch. This is the rule that makes late frames from
//     the dead helper harmless: they carry the old epoch and can never restore
//     authority.
//   * Restarts are budgeted and backed off. A crash storm must degrade to "no
//     display control", never to an unbounded respawn loop against a
//     WindowServer that is already unhappy.
//
// Every OS effect is behind a seam so all of the above is provable with no
// process, no socket and no display.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_H_

#include <cstdint>
#include <functional>
#include <string>

#include "macos_virtual_display_helper_backend.h"
#include "macos_virtual_display_helper_binding.h"

namespace imcodes::remote_desktop::macos {

enum class SupervisorState {
  kIdle,        // nothing spawned; no authority
  kSpawning,    // process started, ready handshake outstanding
  kReady,       // bound, handshaken, authority granted
  kStopping,    // bounded teardown in progress
  kExhausted,   // restart budget spent; display control permanently off
  kRefused,     // preconditions failed (root, bad path/identity); never spawned
};

/** Why authority was dropped. Distinct so a field report is never ambiguous. */
enum class AuthorityRevocation {
  kNone,
  kSpawnFailed,
  kReadyTimeout,
  kHelperCrashed,
  kHelperClosedStream,
  kGenerationChanged,
  kStopRequested,
  kBudgetExhausted,
};

struct SupervisorPolicy {
  /** Bounded ready handshake. A helper that never says ready is a dead helper. */
  std::uint32_t ready_timeout_ms = 5'000;
  /** Total spawns allowed for one generation, first attempt included. */
  std::uint32_t max_spawns_per_generation = 3;
  std::uint32_t initial_backoff_ms = 250;
  std::uint32_t max_backoff_ms = 4'000;
  /** Bounded teardown before the pid is escalated and reaped. */
  std::uint32_t teardown_timeout_ms = 5'000;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct SupervisorLaunchRequest {
  std::uint64_t generation = 0;
  std::uint32_t console_uid = 0;
  std::string release_identity;
  /**
   * Lower-case hex SHA-256 of the helper, taken from the verified component
   * manifest. Required: without it "verified" would mean only "a file exists
   * next to us", which a replaced binary satisfies equally well.
   */
  std::string expected_helper_sha256;
  /**
   * Exact designated requirement from the verified release.
   *
   * A digest proves the bytes; only this proves the SIGNER. Required, because
   * "they would need both the binary and the manifest" is not a defence.
   */
  std::string expected_helper_designated_requirement;

  [[nodiscard]] bool IsValid() const noexcept;
};

/** One spawned helper, as the supervisor tracks it. */
struct SupervisedHelper {
  std::int32_t pid = 0;
  int binding_write_fd = -1;
  int control_fd = -1;
  std::uint64_t epoch = 0;

  [[nodiscard]] bool alive() const noexcept { return pid > 0; }
};

/**
 * Every OS effect. Injectable so the entire failure surface is provable
 * offline: no process is spawned, no descriptor opened, no display created.
 */
struct SupervisorSeam {
  /** euid of this process. Non-zero is required; root is refused. */
  std::function<std::uint32_t()> effective_uid;
  /**
   * Resolves the helper next to THIS executable and PROVES it belongs to the
   * selected release: regular file, not a symlink, enclosing directory equal to
   * the release identity, and content digest equal to the one the verified
   * manifest recorded. Both parameters are compared; neither is decorative.
   */
  std::function<bool(const std::string& release_identity,
                     const std::string& expected_sha256,
                     const std::string& expected_designated_requirement,
                     std::string* path, std::string* error)>
      resolve_verified_helper;
  /** Unpredictable epoch/challenge material from the system CSPRNG. */
  std::function<std::uint64_t()> random_u64;
  /**
   * posix_spawn with the binding pre-written to the child's fd 3. Returns the
   * pid and the parent-side descriptors, or false. The seam owns closing the
   * child ends; the supervisor owns the parent ends.
   */
  std::function<bool(const std::string& path,
                     const VirtualDisplayHelperBinding& binding,
                     SupervisedHelper* helper, std::string* error)>
      spawn_helper;
  /** Bounded ready handshake against the spawned helper. */
  std::function<bool(const SupervisedHelper& helper, std::uint32_t timeout_ms)>
      await_ready;
  /** True while the pid is still alive (non-blocking reap attempt). */
  std::function<bool(std::int32_t pid)> still_running;
  /** SIGTERM then, after the bounded wait, SIGKILL. Always reaps. */
  std::function<void(std::int32_t pid, std::uint32_t timeout_ms)> terminate_and_reap;
  /** Closes a parent-side descriptor exactly once. */
  std::function<void(int fd)> close_fd;
  std::function<std::uint64_t()> now_ms;

  [[nodiscard]] bool IsComplete() const noexcept;
};

/**
 * Notified the instant authority must stop being advertised.
 *
 * Called synchronously from the failure path on purpose: readiness must already
 * be false by the time anyone can observe the helper is gone.
 */
using AuthorityRevokedCallback =
    std::function<void(AuthorityRevocation reason, std::uint64_t epoch)>;

class MacosVirtualDisplaySupervisor final {
 public:
  MacosVirtualDisplaySupervisor(SupervisorPolicy policy,
                                SupervisorSeam seam,
                                AuthorityRevokedCallback on_revoked);
  ~MacosVirtualDisplaySupervisor();

  MacosVirtualDisplaySupervisor(const MacosVirtualDisplaySupervisor&) = delete;
  MacosVirtualDisplaySupervisor& operator=(const MacosVirtualDisplaySupervisor&) =
      delete;

  /**
   * Spawns and hands back the binding the worker must use.
   *
   * Refuses when running as root, when the helper cannot be verified, when the
   * request is malformed, or when the budget for this generation is spent.
   */
  [[nodiscard]] bool Start(const SupervisorLaunchRequest& request,
                           std::string* error);

  /**
   * Polls liveness. A dead or closed helper revokes authority here, and returns
   * false, so the caller's very next readiness answer is already false.
   */
  [[nodiscard]] bool Poll();

  /** Bounded teardown. Reclaims pid and every descriptor. Idempotent. */
  void Stop(AuthorityRevocation reason);

  [[nodiscard]] SupervisorState state() const noexcept { return state_; }
  [[nodiscard]] std::uint64_t epoch() const noexcept { return helper_.epoch; }
  [[nodiscard]] std::uint64_t generation() const noexcept { return generation_; }
  [[nodiscard]] std::uint32_t spawns_used() const noexcept { return spawns_used_; }
  [[nodiscard]] AuthorityRevocation last_revocation() const noexcept {
    return last_revocation_;
  }
  [[nodiscard]] std::string last_error() const { return last_error_; }
  /** The binding the worker must use. Empty epoch means "no authority". */
  [[nodiscard]] VirtualDisplayHelperBinding binding() const { return binding_; }
  /** True only in kReady. Everything else must advertise no display control. */
  [[nodiscard]] bool admits_display_control() const noexcept {
    return state_ == SupervisorState::kReady;
  }
  /** Open parent-side descriptors, for leak assertions. */
  [[nodiscard]] std::uint32_t open_descriptor_count() const noexcept;

  /**
   * The ONLY channel to the supervised helper.
   *
   * Bound to this supervisor's own socketpair descriptor, pid and epoch. It
   * exists because the worker previously built its backend from an exchange
   * that ignored the binding entirely and dialled a Unix socket named by an
   * environment variable -- a socket the spawn path never creates. That made
   * the production backend talk to something other than the helper just
   * spawned: normally nothing at all, and in the worst case a socket planted by
   * whoever set that variable.
   *
   * The returned callable refuses once the epoch it captured is no longer the
   * live one, so a stale exchange cannot outlive its helper.
   */
  [[nodiscard]] VirtualDisplayHelperExchange MakeBoundExchange();

 private:
  void Revoke(AuthorityRevocation reason);
  void ReleaseDescriptors();
  [[nodiscard]] std::uint32_t BackoffMs() const noexcept;

  SupervisorPolicy policy_;
  SupervisorSeam seam_;
  AuthorityRevokedCallback on_revoked_;
  SupervisorState state_ = SupervisorState::kIdle;
  SupervisedHelper helper_;
  VirtualDisplayHelperBinding binding_;
  std::uint64_t generation_ = 0;
  std::uint32_t spawns_used_ = 0;
  std::uint64_t next_spawn_allowed_at_ms_ = 0;
  AuthorityRevocation last_revocation_ = AuthorityRevocation::kNone;
  std::string last_error_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SUPERVISOR_H_
