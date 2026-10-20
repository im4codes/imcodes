// The resident virtual-display owner, as one assembled object.
//
// This is the composition the LaunchAgent runs. It exists as a type rather than
// as code inside main() for one reason: main() cannot be tested, and everything
// interesting here is a lifetime rule.
//
//   supervisor  owns the helper process
//   agent       owns the authority and the session binding
//   server      owns the control socket's decisions
//   THIS        owns the wiring between them, which is where they can disagree
//
// The disagreements it exists to prevent:
//
//   * The helper being started by anything other than an admitted grant. The
//     agent's start_helper seam is the ONLY path to the supervisor, so an
//     un-granted start is not merely refused, it is unreachable.
//   * The server holding a helper backend the supervisor has already torn down.
//     Every supervisor state change rebinds the server, including to null, and
//     rebinding drops every outstanding route.
//   * A revocation that stops the agent but leaves the helper running. Losing
//     the helper, the daemon, the session or the grant tears down both sides.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_H_

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "macos_virtual_display_control_server.h"
#include "macos_virtual_display_supervisor.h"

namespace imcodes::remote_desktop::macos {

/**
 * The OS facts the resident owner needs that are NOT already behind the
 * supervisor's or the agent's own seams.
 */
struct ResidentOwnerSeam {
  /** The authenticated root daemon, as the authority link proved it. */
  std::function<ControlPeerIdentity()> daemon_identity;
  /** The challenge that link minted, fixed for the life of the connection. */
  std::function<VirtualDisplayAuthorityChallenge()> authority_challenge;
  std::function<AgentSessionContext()> observe_session;
  std::function<SocketIdentity()> socket_identity;
  std::function<std::uint64_t()> now_ms;
  // NOTE: there is deliberately no `helper_holds_active_display` seam.
  //
  // It used to be supplied here, and the production caller wired it to a
  // literal `return false` -- so `display_control_admitted` was permanently
  // false and a real display could never be advertised. Only the owner holds
  // the supervised helper, so only the owner can answer this truthfully; it
  // now asks the helper directly and there is no field in which a caller can
  // substitute a constant.

  [[nodiscard]] bool IsComplete() const noexcept;
};

class MacosVirtualDisplayResidentOwner final {
 public:
  MacosVirtualDisplayResidentOwner(SupervisorPolicy policy,
                                   SupervisorSeam supervisor_seam,
                                   ResidentOwnerSeam seam);
  ~MacosVirtualDisplayResidentOwner();

  MacosVirtualDisplayResidentOwner(const MacosVirtualDisplayResidentOwner&) =
      delete;
  MacosVirtualDisplayResidentOwner& operator=(
      const MacosVirtualDisplayResidentOwner&) = delete;

  /** Answers one control line. This is the whole external surface. */
  [[nodiscard]] std::string Handle(const std::string& line);

  /**
   * Re-checks everything that could have moved: the helper, the session, the
   * socket's identity, the grant's expiry. Returns false once authority is
   * gone, and authority being gone is TERMINAL until a new grant arrives.
   */
  [[nodiscard]] bool Poll();

  /** Bounded teardown of both sides. Idempotent. */
  void Stop();

  [[nodiscard]] AgentOwnershipState state() const noexcept {
    return agent_.state();
  }
  [[nodiscard]] SupervisorState supervisor_state() const noexcept {
    return supervisor_.state();
  }
  [[nodiscard]] std::size_t route_count() const noexcept {
    return server_.route_count();
  }
  [[nodiscard]] std::string last_error() const { return last_error_; }
  /** Why authority last ended. Distinct so a field report is never ambiguous. */
  [[nodiscard]] AgentRevocation last_revocation() const noexcept {
    return last_revocation_;
  }

 private:
  /** Called by the agent when an admitted grant asks for a helper. */
  [[nodiscard]] bool StartHelper(const VirtualDisplayGrant& grant,
                                 std::string* error);
  void StopHelper();
  /** Rebinds the server to the current helper, or to nothing. */
  void RebindServer();

  ResidentOwnerSeam seam_;
  MacosVirtualDisplaySupervisor supervisor_;
  MacosVirtualDisplayAgent agent_;
  MacosVirtualDisplayControlServer server_;
  /** Rebuilt with every helper, because its binding is that helper's. */
  std::unique_ptr<MacosVirtualDisplayHelperBackend> helper_;
  std::string last_error_;
  AgentRevocation last_revocation_ = AgentRevocation::kNone;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_RESIDENT_H_
