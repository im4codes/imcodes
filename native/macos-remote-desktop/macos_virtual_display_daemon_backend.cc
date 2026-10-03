#include "macos_virtual_display_daemon_backend.h"

#include <cmath>
#include <utility>

#include "macos_virtual_display_helper_binding.h"

namespace imcodes::remote_desktop::macos {
namespace {

std::string Number(std::uint64_t value) { return std::to_string(value); }

void Fail(std::string* error, const char* reason) {
  if (error != nullptr) *error = reason;
}

}  // namespace

std::string BuildVirtualDisplayReadinessRequest(std::uint64_t nonce) {
  // A nonce and nothing else. There is no shape in which readiness could ask
  // for a mutation, which is stronger than checking that it did not.
  return std::string("{\"op\":\"readiness\",\"nonce\":") + Number(nonce) + "}";
}

std::string BuildVirtualDisplayRouteRequest() {
  // Carries no credential: the peer has none yet, and the generation is the
  // one the daemon already authenticated.
  return "{\"op\":\"route\"}";
}

std::string BuildVirtualDisplayRelayRequest(std::string_view op,
                                            std::uint64_t route_epoch,
                                            std::uint64_t route_cookie,
                                            std::uint64_t request_index) {
  std::string json = "{\"op\":\"";
  json.append(op).append("\",\"routeEpoch\":").append(Number(route_epoch));
  json.append(",\"routeCookie\":").append(Number(route_cookie));
  json.append(",\"requestIndex\":").append(Number(request_index)).append("}");
  return json;
}

std::string BuildVirtualDisplayDisableRequest(std::uint64_t route_epoch,
                                              std::uint64_t route_cookie,
                                              std::uint64_t request_index,
                                              std::uint64_t display_id) {
  std::string json = "{\"op\":\"disable\",\"routeEpoch\":";
  json.append(Number(route_epoch));
  json.append(",\"routeCookie\":").append(Number(route_cookie));
  json.append(",\"requestIndex\":").append(Number(request_index));
  json.append(",\"displayId\":").append(Number(display_id)).append("}");
  return json;
}

std::string BuildVirtualDisplayEnableRequest(
    std::uint64_t route_epoch, std::uint64_t route_cookie,
    std::uint64_t request_index, std::uint64_t display_id,
    std::uint32_t pixels_wide, std::uint32_t pixels_high,
    std::uint32_t refresh_millihertz, std::uint32_t scale_percent) {
  std::string json = "{\"op\":\"enable\",\"routeEpoch\":";
  json.append(Number(route_epoch));
  json.append(",\"routeCookie\":").append(Number(route_cookie));
  json.append(",\"requestIndex\":").append(Number(request_index));
  json.append(",\"displayId\":").append(Number(display_id));
  json.append(",\"pixelsWide\":").append(Number(pixels_wide));
  json.append(",\"pixelsHigh\":").append(Number(pixels_high));
  json.append(",\"refreshMilliHertz\":").append(Number(refresh_millihertz));
  json.append(",\"scalePercent\":").append(Number(scale_percent)).append("}");
  return json;
}

DaemonProxyVirtualDisplayBackend::DaemonProxyVirtualDisplayBackend(
    VirtualDisplayDaemonExchange exchange, VirtualDisplayNonceSource nonce,
    common::WorkerGeneration worker_generation, std::uint32_t expected_uid)
    : exchange_(std::move(exchange)),
      nonce_(std::move(nonce)),
      worker_generation_(worker_generation),
      expected_uid_(expected_uid) {}

void DaemonProxyVirtualDisplayBackend::GoTerminal() noexcept {
  // Sticky. A channel that answered about the wrong principal once must not be
  // retried into agreement: the next answer would be from the same place.
  terminal_ = true;
  route_bound_ = false;
  route_epoch_ = 0;
  cookie_seed_ = 0;
}

common::ReadinessState DaemonProxyVirtualDisplayBackend::ProbeSupport() noexcept {
  if (terminal_ || !exchange_ || !nonce_) {
    return common::ReadinessState::kUnavailable;
  }
  const std::uint64_t nonce = nonce_();
  if (nonce == 0) return common::ReadinessState::kUnavailable;

  VirtualDisplayProxyReply reply;
  if (!exchange_(BuildVirtualDisplayReadinessRequest(nonce),
                 VirtualDisplayReplyShape::kReadiness, &reply)) {
    // Unreachable is false, never "probably". This is the answer capture is
    // about to be enabled on.
    return common::ReadinessState::kUnavailable;
  }
  if (!reply.ok) return common::ReadinessState::kUnavailable;
  // The nonce must come back. Without it the answer proves only that SOMETHING
  // answered, not that it answered THIS question.
  if (reply.nonce != nonce) {
    GoTerminal();
    return common::ReadinessState::kUnavailable;
  }
  // The CREATE gate is qualification ALONE.
  //
  // Requiring `display_control_admitted` here was a self-lock: on a headless
  // machine nothing is admitted until a display exists, and no display can be
  // created until something is admitted. The first create could therefore never
  // happen. Admission and presence describe a display that is already there --
  // they answer "is it online" and "may we advertise it", not "may we make
  // one" -- so they belong to WaitUntilOnline and to the advertised profile,
  // not to this gate.
  //
  // Still zero mutation: this reports what the agent already knows and cannot
  // hold, enable or create.
  return reply.qualified_to_create ? common::ReadinessState::kReady
                                   : common::ReadinessState::kUnavailable;
}

bool DaemonProxyVirtualDisplayBackend::EnsureRoute(std::string* error) {
  if (terminal_) {
    Fail(error, "virtual_display_channel_terminal");
    return false;
  }
  if (route_bound_) return true;
  if (!exchange_) {
    Fail(error, "virtual_display_unavailable");
    return false;
  }
  VirtualDisplayProxyReply reply;
  if (!exchange_(BuildVirtualDisplayRouteRequest(),
                 VirtualDisplayReplyShape::kRoute, &reply)
      || !reply.ok) {
    Fail(error, "virtual_display_route_refused");
    return false;
  }
  // The capability must be for THIS generation and THIS uid. A route answer
  // about another principal is not a weaker grant, it is a different one.
  if (reply.route_generation != static_cast<std::uint64_t>(worker_generation_)
      || reply.route_epoch == 0 || reply.cookie_seed == 0
      || (expected_uid_ != 0 && reply.uid != expected_uid_)) {
    GoTerminal();
    Fail(error, "virtual_display_route_identity_mismatch");
    return false;
  }
  route_epoch_ = reply.route_epoch;
  cookie_seed_ = reply.cookie_seed;
  route_bound_ = true;
  return true;
}

bool DaemonProxyVirtualDisplayBackend::Relay(std::string_view op,
                                             std::uint64_t display_id,
                                             bool addresses_display,
                                             VirtualDisplayProxyReply* reply,
                                             std::string* error) {
  if (!EnsureRoute(error)) return false;
  // Strictly advancing, so a captured frame cannot be replayed later.
  ++request_index_;
  const std::uint64_t cookie = DeriveHelperCookie(cookie_seed_, request_index_);
  const std::string request =
      addresses_display
          ? (op == "disable"
                 ? BuildVirtualDisplayDisableRequest(route_epoch_, cookie,
                                                     request_index_, display_id)
                 : std::string())
          : BuildVirtualDisplayRelayRequest(op, route_epoch_, cookie,
                                            request_index_);
  if (request.empty()) {
    Fail(error, "virtual_display_request_not_expressible");
    return false;
  }
  if (!exchange_(request, VirtualDisplayReplyShape::kRelay, reply)
      || !reply->ok) {
    Fail(error, "virtual_display_refused");
    return false;
  }
  return true;
}

bool DaemonProxyVirtualDisplayBackend::Create(
    const MacosVirtualDisplayConfiguration& configuration,
    std::uint32_t* native_display_id, std::string* error) {
  if (native_display_id == nullptr) return false;
  if (!configuration.IsValid()) {
    Fail(error, "virtual_display_configuration_invalid");
    return false;
  }
  VirtualDisplayProxyReply reply;
  // HOLD, not create. This process asks the agent to reserve the display it
  // already owns; nothing here can construct one.
  if (!Relay("hold", 0, false, &reply, error)) return false;
  if (!reply.admitted || reply.display_id == 0
      || reply.display_id > 0xFFFF'FFFFull) {
    Fail(error, "virtual_display_not_admitted");
    return false;
  }
  held_display_id_ = static_cast<std::uint32_t>(reply.display_id);
  *native_display_id = held_display_id_;
  return true;
}

bool DaemonProxyVirtualDisplayBackend::ApplyMode(
    std::uint32_t native_display_id, const MacosVirtualDisplayMode& mode,
    const std::vector<MacosVirtualDisplayMode>& modes, std::string* error) {
  (void)modes;
  if (!mode.IsValid() || native_display_id == 0
      || native_display_id != held_display_id_) {
    Fail(error, "virtual_display_mode_invalid");
    return false;
  }
  if (!EnsureRoute(error)) return false;
  ++request_index_;
  const std::uint64_t cookie = DeriveHelperCookie(cookie_seed_, request_index_);
  // Exact units on the wire. A rounded refresh or scale is a different mode
  // from the one the caller selected.
  const auto refresh_millihertz =
      static_cast<std::uint32_t>(std::lround(mode.refresh_rate_hz * 1000.0));
  const auto scale_percent =
      static_cast<std::uint32_t>(std::lround(mode.scale * 100.0));
  if (refresh_millihertz == 0 || scale_percent == 0) {
    Fail(error, "virtual_display_mode_invalid");
    return false;
  }
  VirtualDisplayProxyReply reply;
  if (!exchange_(BuildVirtualDisplayEnableRequest(
                     route_epoch_, cookie, request_index_, native_display_id,
                     mode.pixels.width, mode.pixels.height, refresh_millihertz,
                     scale_percent),
                 VirtualDisplayReplyShape::kRelay, &reply)
      || !reply.ok || !reply.admitted) {
    Fail(error, "virtual_display_enable_refused");
    return false;
  }
  return true;
}

bool DaemonProxyVirtualDisplayBackend::WaitUntilOnline(
    std::uint32_t native_display_id, std::uint32_t timeout_ms,
    std::string* error) {
  (void)timeout_ms;
  if (native_display_id == 0 || native_display_id != held_display_id_) {
    Fail(error, "virtual_display_not_held");
    return false;
  }
  VirtualDisplayProxyReply reply;
  if (!Relay("status", 0, false, &reply, error)) return false;
  // "active" and nothing else. "inactive" is registered-but-not-shown, and
  // treating it as online is how a black screen reports itself ready.
  if (reply.presence != "active") {
    Fail(error, "virtual_display_not_active");
    return false;
  }
  return true;
}

void DaemonProxyVirtualDisplayBackend::Destroy() noexcept {
  // DISABLE, never RELEASE. This worker can stop showing the display; the
  // agent owns its lifetime and reaps it on route end.
  if (held_display_id_ == 0 || terminal_ || !route_bound_ || !exchange_) {
    held_display_id_ = 0;
    return;
  }
  ++request_index_;
  const std::uint64_t cookie = DeriveHelperCookie(cookie_seed_, request_index_);
  VirtualDisplayProxyReply reply;
  (void)exchange_(BuildVirtualDisplayDisableRequest(route_epoch_, cookie,
                                                    request_index_,
                                                    held_display_id_),
                  VirtualDisplayReplyShape::kRelay, &reply);
  held_display_id_ = 0;
}

}  // namespace imcodes::remote_desktop::macos
