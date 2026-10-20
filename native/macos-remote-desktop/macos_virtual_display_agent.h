// The resident LaunchAgent's virtual-display ownership.
//
// ONE OWNER. The agent outlives every route, so it is the only thing that can
// own a process whose lifetime IS a display's lifetime. A route worker owning
// the helper meant the display died with the route and the authority was one
// the worker invented; both were removed.
//
// The chain this type sits in the middle of:
//
//   Node verified selector authority
//        -> authenticated control socket (peer identity checked HERE)
//             -> this agent, the single supervisor/helper owner
//                  -> zero-mutation readiness  +  route grants
//
// Four rules it exists to enforce, each because the alternative was tried:
//
//   * The peer that presents a grant must BE the daemon. A socket of the right
//     name is not a peer of the right identity, and any process of this uid can
//     make one.
//   * Readiness NEVER mutates. A readiness probe that could create a display
//     stranded one per invocation, permanently, because release-to-remove does
//     not remove on macOS 26.x.
//   * A route client gets a GRANT, never the helper descriptor. Handing down a
//     raw fd hands down the ability to talk to the helper directly, forever,
//     with no generation attached.
//   * Losing the helper, the daemon, or the session revokes authority
//     immediately and terminally. Silently re-binding a live route to a fresh
//     helper hands that route a different display, under a new epoch, without
//     the peer ever being told.
//
// Every OS effect is behind a seam, so all of the above is provable with no
// agent, no socket, no process and no display.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AGENT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AGENT_H_

#include <cstdint>
#include <functional>
#include <string>

#include "macos_virtual_display_authority_link.h"
#include "macos_virtual_display_challenge_ledger.h"
#include "macos_virtual_display_grant.h"

namespace imcodes::remote_desktop::macos {

enum class AgentOwnershipState {
  kIdle,       // no grant consumed; nothing owned
  kOwning,     // grant admitted, helper owned
  kRevoked,    // authority dropped; terminal until a NEW grant arrives
};

/** Why ownership ended. Distinct so a field report is never ambiguous. */
enum class AgentRevocation {
  kNone,
  kHelperLost,        // the helper process died or closed its stream
  kDaemonDisconnected,// the control peer went away
  kSessionChanged,    // uid / audit session / session type moved under us
  kServiceGenerationChanged,
  kGrantExpired,
  kStopRequested,
};

/**
 * What the agent proves about whoever presented a grant.
 *
 * There is exactly ONE inbound channel -- the authenticated link to the root
 * daemon -- so `uid` here is the daemon's, and it is ZERO. An earlier version
 * required `uid != 0`, which would have refused the only legitimate peer this
 * type can ever describe: it was written when several kinds of peer shared one
 * listener, and that listener no longer exists.
 *
 * `authenticated` is set by the link, and only after the link has proven both
 * halves: root answered, and the object dialled could only have been placed by
 * root. This struct never derives it.
 */
struct ControlPeerIdentity {
  /** The daemon's euid. Zero is the expected and only admissible value. */
  std::uint32_t uid = 0;
  std::int32_t pid = 0;
  /** Set by the authority link after it authenticated the daemon. */
  bool authenticated = false;

  [[nodiscard]] bool IsValid() const noexcept {
    // Root, a real process, and proven by the link. A default-constructed
    // value is still refused, because `authenticated` defaults to false.
    return uid == 0 && pid > 0 && authenticated;
  }
};

/**
 * Identity of the control socket itself, for ABA detection.
 *
 * A path is not an identity: the socket can be unlinked and recreated between
 * two observations, and the agent would go on serving a peer bound to a
 * different object under the same name. Device plus inode is what actually
 * names the object.
 */
struct SocketIdentity {
  std::uint64_t device = 0;
  std::uint64_t inode = 0;

  [[nodiscard]] bool IsValid() const noexcept { return inode != 0; }
  [[nodiscard]] bool Matches(const SocketIdentity& other) const noexcept {
    return device == other.device && inode == other.inode;
  }
};

struct AgentSeam {
  /**
   * The authenticated root daemon, as the authority link proved it.
   *
   * Takes no descriptor: there is one channel, and the link authenticated it
   * once, before any frame was read. Asking per-frame would imply there is a
   * per-frame decision to make, and there is not.
   */
  std::function<ControlPeerIdentity()> daemon_identity;
  /** The session this agent is actually running in, observed live. */
  std::function<AgentSessionContext()> observe_session;
  /** dev+ino of the bound control socket, for ABA detection. */
  std::function<SocketIdentity()> socket_identity;
  std::function<std::uint64_t()> now_ms;
  /** Starts the single supervised helper. False leaves the agent unowning. */
  std::function<bool(const VirtualDisplayGrant& grant, std::string* error)>
      start_helper;
  /** True while the helper is alive AND answering. */
  std::function<bool()> helper_alive;
  /** Bounded teardown of the helper. Always reaps. */
  std::function<void()> stop_helper;
  /** Side-effect-free helper status for readiness. Must never mutate. */
  std::function<bool()> helper_holds_active_display;

  [[nodiscard]] bool IsComplete() const noexcept;
};

/** A capability handed to one route. Never the helper descriptor. */
struct RouteDisplayGrant {
  std::uint64_t route_generation = 0;
  std::uint64_t epoch = 0;
  std::uint64_t cookie_seed = 0;
  std::uint32_t uid = 0;

  [[nodiscard]] bool IsValid() const noexcept {
    return route_generation != 0 && epoch != 0 && cookie_seed != 0 && uid != 0;
  }
};

/** Answer to a readiness probe. Deliberately carries no capability. */
struct AgentReadinessAnswer {
  /** Echoes the caller's nonce so an answer cannot be replayed as a fresh one. */
  std::uint64_t nonce = 0;
  /** A live, bound, supervised helper exists. Says nothing about a display. */
  bool qualified_to_create = false;
  /** A display is held AND active. This is the only thing that may be claimed. */
  bool display_control_admitted = false;
};

class MacosVirtualDisplayAgent final {
 public:
  MacosVirtualDisplayAgent(AgentSeam seam,
                           std::function<void(AgentRevocation)> on_revoked);

  MacosVirtualDisplayAgent(const MacosVirtualDisplayAgent&) = delete;
  MacosVirtualDisplayAgent& operator=(const MacosVirtualDisplayAgent&) = delete;

  /**
   * Consumes a grant that arrived on the authenticated link to the root daemon.
   *
   * The link is checked BEFORE the grant is parsed: a grant is only as good as
   * the channel it arrived on, and parsing first would mean doing work on
   * behalf of a caller nobody has identified.
   *
   * `challenge` is REQUIRED, not optional, and that is the point. The rule it
   * carries -- that this grant is the one the daemon promised on THIS
   * authenticated connection -- lived in a free function that production never
   * called: the control server went straight to AcceptGrant and the predicate
   * was exercised only by its own unit test. Making it a parameter means a
   * caller cannot reach this function without supplying the thing that binds
   * the grant to the channel.
   */
  [[nodiscard]] bool AcceptGrant(const std::string& grant_line,
                                 const VirtualDisplayAuthorityChallenge& challenge,
                                 std::string* error);

  /**
   * ZERO MUTATION. Never spawns, never holds, never enables, never creates.
   *
   * `qualified_to_create` may be true with no display present -- that is the
   * headless case, and conflating it with the advertisement deadlocks the
   * first create. `display_control_admitted` stays the strict question.
   */
  [[nodiscard]] AgentReadinessAnswer Readiness(std::uint64_t nonce);

  /** Issues a route capability. The helper descriptor is never handed down. */
  [[nodiscard]] bool IssueRouteGrant(std::uint64_t route_generation,
                                     RouteDisplayGrant* grant,
                                     std::string* error);

  /**
   * Re-checks everything that could have moved: helper liveness, the session,
   * the control socket's identity, and grant expiry. Any change revokes.
   */
  [[nodiscard]] bool Poll();

  void Revoke(AgentRevocation reason);

  [[nodiscard]] AgentOwnershipState state() const noexcept { return state_; }
  [[nodiscard]] AgentRevocation last_revocation() const noexcept {
    return last_revocation_;
  }
  [[nodiscard]] std::uint64_t epoch() const noexcept { return epoch_; }
  [[nodiscard]] std::string last_error() const { return last_error_; }
  /** Ledger occupancy, so a test can prove rotation actually frees entries. */
  [[nodiscard]] std::size_t ledger_size() const { return challenges_.size(); }

 private:
  AgentSeam seam_;
  std::function<void(AgentRevocation)> on_revoked_;
  AgentOwnershipState state_ = AgentOwnershipState::kIdle;
  AgentRevocation last_revocation_ = AgentRevocation::kNone;
  VirtualDisplayGrant grant_;
  AgentSessionContext bound_session_;
  SocketIdentity bound_socket_;
  /** Generation-scoped, reserve/commit/rollback. Not a single string. */
  VirtualDisplayChallengeLedger challenges_;
  std::uint64_t epoch_ = 0;
  std::uint64_t cookie_seed_ = 0;
  std::uint64_t issued_routes_ = 0;
  std::string last_error_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AGENT_H_
