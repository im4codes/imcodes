#include "macos_virtual_display_helper_backend.h"

#include <utility>

namespace imcodes::remote_desktop::macos {

namespace {

VirtualDisplayHelperCommand MakeCommand(VirtualDisplayHelperVerb verb,
                                        std::uint32_t display_id) {
  VirtualDisplayHelperCommand command;
  command.verb = verb;
  command.display_id = display_id;
  return command;
}

}  // namespace

bool MacosVirtualDisplayHelperOptions::IsValid() const noexcept {
  return binding.IsValid() && request_timeout_ms > 0 &&
         request_timeout_ms <= 30'000 && max_consecutive_failures > 0 &&
         max_consecutive_failures <= 16;
}

MacosVirtualDisplayHelperBackend::MacosVirtualDisplayHelperBackend(
    MacosVirtualDisplayHelperOptions options,
    VirtualDisplayHelperExchange exchange)
    : options_(std::move(options)), exchange_(std::move(exchange)) {
  // No exchange, or an unusable binding, is a permanently failed backend rather
  // than one that might work later. Anything else would let a misconfigured
  // composition look merely "not ready yet".
  liveness_ = (exchange_ && options_.IsValid()) ? HelperLiveness::kLaunching
                                                : HelperLiveness::kFailed;
  if (liveness_ == HelperLiveness::kFailed)
    last_error_ = "virtual-display helper binding or transport is unusable";
}

bool MacosVirtualDisplayHelperBackend::Exchange(
    VirtualDisplayHelperCommand command,
    VirtualDisplayHelperReply* reply,
    std::string* error) {
  if (liveness_ == HelperLiveness::kFailed) {
    if (error != nullptr) *error = last_error_;
    return false;
  }
  command.generation = options_.binding.generation;
  command.epoch = options_.binding.epoch;
  // Strictly advancing, derived from the bound seed. A peer that never saw the
  // seed cannot mint the next one, and a captured frame cannot be replayed
  // because its index is below the helper's floor.
  command.request_index = ++request_index_;
  command.cookie =
      DeriveHelperCookie(options_.binding.cookie_seed, command.request_index);
  const std::string line = SerializeVirtualDisplayHelperCommand(command);
  if (line.empty()) {
    if (error != nullptr) *error = "could not serialize the helper command";
    return false;
  }
  std::string reply_line;
  if (!exchange_(line, &reply_line, options_.request_timeout_ms)) {
    // A hung or dead helper. Latch after a bounded number of these so one dead
    // helper does not make every later call pay the full timeout.
    if (++consecutive_failures_ >= options_.max_consecutive_failures) {
      liveness_ = HelperLiveness::kFailed;
      last_error_ = "virtual-display helper stopped answering";
    }
    if (error != nullptr) *error = "virtual-display helper did not answer";
    return false;
  }
  VirtualDisplayHelperReply parsed;
  if (!ParseVirtualDisplayHelperReply(reply_line, &parsed)) {
    if (++consecutive_failures_ >= options_.max_consecutive_failures) {
      liveness_ = HelperLiveness::kFailed;
      last_error_ = "virtual-display helper replied with malformed frames";
    }
    if (error != nullptr) *error = "malformed helper reply";
    return false;
  }
  // Bind the answer to THIS question before believing any of it.
  if (parsed.cookie != command.cookie ||
      parsed.generation != command.generation) {
    liveness_ = HelperLiveness::kFailed;
    last_error_ = "virtual-display helper reply was not bound to the request";
    if (error != nullptr) *error = last_error_;
    return false;
  }
  consecutive_failures_ = 0;
  liveness_ = HelperLiveness::kReady;
  if (!parsed.ok && error != nullptr)
    *error = parsed.error.empty() ? "helper refused the command" : parsed.error;
  if (reply != nullptr) *reply = parsed;
  return parsed.ok;
}

common::ReadinessState MacosVirtualDisplayHelperBackend::ProbeSupport() noexcept {
  // This gates CREATE, so it must ask the create question, not the advertise
  // question. Using QueryAdmitted here is a deadlock: the adapter will not call
  // Create until ProbeSupport is ready, and QueryAdmitted cannot be true until
  // a display exists, which only Create can produce.
  return QualifiedToCreate() ? common::ReadinessState::kReady
                             : common::ReadinessState::kUnavailable;
}

bool MacosVirtualDisplayHelperBackend::QualifiedToCreate() noexcept {
  VirtualDisplayHelperReply reply;
  std::string error;
  if (!Exchange(MakeCommand(VirtualDisplayHelperVerb::kStatus, 0), &reply, &error))
    return false;
  // A live, bound, supervised helper answering THIS request under THIS
  // generation. Deliberately says nothing about a display existing: absent is a
  // perfectly qualified state to create from, and is exactly the headless case.
  if (!reply.ok || !reply.admitted)
    return false;
  if (reply.cookie == 0 || reply.generation != options_.binding.generation)
    return false;
  return liveness_ == HelperLiveness::kReady;
}

bool MacosVirtualDisplayHelperBackend::QueryAdmitted() noexcept {
  VirtualDisplayHelperReply reply;
  std::string error;
  if (!Exchange(MakeCommand(VirtualDisplayHelperVerb::kStatus, 0), &reply, &error))
    return false;
  return HelperReplyProvesAdmission(reply, reply.cookie,
                                    options_.binding.generation);
}

bool MacosVirtualDisplayHelperBackend::Create(
    const MacosVirtualDisplayConfiguration& configuration,
    std::uint32_t* native_display_id,
    std::string* error) {
  if (native_display_id == nullptr || !configuration.IsValid()) {
    if (error != nullptr) *error = "invalid virtual display configuration";
    return false;
  }
  VirtualDisplayHelperReply reply;
  if (!Exchange(MakeCommand(VirtualDisplayHelperVerb::kHold, 0), &reply, error))
    return false;
  if (reply.display_id == 0) {
    if (error != nullptr) *error = "helper held no display";
    return false;
  }
  display_id_ = reply.display_id;
  *native_display_id = reply.display_id;
  return true;
}

bool MacosVirtualDisplayHelperBackend::ApplyMode(
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
  // The approved mode travels WITH the enable. Sending a bare ENABLE discarded
  // the worker's mode and scale selection entirely and left the display on
  // whatever WindowServer picked.
  VirtualDisplayHelperCommand command =
      MakeCommand(VirtualDisplayHelperVerb::kEnable, native_display_id);
  command.pixels_wide = mode.pixels.width;
  command.pixels_high = mode.pixels.height;
  command.refresh_millihertz =
      static_cast<std::uint32_t>(mode.refresh_rate_hz * 1000.0 + 0.5);
  command.scale_percent = static_cast<std::uint32_t>(mode.scale * 100.0 + 0.5);
  // Activation is enable+extend inside the helper; this process never touches
  // the mirroring manager itself.
  return Exchange(command, nullptr, error);
}

bool MacosVirtualDisplayHelperBackend::WaitUntilOnline(
    std::uint32_t native_display_id,
    std::uint32_t timeout_ms,
    std::string* error) {
  (void)timeout_ms;
  if (native_display_id == 0 || native_display_id != display_id_) {
    if (error != nullptr) *error = "wait does not name the held display";
    return false;
  }
  VirtualDisplayHelperReply reply;
  if (!Exchange(MakeCommand(VirtualDisplayHelperVerb::kStatus, native_display_id), &reply,
                error)) {
    return false;
  }
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

bool MacosVirtualDisplayHelperBackend::RelayFromRoute(
    const VirtualDisplayHelperCommand& request,
    VirtualDisplayHelperReply* reply,
    std::string* error) {
  // The route's own credentials were already checked by the control server;
  // whatever it put in these fields is discarded here rather than trusted,
  // because a relayed frame and an authored one must be indistinguishable to
  // the helper -- and the only way to guarantee that is to author it.
  VirtualDisplayHelperCommand command;
  command.verb = request.verb;
  command.display_id = request.display_id;
  command.pixels_wide = request.pixels_wide;
  command.pixels_high = request.pixels_high;
  command.refresh_millihertz = request.refresh_millihertz;
  command.scale_percent = request.scale_percent;

  switch (command.verb) {
    case VirtualDisplayHelperVerb::kHold:
    case VirtualDisplayHelperVerb::kEnable:
    case VirtualDisplayHelperVerb::kDisable:
    case VirtualDisplayHelperVerb::kStatus:
      break;
    case VirtualDisplayHelperVerb::kRelease:
    case VirtualDisplayHelperVerb::kInvalid:
      // Not "unlikely": structurally refused. See the header.
      if (error != nullptr) *error = "route_verb_forbidden";
      return false;
  }

  VirtualDisplayHelperReply answered;
  if (!Exchange(command, &answered, error)) return false;
  // A hold answers with the id the resident agent already owns, so the cached
  // id follows the helper rather than the caller. Without this, a later
  // ApplyMode from this same backend would compare against a stale id.
  if (command.verb == VirtualDisplayHelperVerb::kHold && answered.display_id != 0)
    display_id_ = answered.display_id;
  if (reply != nullptr) *reply = answered;
  return true;
}

void MacosVirtualDisplayHelperBackend::Destroy() noexcept {
  if (display_id_ == 0)
    return;
  VirtualDisplayHelperReply reply;
  std::string error;
  const bool answered =
      Exchange(MakeCommand(VirtualDisplayHelperVerb::kRelease, display_id_), &reply, &error);
  // Removal is decided by the helper's ENUMERATION, never by this call
  // returning. Anything short of absent is a leak, and it is recorded as one so
  // an operator sees a stranded id instead of a clean-looking shutdown.
  leaked_ = !answered || reply.presence != "absent";
  if (leaked_) {
    last_error_ = answered ? "display survived teardown: " + reply.presence
                           : "helper did not confirm teardown";
  }
  display_id_ = 0;
}

}  // namespace imcodes::remote_desktop::macos
