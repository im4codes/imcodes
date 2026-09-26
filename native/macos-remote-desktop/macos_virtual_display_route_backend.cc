#include "macos_virtual_display_route_backend.h"

#include <utility>

#include "macos_virtual_display_helper_binding.h"

namespace imcodes::remote_desktop::macos {

bool MacosVirtualDisplayRouteOptions::IsValid() const noexcept {
  return route_generation != 0 && request_timeout_ms != 0 &&
         max_consecutive_failures != 0;
}

MacosVirtualDisplayRouteBackend::MacosVirtualDisplayRouteBackend(
    MacosVirtualDisplayRouteOptions options,
    VirtualDisplayControlExchange exchange)
    : options_(options), exchange_(std::move(exchange)) {}

bool MacosVirtualDisplayRouteBackend::Round(const std::string& request_line,
                                            VirtualDisplayControlReply* reply,
                                            std::string* error) {
  if (failed_) {
    if (error != nullptr) *error = last_error_;
    return false;
  }
  if (exchange_ == nullptr || !options_.IsValid() || request_line.empty()) {
    // A backend that cannot dial must not read as "no display right now": it is
    // a construction fault, and latching it stops every later call pretending
    // the situation might improve.
    failed_ = true;
    last_error_ = "virtual-display route backend is not wired";
    if (error != nullptr) *error = last_error_;
    return false;
  }
  std::string reply_line;
  if (!exchange_(request_line, &reply_line, options_.request_timeout_ms)) {
    if (++consecutive_failures_ >= options_.max_consecutive_failures) {
      failed_ = true;
      last_error_ = "virtual-display agent stopped answering";
    }
    if (error != nullptr) *error = "virtual-display agent did not answer";
    return false;
  }
  consecutive_failures_ = 0;

  VirtualDisplayControlReply parsed;
  std::string parse_error;
  if (!ParseVirtualDisplayControlReply(reply_line, &parsed, &parse_error)) {
    // An unparseable answer is not a soft failure. Something is speaking on
    // this socket that is not the agent, and continuing would mean acting on
    // whatever we could make of it.
    failed_ = true;
    last_error_ = "virtual-display agent answered unintelligibly";
    if (error != nullptr) *error = last_error_;
    return false;
  }
  if (!parsed.ok) {
    if (error != nullptr) *error = parsed.error;
    return false;
  }
  if (reply != nullptr) *reply = parsed;
  return true;
}

bool MacosVirtualDisplayRouteBackend::EnsureCapability(std::string* error) {
  if (route_epoch_ != 0) return true;

  VirtualDisplayControlRequest request;
  request.verb = VirtualDisplayControlVerb::kRoute;
  request.route_generation = options_.route_generation;
  const std::string line = SerializeVirtualDisplayControlRequest(request);

  VirtualDisplayControlReply reply;
  if (!Round(line, &reply, error)) return false;
  if (reply.route_generation != options_.route_generation ||
      reply.route_epoch == 0 || reply.cookie_seed == 0) {
    // A capability that does not name this route, or is not usable, must not be
    // stored: a half-adopted capability is a backend that believes it is
    // authorised for something the agent never issued.
    if (error != nullptr) *error = "agent issued no usable route capability";
    return false;
  }
  route_epoch_ = reply.route_epoch;
  cookie_seed_ = reply.cookie_seed;
  request_index_ = 0;
  return true;
}

bool MacosVirtualDisplayRouteBackend::Relay(
    VirtualDisplayHelperVerb verb,
    std::uint32_t display_id,
    const MacosVirtualDisplayMode* mode,
    VirtualDisplayControlReply* reply,
    std::string* error) {
  if (!EnsureCapability(error)) return false;

  VirtualDisplayControlRequest request;
  request.verb = VirtualDisplayControlVerb::kRelay;
  request.route_generation = options_.route_generation;
  request.route_epoch = route_epoch_;
  // Strictly advancing, derived from the seed the agent issued. A peer that
  // never received the seed cannot mint one, and a captured frame cannot be
  // replayed because its index is no longer above the agent's floor.
  request.request_index = ++request_index_;
  request.route_cookie = DeriveHelperCookie(cookie_seed_, request.request_index);
  request.helper_verb = verb;
  request.display_id = display_id;
  if (mode != nullptr) {
    request.pixels_wide = mode->pixels.width;
    request.pixels_high = mode->pixels.height;
    request.refresh_millihertz =
        static_cast<std::uint32_t>(mode->refresh_rate_hz * 1000.0 + 0.5);
    request.scale_percent =
        static_cast<std::uint32_t>(mode->scale * 100.0 + 0.5);
  }

  const std::string line = SerializeVirtualDisplayControlRequest(request);
  if (line.empty()) {
    // The grammar refused to express this request, which means it was one the
    // agent would have refused too. Reported here rather than sent, so the
    // caller learns the request was wrong instead of watching it vanish.
    if (error != nullptr) *error = "route request is not expressible";
    return false;
  }
  return Round(line, reply, error);
}

common::ReadinessState MacosVirtualDisplayRouteBackend::ProbeSupport() noexcept {
  // Gates CREATE, so it asks the create question: is there a resident agent
  // that owns a live helper and will accept a hold. It deliberately does NOT
  // require a display to already exist -- that is the advertise question, and
  // conflating them deadlocks the first create on a headless host.
  std::string error;
  VirtualDisplayControlReply reply;
  if (!Relay(VirtualDisplayHelperVerb::kStatus, 0, nullptr, &reply, &error)) {
    last_error_ = error;
    return common::ReadinessState::kUnavailable;
  }
  return common::ReadinessState::kReady;
}

bool MacosVirtualDisplayRouteBackend::Create(
    const MacosVirtualDisplayConfiguration& configuration,
    std::uint32_t* native_display_id,
    std::string* error) {
  if (native_display_id == nullptr || !configuration.IsValid()) {
    if (error != nullptr) *error = "invalid virtual display configuration";
    return false;
  }
  VirtualDisplayControlReply reply;
  if (!Relay(VirtualDisplayHelperVerb::kHold, 0, nullptr, &reply, error))
    return false;
  if (reply.display_id == 0) {
    // "The agent answered" is not "the agent holds a display". Accepting a zero
    // id here would hand the session a display it could then never address.
    if (error != nullptr) *error = "agent holds no display";
    return false;
  }
  display_id_ = reply.display_id;
  *native_display_id = reply.display_id;
  return true;
}

bool MacosVirtualDisplayRouteBackend::ApplyMode(
    std::uint32_t native_display_id,
    const MacosVirtualDisplayMode& mode,
    const std::vector<MacosVirtualDisplayMode>& modes,
    std::string* error) {
  (void)modes;
  if (native_display_id == 0 || native_display_id != display_id_ ||
      !mode.IsValid()) {
    if (error != nullptr) *error = "mode does not name the held display";
    return false;
  }
  // The approved mode travels WITH the enable, all the way to the helper. A
  // bare enable discards this selection and leaves whatever WindowServer chose.
  return Relay(VirtualDisplayHelperVerb::kEnable, native_display_id, &mode,
               nullptr, error);
}

bool MacosVirtualDisplayRouteBackend::WaitUntilOnline(
    std::uint32_t native_display_id,
    std::uint32_t timeout_ms,
    std::string* error) {
  (void)timeout_ms;
  if (native_display_id == 0 || native_display_id != display_id_) {
    if (error != nullptr) *error = "wait does not name the held display";
    return false;
  }
  VirtualDisplayControlReply reply;
  if (!Relay(VirtualDisplayHelperVerb::kStatus, 0, nullptr, &reply, error))
    return false;
  // "active", not merely "registered". Registered-but-inactive is precisely the
  // state that looks like success to anything asking only whether a display
  // exists.
  if (reply.presence != "active") {
    if (error != nullptr)
      *error = "display is registered but not active";
    return false;
  }
  return true;
}

void MacosVirtualDisplayRouteBackend::Destroy() noexcept {
  if (display_id_ == 0) return;
  // DISABLE. See the header: release would end the resident agent's hold and
  // destroy the display, which is what made the display die with the route.
  std::string error;
  if (!Relay(VirtualDisplayHelperVerb::kDisable, display_id_, nullptr, nullptr,
             &error)) {
    last_error_ = error;
  }
  display_id_ = 0;
  // The capability is NOT dropped. This route may create again, and re-asking
  // for a capability would consume another slot in the agent's bounded table
  // for a generation that already has one.
}

}  // namespace imcodes::remote_desktop::macos
