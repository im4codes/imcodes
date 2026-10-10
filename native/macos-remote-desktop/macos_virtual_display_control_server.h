// The resident agent's control-socket dispatch.
//
// This is the process boundary the whole design rests on:
//
//   Node verified selector authority
//        -> authenticated control socket   <-- HERE
//             -> the single supervisor / helper owner
//                  -> zero-mutation readiness  +  route grants
//
// It exists as its own type, behind seams, because the interesting failures are
// all authorisation failures and none of them need a socket, a helper or a
// display to provoke.
//
// WHAT IT REFUSES, AND WHY EACH REFUSAL IS STRUCTURAL
//
//   * There is exactly ONE way in: the authenticated link to the root daemon.
//     The agent binds nothing, so there is no second entrance a different kind
//     of peer could arrive through. An earlier design gave the agent its own
//     listener and sorted callers out with a peer check; that put the whole
//     role separation on one branch being right.
//   * A route never receives the helper descriptor, the helper epoch or the
//     helper cookie seed. It receives a ROUTE capability, and the two
//     credentials never appear in the same message.
//   * A route may not release the helper. `Destroy` on a route's backend means
//     "this route is done", which is `disable` -- the display stays registered
//     and warm for the next route. Mapping it to `release` is what made the
//     display die with the route.
//   * Readiness never mutates. It cannot create, hold, enable or spawn. A
//     readiness probe that could create stranded one display per invocation,
//     permanently, because release-to-remove does not remove on macOS 26.x.
//   * A relay frame is never forwarded. Its credentials are checked, then a
//     FRESH helper command is authored with credentials the route has never
//     seen, so a forwarded frame and an authored one are indistinguishable to
//     the helper -- because they are the same thing.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_SERVER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_SERVER_H_

#include <cstdint>
#include <functional>
#include <map>
#include <string>

#include "macos_virtual_display_agent.h"
#include "macos_virtual_display_control_protocol.h"
#include "macos_virtual_display_helper_backend.h"

namespace imcodes::remote_desktop::macos {

/**
 * Bounded so a peer cannot make the agent remember an unbounded number of
 * routes. At the cap the server REFUSES a new route rather than evicting an
 * old one: evicting would silently drop a live route's replay floor, and a
 * dropped floor is a replay window.
 */
inline constexpr std::size_t kVirtualDisplayControlMaxRoutes = 32;

/**
 * What the server needs that is not already the link's job.
 *
 * There is no peer seam here any more. Every frame arrives on the ONE
 * authenticated link to the root daemon, so "is this peer allowed to present a
 * grant" is not a question the server can get wrong -- there is no second
 * entrance for a different kind of peer to arrive through. Role separation is
 * enforced by the absence of a door, not by a check at one.
 *
 * Readiness and route requests reach the daemon over the existing authenticated
 * Node IPC, and the daemon proxies them here on the same link. A worker never
 * speaks to the agent.
 */
struct ControlServerSeam {
  /** The authenticated daemon, as the link proved it. */
  std::function<ControlPeerIdentity()> daemon_identity;
  /**
   * The challenge the daemon minted on THIS connection.
   *
   * Every grant is checked against it before it is accepted. Without this the
   * agent would honour any structurally valid grant that reached the socket,
   * including one captured from a previous connection or minted for another
   * login window.
   */
  std::function<VirtualDisplayAuthorityChallenge()> authority_challenge;
  std::function<std::uint64_t()> now_ms;

  [[nodiscard]] bool IsComplete() const noexcept;
};

class MacosVirtualDisplayControlServer final {
 public:
  /**
   * `helper` is the agent's PRIVATE channel to the supervised helper. It is
   * borrowed, never exposed, and may be null while no helper is owned -- in
   * which case every relay is refused rather than deferred.
   */
  MacosVirtualDisplayControlServer(MacosVirtualDisplayAgent* agent,
                                   ControlServerSeam seam);

  MacosVirtualDisplayControlServer(const MacosVirtualDisplayControlServer&) =
      delete;
  MacosVirtualDisplayControlServer& operator=(
      const MacosVirtualDisplayControlServer&) = delete;

  /** Rebound whenever the supervisor produces a new helper. Null revokes. */
  void BindHelper(MacosVirtualDisplayHelperBackend* helper) noexcept;

  /**
   * Handles exactly one inbound line on one connection and returns the reply
   * line to write back.
   *
   * Never returns an empty string: a peer that gets no answer cannot tell a
   * refusal from a hang, and "cannot tell" is where retry storms come from.
   */
  [[nodiscard]] std::string Handle(const std::string& line);

  /** Routes issued but not yet superseded. For leak assertions. */
  [[nodiscard]] std::size_t route_count() const noexcept {
    return routes_.size();
  }

 private:
  /** One issued route capability, and its replay floor. */
  struct RouteRecord {
    /** The agent epoch this route was issued under. A new grant invalidates. */
    std::uint64_t agent_epoch = 0;
    std::uint64_t route_epoch = 0;
    std::uint64_t cookie_seed = 0;
    std::uint64_t highest_spent_index = 0;
  };

  [[nodiscard]] std::string HandleGrant(const std::string& line);
  [[nodiscard]] std::string HandleReady(
      const VirtualDisplayControlRequest& request);
  [[nodiscard]] std::string HandleRoute(
      const VirtualDisplayControlRequest& request);
  [[nodiscard]] std::string HandleRelay(
      const VirtualDisplayControlRequest& request);

  static std::string Refuse(const char* reason);

  MacosVirtualDisplayAgent* agent_;
  ControlServerSeam seam_;
  MacosVirtualDisplayHelperBackend* helper_ = nullptr;
  std::map<std::uint64_t, RouteRecord> routes_;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_CONTROL_SERVER_H_
