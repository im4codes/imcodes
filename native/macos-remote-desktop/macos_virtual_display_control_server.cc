#include "macos_virtual_display_control_server.h"

#include <utility>

#include "macos_virtual_display_helper_binding.h"

namespace imcodes::remote_desktop::macos {

bool ControlServerSeam::IsComplete() const noexcept {
  // Wholesale, never partial. A server missing one seam would answer some
  // questions correctly and others by accident, and the accidental ones are
  // exactly the authorisation questions.
  return daemon_identity != nullptr && authority_challenge != nullptr &&
         now_ms != nullptr;
}

MacosVirtualDisplayControlServer::MacosVirtualDisplayControlServer(
    MacosVirtualDisplayAgent* agent,
    ControlServerSeam seam)
    : agent_(agent), seam_(std::move(seam)) {}

void MacosVirtualDisplayControlServer::BindHelper(
    MacosVirtualDisplayHelperBackend* helper) noexcept {
  helper_ = helper;
  // Every previously issued route dies with the helper it was issued against.
  // Silently re-binding a live route to a fresh helper hands that route a
  // DIFFERENT display, under a new epoch, without the peer ever being told.
  routes_.clear();
}

std::string MacosVirtualDisplayControlServer::Refuse(const char* reason) {
  VirtualDisplayControlReply reply;
  reply.ok = false;
  reply.error = reason;
  std::string line = SerializeVirtualDisplayControlReply(reply);
  if (line.empty()) {
    // Unreachable for the closed set of reasons this file uses, but a caller
    // must never receive an empty answer: silence is indistinguishable from a
    // hang, and that is where retry storms come from.
    line = std::string(kVirtualDisplayControlReplyPrefix) +
           "ok=0 error=control_internal";
  }
  return line;
}

std::string MacosVirtualDisplayControlServer::Handle(const std::string& line) {
  if (agent_ == nullptr || !seam_.IsComplete())
    return Refuse("control_unavailable");

  // LINK FIRST, ALWAYS. The frame is only as good as the channel it arrived on,
  // and parsing first would mean doing work on behalf of a caller nobody has
  // identified. There is no per-frame peer decision left to make: the link
  // either authenticated the root daemon or it did not.
  const ControlPeerIdentity daemon = seam_.daemon_identity();
  if (!daemon.IsValid()) return Refuse("link_unauthenticated");

  switch (ClassifyVirtualDisplayControlFrame(line)) {
    case VirtualDisplayControlFrame::kGrant:
      return HandleGrant(line);
    case VirtualDisplayControlFrame::kControl:
      break;
    case VirtualDisplayControlFrame::kUnknown:
      return Refuse("control_prefix_unknown");
  }

  VirtualDisplayControlRequest request;
  std::string error;
  if (!ParseVirtualDisplayControlRequest(line, &request, &error))
    return Refuse("control_frame_rejected");

  switch (request.verb) {
    case VirtualDisplayControlVerb::kReady:
      return HandleReady(request);
    case VirtualDisplayControlVerb::kRoute:
      return HandleRoute(request);
    case VirtualDisplayControlVerb::kRelay:
      return HandleRelay(request);
    case VirtualDisplayControlVerb::kInvalid:
      break;
  }
  return Refuse("control_frame_rejected");
}

std::string MacosVirtualDisplayControlServer::HandleGrant(
    const std::string& line) {
  // No "is this the daemon" test, because there is nobody else on this channel.
  // The link proved root answered AND that the object it dialled could only
  // have been placed by root, before a single byte was read.
  std::string error;
  if (!agent_->AcceptGrant(line, seam_.authority_challenge(), &error))
    return Refuse("grant_refused");

  // A new grant means a new agent epoch, so every route issued under the old
  // one is stale. Dropped here rather than left to expire: a route holding a
  // capability from a superseded authority is a route the daemon never
  // authorised.
  routes_.clear();

  VirtualDisplayControlReply reply;
  reply.ok = true;
  std::string answered = SerializeVirtualDisplayControlReply(reply);
  return answered.empty() ? Refuse("control_internal") : answered;
}

std::string MacosVirtualDisplayControlServer::HandleReady(
    const VirtualDisplayControlRequest& request) {
  // ZERO MUTATION. Readiness is answered from state the agent already has: it
  // does not spawn, hold, enable or create. Any peer of this uid may ask -- the
  // answer is a boolean about the machine, not a capability.
  const AgentReadinessAnswer answer = agent_->Readiness(request.nonce);

  VirtualDisplayControlReply reply;
  reply.ok = true;
  reply.nonce = answer.nonce;
  reply.qualified_to_create = answer.qualified_to_create;
  reply.display_control_admitted = answer.display_control_admitted;
  std::string line = SerializeVirtualDisplayControlReply(reply);
  return line.empty() ? Refuse("control_internal") : line;
}

std::string MacosVirtualDisplayControlServer::HandleRoute(
    const VirtualDisplayControlRequest& request) {
  if (helper_ == nullptr) return Refuse("helper_not_owned");

  // Refuses at the cap rather than evicting. Evicting an old route would drop
  // its replay floor, and a dropped floor is a replay window -- the exact bug
  // the floor exists to close.
  if (routes_.find(request.route_generation) == routes_.end() &&
      routes_.size() >= kVirtualDisplayControlMaxRoutes) {
    return Refuse("route_table_full");
  }

  RouteDisplayGrant grant;
  std::string error;
  if (!agent_->IssueRouteGrant(request.route_generation, &grant, &error))
    return Refuse("route_not_admitted");
  if (!grant.IsValid()) return Refuse("route_not_admitted");

  // The capability is for the console uid the AGENT is bound to -- which the
  // agent derived from the kernel, not from anything the daemon said. The
  // daemon proxies on behalf of a worker it authenticated over Node IPC, but it
  // cannot ask for a capability into a session this agent is not in.
  if (grant.uid == 0) return Refuse("route_not_admitted");

  RouteRecord record;
  record.agent_epoch = agent_->epoch();
  record.route_epoch = grant.epoch;
  record.cookie_seed = grant.cookie_seed;
  // Re-issuing a generation resets its floor, which is correct: the seed is new
  // too, so no captured frame from the previous issue can derive a cookie that
  // matches. Keeping the old floor would only reject the new route's own first
  // request.
  record.highest_spent_index = 0;
  routes_[request.route_generation] = record;

  VirtualDisplayControlReply reply;
  reply.ok = true;
  reply.route_generation = grant.route_generation;
  reply.route_epoch = grant.epoch;
  reply.cookie_seed = grant.cookie_seed;
  reply.uid = grant.uid;
  // Deliberately nothing else. No descriptor, no path, no helper epoch, no
  // helper cookie seed.
  std::string line = SerializeVirtualDisplayControlReply(reply);
  return line.empty() ? Refuse("control_internal") : line;
}

std::string MacosVirtualDisplayControlServer::HandleRelay(
    const VirtualDisplayControlRequest& request) {
  if (helper_ == nullptr) return Refuse("helper_not_owned");

  const auto found = routes_.find(request.route_generation);
  if (found == routes_.end()) return Refuse("route_unknown");
  RouteRecord& record = found->second;

  // A route issued under a previous authority is stale even though its
  // credentials still verify. The agent's epoch moves when the daemon presents
  // a new grant, and a capability from a superseded authority was never
  // authorised by the current one.
  if (record.agent_epoch != agent_->epoch()) {
    routes_.erase(found);
    return Refuse("route_epoch_stale");
  }
  if (record.route_epoch != request.route_epoch)
    return Refuse("route_epoch_mismatch");
  // Strictly advancing. Equality is a replay too: a captured frame resent
  // unchanged carries an index that is no longer above the floor.
  if (request.request_index <= record.highest_spent_index)
    return Refuse("route_replay");
  // Derived from the seed this agent issued, so a peer that never received the
  // seed cannot mint one, and observing one frame does not yield the next.
  if (request.route_cookie !=
      DeriveHelperCookie(record.cookie_seed, request.request_index)) {
    return Refuse("route_cookie_unbound");
  }

  // SPENT BEFORE THE ACTION, not after. If the helper call throws, hangs or
  // half-succeeds, the index must still be burned -- otherwise a peer could
  // resend the identical frame and get a second attempt at the same action
  // under the same credential.
  record.highest_spent_index = request.request_index;

  // A FRESH command, authored here. Nothing the route sent about credentials
  // survives: the helper epoch, cookie and request index are stamped by the
  // backend from the launch binding the route has never seen.
  VirtualDisplayHelperCommand command;
  command.verb = request.helper_verb;
  command.display_id = request.display_id;
  command.pixels_wide = request.pixels_wide;
  command.pixels_high = request.pixels_high;
  command.refresh_millihertz = request.refresh_millihertz;
  command.scale_percent = request.scale_percent;

  VirtualDisplayHelperReply answered;
  std::string error;
  if (!helper_->RelayFromRoute(command, &answered, &error))
    return Refuse("helper_refused");
  if (!answered.ok) return Refuse("helper_refused");

  VirtualDisplayControlReply reply;
  reply.ok = true;
  reply.display_id = answered.display_id;
  reply.admitted = answered.admitted;
  reply.presence = answered.presence;
  std::string line = SerializeVirtualDisplayControlReply(reply);
  return line.empty() ? Refuse("control_internal") : line;
}

}  // namespace imcodes::remote_desktop::macos
