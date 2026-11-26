#include "macos_virtual_display_resident.h"

#include <utility>

namespace imcodes::remote_desktop::macos {
namespace {

/**
 * Route generation the supervisor binds the helper to.
 *
 * The helper serves the RESIDENT owner, not any one route, so it is bound to a
 * single generation for its whole life and individual routes are separated by
 * their own capabilities instead. Binding it per-route was the shape that made
 * the display die with the route.
 */
constexpr std::uint64_t kResidentHelperGeneration = 1;

}  // namespace

bool ResidentOwnerSeam::IsComplete() const noexcept {
  // Wholesale, never partial: a partly wired owner answers some questions
  // correctly and others by accident, and the accidental ones are the
  // authorisation questions.
  return daemon_identity != nullptr && authority_challenge != nullptr &&
         observe_session != nullptr && socket_identity != nullptr &&
         now_ms != nullptr;
}

MacosVirtualDisplayResidentOwner::MacosVirtualDisplayResidentOwner(
    SupervisorPolicy policy,
    SupervisorSeam supervisor_seam,
    ResidentOwnerSeam seam)
    : seam_(std::move(seam)),
      supervisor_(policy,
                  std::move(supervisor_seam),
                  [this](AuthorityRevocation, std::uint64_t) {
                    // The supervisor lost the helper. The server must stop
                    // advertising it BEFORE anyone can observe the loss, so this
                    // runs synchronously rather than being posted.
                    helper_.reset();
                    RebindServer();
                  }),
      agent_(
          [this] {
            AgentSeam agent_seam;
            agent_seam.daemon_identity = seam_.daemon_identity;
            agent_seam.observe_session = seam_.observe_session;
            agent_seam.socket_identity = seam_.socket_identity;
            agent_seam.now_ms = seam_.now_ms;
            // The ONLY path from an admitted grant to a running helper. An
            // un-granted start is not refused here, it is unreachable.
            agent_seam.start_helper = [this](const VirtualDisplayGrant& grant,
                                             std::string* error) {
              return StartHelper(grant, error);
            };
            agent_seam.helper_alive = [this] {
              return supervisor_.admits_display_control();
            };
            agent_seam.stop_helper = [this] { StopHelper(); };
            // Answered from the supervised helper itself, by a bounded
            // status read. Zero mutation: QueryAdmitted asks whether a display
            // is held AND active; it cannot create, hold or enable one.
            agent_seam.helper_holds_active_display = [this] {
              return helper_ != nullptr && helper_->QueryAdmitted();
            };
            return agent_seam;
          }(),
          [this](AgentRevocation reason) {
            // OBSERVER ONLY. The teardown already happened: the agent invokes
            // its own stop_helper seam, which is wired to StopHelper(), before
            // it announces the revocation. Tearing down again here would be a
            // SECOND path to the same effect, and two paths to one effect are
            // two things to keep in step -- a mutation that deleted this body
            // changed no behaviour, which is how the duplication was found.
            last_revocation_ = reason;
          }),
      server_(&agent_, [this] {
        ControlServerSeam server_seam;
        server_seam.daemon_identity = seam_.daemon_identity;
        server_seam.authority_challenge = seam_.authority_challenge;
        server_seam.now_ms = seam_.now_ms;
        return server_seam;
      }()) {}

MacosVirtualDisplayResidentOwner::~MacosVirtualDisplayResidentOwner() {
  Stop();
}

bool MacosVirtualDisplayResidentOwner::StartHelper(
    const VirtualDisplayGrant& grant,
    std::string* error) {
  if (!seam_.IsComplete()) {
    if (error != nullptr) *error = "resident_owner_not_wired";
    return false;
  }
  SupervisorLaunchRequest request;
  request.generation = kResidentHelperGeneration;
  request.console_uid = grant.uid;
  // Every one of these comes from the GRANT, which the daemon minted after
  // verifying the artifact set. None is read from the filesystem next to us,
  // and none is read from the environment: both were tried and both let
  // whoever could write there choose the binary we would run.
  request.release_identity = grant.release_identity;
  request.expected_helper_sha256 = grant.helper_sha256;
  request.expected_helper_designated_requirement =
      grant.helper_designated_requirement;

  if (!supervisor_.Start(request, error)) {
    last_error_ = supervisor_.last_error();
    helper_.reset();
    RebindServer();
    return false;
  }

  MacosVirtualDisplayHelperOptions options;
  options.binding = supervisor_.binding();
  // Built from the supervisor's OWN bound exchange, which is tied to the
  // socketpair, pid and epoch of the helper it just spawned. An exchange that
  // dialled a named socket would talk to whatever was at that name.
  helper_ = std::make_unique<MacosVirtualDisplayHelperBackend>(
      options, supervisor_.MakeBoundExchange());
  RebindServer();
  return true;
}

void MacosVirtualDisplayResidentOwner::StopHelper() {
  // Order matters: stop advertising first, then tear down. The reverse leaves a
  // window in which the server would hand out a capability against a helper
  // that is already going away.
  helper_.reset();
  RebindServer();
  supervisor_.Stop(AuthorityRevocation::kStopRequested);
}

void MacosVirtualDisplayResidentOwner::RebindServer() {
  // Rebinding drops every outstanding route, including when rebinding to
  // nothing. Silently re-pointing a live route at a fresh helper would hand it
  // a DIFFERENT display, under a new epoch, without the peer ever being told.
  server_.BindHelper(helper_.get());
}

std::string MacosVirtualDisplayResidentOwner::Handle(const std::string& line) {
  return server_.Handle(line);
}

bool MacosVirtualDisplayResidentOwner::Poll() {
  // The supervisor first: it is the one that can observe a dead helper, and its
  // revocation callback has already unbound the server by the time the agent is
  // asked anything.
  const bool helper_ok = supervisor_.Poll();
  const bool agent_ok = agent_.Poll();
  if (!helper_ok || !agent_ok) last_error_ = agent_.last_error();
  return helper_ok && agent_ok;
}

void MacosVirtualDisplayResidentOwner::Stop() {
  agent_.Revoke(AgentRevocation::kStopRequested);
  StopHelper();
}

}  // namespace imcodes::remote_desktop::macos
