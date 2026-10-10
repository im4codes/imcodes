#include "macos_virtual_display_control_protocol.h"

#include <string_view>

namespace imcodes::remote_desktop::macos {
namespace {

/**
 * Bounded decimal parse. Refuses empty input, non-digits, leading zeros and
 * anything that would overflow.
 *
 * Leading zeros are refused because they make two spellings of one value, and
 * the serializer emits exactly one -- accepting `007` would break the canonical
 * closure the same way a reordered key would.
 */
bool ParseUnsigned(std::string_view value, std::uint64_t* out) noexcept {
  if (value.empty() || value.size() > 20) return false;
  if (value.size() > 1 && value.front() == '0') return false;
  std::uint64_t accumulated = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') return false;
    const std::uint64_t digit = static_cast<std::uint64_t>(character - '0');
    if (accumulated > (UINT64_MAX - digit) / 10) return false;
    accumulated = accumulated * 10 + digit;
  }
  *out = accumulated;
  return true;
}

bool ParseBool(std::string_view value, bool* out) noexcept {
  if (value == "1") {
    *out = true;
    return true;
  }
  if (value == "0") {
    *out = false;
    return true;
  }
  return false;
}

/** "absent" | "inactive" | "active", and nothing else. */
bool IsPresence(std::string_view value) noexcept {
  return value == "absent" || value == "inactive" || value == "active";
}

/**
 * A closed set of error reasons, so a refusal is never free text.
 *
 * Free text on this wire would mean the far end formats whatever it likes into
 * a whitespace-delimited frame, which is both a parsing hazard and a way to
 * smuggle detail out of the agent to a peer that only needed "no".
 */
bool IsErrorToken(std::string_view value) noexcept {
  if (value.empty() || value.size() > 64) return false;
  for (const char character : value) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= '0' && character <= '9') ||
                         character == '_';
    if (!allowed) return false;
  }
  return true;
}

}  // namespace

const char* VirtualDisplayControlVerbText(
    VirtualDisplayControlVerb verb) noexcept {
  switch (verb) {
    case VirtualDisplayControlVerb::kReady:
      return "ready";
    case VirtualDisplayControlVerb::kRoute:
      return "route";
    case VirtualDisplayControlVerb::kRelay:
      return "relay";
    case VirtualDisplayControlVerb::kInvalid:
      break;
  }
  return "";
}

VirtualDisplayControlVerb ParseVirtualDisplayControlVerb(
    std::string_view text) noexcept {
  if (text == "ready") return VirtualDisplayControlVerb::kReady;
  if (text == "route") return VirtualDisplayControlVerb::kRoute;
  if (text == "relay") return VirtualDisplayControlVerb::kRelay;
  return VirtualDisplayControlVerb::kInvalid;
}

const char* VirtualDisplayHelperVerbText(
    VirtualDisplayHelperVerb verb) noexcept {
  switch (verb) {
    case VirtualDisplayHelperVerb::kHold:
      return "hold";
    case VirtualDisplayHelperVerb::kEnable:
      return "enable";
    case VirtualDisplayHelperVerb::kDisable:
      return "disable";
    case VirtualDisplayHelperVerb::kStatus:
      return "status";
    case VirtualDisplayHelperVerb::kRelease:
      return "release";
    case VirtualDisplayHelperVerb::kInvalid:
      break;
  }
  return "";
}

VirtualDisplayHelperVerb ParseVirtualDisplayHelperVerbText(
    std::string_view text) noexcept {
  if (text == "hold") return VirtualDisplayHelperVerb::kHold;
  if (text == "enable") return VirtualDisplayHelperVerb::kEnable;
  if (text == "disable") return VirtualDisplayHelperVerb::kDisable;
  if (text == "status") return VirtualDisplayHelperVerb::kStatus;
  if (text == "release") return VirtualDisplayHelperVerb::kRelease;
  return VirtualDisplayHelperVerb::kInvalid;
}

VirtualDisplayControlFrame ClassifyVirtualDisplayControlFrame(
    std::string_view line) noexcept {
  // Prefix only. Deliberately does NOT parse: the server must decide who is
  // allowed to send a frame before it does any work on the frame's behalf.
  if (line.rfind("grant1 ", 0) == 0) return VirtualDisplayControlFrame::kGrant;
  if (line.rfind(kVirtualDisplayControlRequestPrefix, 0) == 0)
    return VirtualDisplayControlFrame::kControl;
  return VirtualDisplayControlFrame::kUnknown;
}

bool VirtualDisplayControlRequest::IsValid() const noexcept {
  switch (verb) {
    case VirtualDisplayControlVerb::kReady:
      // A zero nonce cannot distinguish this answer from a defaulted one, so
      // the echo would prove nothing.
      return nonce != 0 && route_generation == 0 && route_epoch == 0 &&
             route_cookie == 0 && request_index == 0 &&
             helper_verb == VirtualDisplayHelperVerb::kInvalid &&
             display_id == 0 && pixels_wide == 0 && pixels_high == 0 &&
             refresh_millihertz == 0 && scale_percent == 0;
    case VirtualDisplayControlVerb::kRoute:
      // Asking for a capability carries no credential: the peer has none yet.
      return route_generation != 0 && nonce == 0 && route_epoch == 0 &&
             route_cookie == 0 && request_index == 0 &&
             helper_verb == VirtualDisplayHelperVerb::kInvalid &&
             display_id == 0 && pixels_wide == 0 && pixels_high == 0 &&
             refresh_millihertz == 0 && scale_percent == 0;
    case VirtualDisplayControlVerb::kRelay:
      break;
    case VirtualDisplayControlVerb::kInvalid:
      return false;
  }
  if (route_generation == 0 || route_epoch == 0 || route_cookie == 0 ||
      request_index == 0 || nonce != 0) {
    return false;
  }
  // Mode parameters belong to kEnable and to nothing else. Carrying them on
  // another verb would mean the peer described an action the agent will not
  // take, and silently dropping that description is how a mode selection gets
  // lost without anyone being told.
  const bool has_mode = pixels_wide != 0 || pixels_high != 0 ||
                        refresh_millihertz != 0 || scale_percent != 0;
  switch (helper_verb) {
    case VirtualDisplayHelperVerb::kEnable:
      // Bounds mirror the helper protocol's own: this frame is rejected here
      // rather than forwarded and rejected there, so a route learns its request
      // was refused instead of watching it vanish.
      return display_id != 0 && pixels_wide != 0 && pixels_high != 0 &&
             refresh_millihertz != 0 && scale_percent != 0 &&
             pixels_wide <= 16'384 && pixels_high <= 16'384 &&
             refresh_millihertz <= 240'000 && scale_percent <= 400;
    case VirtualDisplayHelperVerb::kDisable:
      return display_id != 0 && !has_mode;
    case VirtualDisplayHelperVerb::kHold:
    case VirtualDisplayHelperVerb::kStatus:
      return display_id == 0 && !has_mode;
    case VirtualDisplayHelperVerb::kRelease:
      // Release is the one verb a route may NOT ask for. The helper's lifetime
      // is the display's lifetime and it belongs to the resident agent; a route
      // that could release it would take the display away from every other
      // route, and from the next one.
      return false;
    case VirtualDisplayHelperVerb::kInvalid:
      return false;
  }
  return false;
}

bool VirtualDisplayControlReply::IsValid() const noexcept {
  if (ok) {
    if (!error.empty()) return false;
  } else if (!IsErrorToken(error)) {
    return false;
  }
  if (!presence.empty() && !IsPresence(presence)) return false;
  // A refused answer must not also carry a capability: a peer that reads the
  // fields before the verdict would find a usable one.
  if (!ok && (route_epoch != 0 || cookie_seed != 0 || uid != 0 ||
              qualified_to_create || display_control_admitted || admitted)) {
    return false;
  }
  return true;
}

bool ParseVirtualDisplayControlRequest(const std::string& line,
                                       VirtualDisplayControlRequest* request,
                                       std::string* error) {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    return false;
  };
  if (request == nullptr || line.empty() ||
      line.size() > kVirtualDisplayControlMaxBytes) {
    return reject("control_frame_unusable");
  }
  std::string_view view(line);
  // At most one line terminator, for the same reason the grant bounds it: the
  // canonical form is compared after stripping, so unbounded stripping would
  // let arbitrarily many distinct byte frames reduce to one request.
  if (!view.empty() && view.back() == '\n') view.remove_suffix(1);
  if (!view.empty() && view.back() == '\r') view.remove_suffix(1);
  if (!view.empty() && (view.back() == '\n' || view.back() == '\r'))
    return reject("control_frame_unusable");
  const std::string line_canonical(view);
  if (view.rfind(kVirtualDisplayControlRequestPrefix, 0) != 0)
    return reject("control_prefix_unknown");
  view.remove_prefix(kVirtualDisplayControlRequestPrefix.size());

  VirtualDisplayControlRequest parsed;
  bool seen[11] = {};
  const auto mark = [&seen](int slot) {
    if (seen[slot]) return false;
    seen[slot] = true;
    return true;
  };
  bool saw_verb = false;
  while (!view.empty()) {
    const std::size_t space = view.find(' ');
    const std::string_view token = view.substr(0, space);
    view = space == std::string_view::npos ? std::string_view()
                                           : view.substr(space + 1);
    const std::size_t equals = token.find('=');
    if (equals == std::string_view::npos || equals == 0)
      return reject("control_token_unstructured");
    const std::string_view key = token.substr(0, equals);
    const std::string_view value = token.substr(equals + 1);
    std::uint64_t number = 0;
    if (key == "verb") {
      if (!mark(0)) return reject("control_field_malformed");
      parsed.verb = ParseVirtualDisplayControlVerb(value);
      if (parsed.verb == VirtualDisplayControlVerb::kInvalid)
        return reject("control_verb_unknown");
      saw_verb = true;
    } else if (key == "nonce") {
      if (!mark(1) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.nonce = number;
    } else if (key == "rgen") {
      if (!mark(2) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.route_generation = number;
    } else if (key == "repoch") {
      if (!mark(3) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.route_epoch = number;
    } else if (key == "rcookie") {
      if (!mark(4) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.route_cookie = number;
    } else if (key == "ridx") {
      if (!mark(5) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.request_index = number;
    } else if (key == "op") {
      if (!mark(6)) return reject("control_field_malformed");
      parsed.helper_verb = ParseVirtualDisplayHelperVerbText(value);
      if (parsed.helper_verb == VirtualDisplayHelperVerb::kInvalid)
        return reject("control_verb_unknown");
    } else if (key == "display") {
      if (!mark(7) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.display_id = static_cast<std::uint32_t>(number);
    } else if (key == "w") {
      if (!mark(8) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.pixels_wide = static_cast<std::uint32_t>(number);
    } else if (key == "h") {
      if (!mark(9) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.pixels_high = static_cast<std::uint32_t>(number);
    } else if (key == "hz") {
      if (!mark(10) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.refresh_millihertz = static_cast<std::uint32_t>(number);
    } else if (key == "scale") {
      // Slot reuse would be a silent duplicate-key hole, so this one has its
      // own guard rather than sharing another field's bit.
      if (parsed.scale_percent != 0 || !ParseUnsigned(value, &number) ||
          number == 0 || number > 0xFFFFFFFFULL) {
        return reject("control_field_malformed");
      }
      parsed.scale_percent = static_cast<std::uint32_t>(number);
    } else {
      return reject("control_unknown_key");
    }
  }
  if (!saw_verb) return reject("control_field_missing");
  if (!parsed.IsValid()) return reject("control_field_malformed");
  // CANONICAL CLOSURE. Re-serialising must reproduce the input byte for byte,
  // which subsumes key order and spelling: if two distinct lines could name the
  // same request, one of them fails here.
  if (SerializeVirtualDisplayControlRequest(parsed) != line_canonical)
    return reject("control_not_canonical");
  *request = std::move(parsed);
  return true;
}

std::string SerializeVirtualDisplayControlRequest(
    const VirtualDisplayControlRequest& request) {
  if (!request.IsValid()) return std::string();
  std::string line(kVirtualDisplayControlRequestPrefix);
  line += "verb=";
  line += VirtualDisplayControlVerbText(request.verb);
  const auto add = [&line](const char* key, std::uint64_t value) {
    line += ' ';
    line += key;
    line += '=';
    line += std::to_string(value);
  };
  // Only the fields this verb is allowed to carry are emitted, in one fixed
  // order. Emitting zeroed fields would put values on the wire the verb has no
  // meaning for, and the parser would then have to decide what they meant.
  switch (request.verb) {
    case VirtualDisplayControlVerb::kReady:
      add("nonce", request.nonce);
      break;
    case VirtualDisplayControlVerb::kRoute:
      add("rgen", request.route_generation);
      break;
    case VirtualDisplayControlVerb::kRelay:
      add("rgen", request.route_generation);
      add("repoch", request.route_epoch);
      add("rcookie", request.route_cookie);
      add("ridx", request.request_index);
      line += " op=";
      line += VirtualDisplayHelperVerbText(request.helper_verb);
      if (request.display_id != 0) add("display", request.display_id);
      if (request.helper_verb == VirtualDisplayHelperVerb::kEnable) {
        add("w", request.pixels_wide);
        add("h", request.pixels_high);
        add("hz", request.refresh_millihertz);
        add("scale", request.scale_percent);
      }
      break;
    case VirtualDisplayControlVerb::kInvalid:
      return std::string();
  }
  if (line.size() > kVirtualDisplayControlMaxBytes) return std::string();
  return line;
}

bool ParseVirtualDisplayControlReply(const std::string& line,
                                     VirtualDisplayControlReply* reply,
                                     std::string* error) {
  const auto reject = [&](const char* reason) {
    if (error != nullptr) *error = reason;
    return false;
  };
  if (reply == nullptr || line.empty() ||
      line.size() > kVirtualDisplayControlMaxBytes) {
    return reject("control_frame_unusable");
  }
  std::string_view view(line);
  if (!view.empty() && view.back() == '\n') view.remove_suffix(1);
  if (!view.empty() && view.back() == '\r') view.remove_suffix(1);
  if (!view.empty() && (view.back() == '\n' || view.back() == '\r'))
    return reject("control_frame_unusable");
  const std::string line_canonical(view);
  if (view.rfind(kVirtualDisplayControlReplyPrefix, 0) != 0)
    return reject("control_prefix_unknown");
  view.remove_prefix(kVirtualDisplayControlReplyPrefix.size());

  VirtualDisplayControlReply parsed;
  bool seen[11] = {};
  const auto mark = [&seen](int slot) {
    if (seen[slot]) return false;
    seen[slot] = true;
    return true;
  };
  bool saw_ok = false;
  while (!view.empty()) {
    const std::size_t space = view.find(' ');
    const std::string_view token = view.substr(0, space);
    view = space == std::string_view::npos ? std::string_view()
                                           : view.substr(space + 1);
    const std::size_t equals = token.find('=');
    if (equals == std::string_view::npos || equals == 0)
      return reject("control_token_unstructured");
    const std::string_view key = token.substr(0, equals);
    const std::string_view value = token.substr(equals + 1);
    std::uint64_t number = 0;
    bool flag = false;
    if (key == "ok") {
      if (!mark(0) || !ParseBool(value, &flag))
        return reject("control_field_malformed");
      parsed.ok = flag;
      saw_ok = true;
    } else if (key == "error") {
      if (!mark(1) || !IsErrorToken(value))
        return reject("control_field_malformed");
      parsed.error = std::string(value);
    } else if (key == "nonce") {
      if (!mark(2) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.nonce = number;
    } else if (key == "qualified") {
      if (!mark(3) || !ParseBool(value, &flag))
        return reject("control_field_malformed");
      parsed.qualified_to_create = flag;
    } else if (key == "admittedctl") {
      if (!mark(4) || !ParseBool(value, &flag))
        return reject("control_field_malformed");
      parsed.display_control_admitted = flag;
    } else if (key == "rgen") {
      if (!mark(5) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.route_generation = number;
    } else if (key == "repoch") {
      if (!mark(6) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.route_epoch = number;
    } else if (key == "seed") {
      if (!mark(7) || !ParseUnsigned(value, &number))
        return reject("control_field_malformed");
      parsed.cookie_seed = number;
    } else if (key == "uid") {
      if (!mark(8) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.uid = static_cast<std::uint32_t>(number);
    } else if (key == "display") {
      if (!mark(9) || !ParseUnsigned(value, &number) || number > 0xFFFFFFFFULL)
        return reject("control_field_malformed");
      parsed.display_id = static_cast<std::uint32_t>(number);
    } else if (key == "admitted") {
      if (!mark(10) || !ParseBool(value, &flag))
        return reject("control_field_malformed");
      parsed.admitted = flag;
    } else if (key == "presence") {
      if (!parsed.presence.empty() || !IsPresence(value))
        return reject("control_field_malformed");
      parsed.presence = std::string(value);
    } else {
      return reject("control_unknown_key");
    }
  }
  if (!saw_ok) return reject("control_field_missing");
  if (!parsed.IsValid()) return reject("control_field_malformed");
  if (SerializeVirtualDisplayControlReply(parsed) != line_canonical)
    return reject("control_not_canonical");
  *reply = std::move(parsed);
  return true;
}

std::string SerializeVirtualDisplayControlReply(
    const VirtualDisplayControlReply& reply) {
  if (!reply.IsValid()) return std::string();
  std::string line(kVirtualDisplayControlReplyPrefix);
  line += "ok=";
  line += reply.ok ? '1' : '0';
  const auto add = [&line](const char* key, std::uint64_t value) {
    line += ' ';
    line += key;
    line += '=';
    line += std::to_string(value);
  };
  const auto add_flag = [&line](const char* key, bool value) {
    line += ' ';
    line += key;
    line += '=';
    line += value ? '1' : '0';
  };
  if (!reply.ok) {
    line += " error=";
    line += reply.error;
    if (line.size() > kVirtualDisplayControlMaxBytes) return std::string();
    return line;
  }
  // Canonical per-shape key sets, with false spelled out.
  //
  // Emitting a boolean only when true made a legitimate `false` indistinguish-
  // able from an absent key, and a reader that treats absent as false is
  // reporting a verdict the responder never gave. So the flags each shape
  // defines are ALWAYS present, `qualified=0` included. The reader may then
  // require them, which is what makes a truncated answer a refusal instead of
  // a quiet negative.
  //
  // The shape is discriminated by the field only that shape carries: readiness
  // is the one verb that echoes a nonce, and route is the one that returns a
  // capability. Both are already enforced on the request side.
  if (reply.nonce != 0) {
    add("nonce", reply.nonce);
    add_flag("qualified", reply.qualified_to_create);
    add_flag("admittedctl", reply.display_control_admitted);
  } else if (reply.route_epoch != 0 || reply.cookie_seed != 0 ||
             reply.route_generation != 0) {
    add("rgen", reply.route_generation);
    add("repoch", reply.route_epoch);
    add("seed", reply.cookie_seed);
    add("uid", reply.uid);
  } else {
    if (reply.display_id != 0) add("display", reply.display_id);
    add_flag("admitted", reply.admitted);
    line += " presence=";
    line += reply.presence.empty() ? "absent" : reply.presence;
  }
  if (line.size() > kVirtualDisplayControlMaxBytes) return std::string();
  return line;
}

}  // namespace imcodes::remote_desktop::macos
