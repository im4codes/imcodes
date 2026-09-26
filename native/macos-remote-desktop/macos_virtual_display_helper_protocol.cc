#include "macos_virtual_display_helper_protocol.h"

#include <array>
#include <string_view>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::size_t kMaxFields = 12;
static_assert(kMaxFields >= 10,
              "command frames carry ten fields and replies seven; a smaller "
              "split cap would silently truncate the authentication or mode "
              "fields");

bool ParseBoundedUnsigned(std::string_view text, std::uint64_t maximum,
                          std::uint64_t* out) {
  if (text.empty() || text.size() > 20 || out == nullptr)
    return false;
  if (text.size() > 1 && text.front() == '0')
    return false;  // no leading zeros: one value has exactly one encoding
  std::uint64_t value = 0;
  for (char digit : text) {
    if (digit < '0' || digit > '9')
      return false;
    if (value > (maximum - static_cast<std::uint64_t>(digit - '0')) / 10)
      return false;  // bounded: never wrap
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  *out = value;
  return true;
}

std::vector<std::string_view> SplitFields(std::string_view line) {
  std::vector<std::string_view> fields;
  std::size_t start = 0;
  while (start <= line.size() && fields.size() < kMaxFields) {
    const std::size_t separator = line.find(' ', start);
    if (separator == std::string_view::npos) {
      fields.push_back(line.substr(start));
      break;
    }
    fields.push_back(line.substr(start, separator - start));
    start = separator + 1;
  }
  return fields;
}

bool AcceptableFrame(const std::string& line) {
  if (line.empty() || line.size() > kVirtualDisplayHelperMaxFrameBytes)
    return false;
  for (char character : line) {
    // Printable ASCII only. A control byte in a control frame is a bug or an
    // attack, never a value.
    if (character < 0x20 || character > 0x7e)
      return false;
  }
  return true;
}

VirtualDisplayHelperVerb VerbFromText(std::string_view text) {
  if (text == "hold") return VirtualDisplayHelperVerb::kHold;
  if (text == "enable") return VirtualDisplayHelperVerb::kEnable;
  if (text == "disable") return VirtualDisplayHelperVerb::kDisable;
  if (text == "status") return VirtualDisplayHelperVerb::kStatus;
  if (text == "release") return VirtualDisplayHelperVerb::kRelease;
  return VirtualDisplayHelperVerb::kInvalid;
}

const char* TextFromVerb(VirtualDisplayHelperVerb verb) {
  switch (verb) {
    case VirtualDisplayHelperVerb::kHold: return "hold";
    case VirtualDisplayHelperVerb::kEnable: return "enable";
    case VirtualDisplayHelperVerb::kDisable: return "disable";
    case VirtualDisplayHelperVerb::kStatus: return "status";
    case VirtualDisplayHelperVerb::kRelease: return "release";
    case VirtualDisplayHelperVerb::kInvalid: break;
  }
  return "";
}

bool AcceptablePresence(const std::string& presence) {
  return presence == "absent" || presence == "inactive" || presence == "active";
}

}  // namespace

bool VirtualDisplayHelperCommand::IsValid() const noexcept {
  if (verb == VirtualDisplayHelperVerb::kInvalid)
    return false;
  // Every verb is generation-stamped. An unstamped frame cannot be attributed to
  // a worker, and an unattributable frame must never move a display.
  if (generation == 0)
    return false;
  // Enable/disable name a specific display; hold has nothing to name yet.
  const bool needs_display = verb == VirtualDisplayHelperVerb::kEnable ||
                             verb == VirtualDisplayHelperVerb::kDisable;
  if (needs_display && display_id == 0)
    return false;
  if (verb == VirtualDisplayHelperVerb::kHold && display_id != 0)
    return false;
  // Authentication fields are mandatory on every verb, including status. A
  // frame that can be replayed or that belongs to no host epoch must not be
  // answerable, and "read-only so it does not matter" is how an unauthenticated
  // status probe becomes a capability oracle.
  if (epoch == 0 || cookie == 0 || request_index == 0)
    return false;
  // Enable names an exact approved mode. Bounds are refusals, not clamps: a
  // clamped mode is a mode nobody approved.
  if (verb == VirtualDisplayHelperVerb::kEnable) {
    if (pixels_wide == 0 || pixels_high == 0 || refresh_millihertz == 0 ||
        scale_percent == 0) {
      return false;
    }
    if (pixels_wide > 8192 || pixels_high > 5120 ||
        refresh_millihertz > 240'000 || scale_percent > 400) {
      return false;
    }
  } else if (pixels_wide != 0 || pixels_high != 0 || refresh_millihertz != 0 ||
             scale_percent != 0) {
    // A mode on a verb that does not take one is a malformed frame, not a
    // field to ignore.
    return false;
  }
  return true;
}

bool ParseVirtualDisplayHelperCommand(const std::string& line,
                                      VirtualDisplayHelperCommand* command) {
  if (command == nullptr || !AcceptableFrame(line))
    return false;
  const std::vector<std::string_view> fields = SplitFields(line);
  if (fields.size() != 10)
    return false;
  VirtualDisplayHelperCommand parsed;
  parsed.verb = VerbFromText(fields[0]);
  std::uint64_t generation = 0;
  std::uint64_t display_id = 0;
  std::uint64_t epoch = 0;
  std::uint64_t cookie = 0;
  std::uint64_t request_index = 0;
  if (!ParseBoundedUnsigned(fields[1], UINT64_MAX, &generation))
    return false;
  if (!ParseBoundedUnsigned(fields[2], UINT32_MAX, &display_id))
    return false;
  if (!ParseBoundedUnsigned(fields[3], UINT64_MAX, &epoch))
    return false;
  if (!ParseBoundedUnsigned(fields[4], UINT64_MAX, &cookie))
    return false;
  if (!ParseBoundedUnsigned(fields[5], UINT64_MAX, &request_index))
    return false;
  std::uint64_t pixels_wide = 0, pixels_high = 0, refresh = 0, scale = 0;
  if (!ParseBoundedUnsigned(fields[6], UINT32_MAX, &pixels_wide) ||
      !ParseBoundedUnsigned(fields[7], UINT32_MAX, &pixels_high) ||
      !ParseBoundedUnsigned(fields[8], UINT32_MAX, &refresh) ||
      !ParseBoundedUnsigned(fields[9], UINT32_MAX, &scale)) {
    return false;
  }
  parsed.pixels_wide = static_cast<std::uint32_t>(pixels_wide);
  parsed.pixels_high = static_cast<std::uint32_t>(pixels_high);
  parsed.refresh_millihertz = static_cast<std::uint32_t>(refresh);
  parsed.scale_percent = static_cast<std::uint32_t>(scale);
  parsed.generation = generation;
  parsed.display_id = static_cast<std::uint32_t>(display_id);
  parsed.epoch = epoch;
  parsed.cookie = cookie;
  parsed.request_index = request_index;
  if (!parsed.IsValid())
    return false;
  *command = parsed;
  return true;
}

std::string SerializeVirtualDisplayHelperCommand(
    const VirtualDisplayHelperCommand& command) {
  if (!command.IsValid())
    return {};
  std::string line = TextFromVerb(command.verb);
  line += ' ';
  line += std::to_string(command.generation);
  line += ' ';
  line += std::to_string(command.display_id);
  line += ' ';
  line += std::to_string(command.epoch);
  line += ' ';
  line += std::to_string(command.cookie);
  line += ' ';
  line += std::to_string(command.request_index);
  line += ' ';
  line += std::to_string(command.pixels_wide);
  line += ' ';
  line += std::to_string(command.pixels_high);
  line += ' ';
  line += std::to_string(command.refresh_millihertz);
  line += ' ';
  line += std::to_string(command.scale_percent);
  return line.size() > kVirtualDisplayHelperMaxFrameBytes ? std::string() : line;
}

bool ParseVirtualDisplayHelperReply(const std::string& line,
                                    VirtualDisplayHelperReply* reply) {
  if (reply == nullptr || !AcceptableFrame(line))
    return false;
  const std::vector<std::string_view> fields = SplitFields(line);
  if (fields.size() != 7)
    return false;
  if (fields[0] != "ok" && fields[0] != "err")
    return false;
  VirtualDisplayHelperReply parsed;
  parsed.ok = fields[0] == "ok";
  std::uint64_t generation = 0;
  std::uint64_t display_id = 0;
  std::uint64_t cookie = 0;
  if (!ParseBoundedUnsigned(fields[1], UINT64_MAX, &generation))
    return false;
  if (!ParseBoundedUnsigned(fields[2], UINT32_MAX, &display_id))
    return false;
  if (!ParseBoundedUnsigned(fields[5], UINT64_MAX, &cookie))
    return false;
  if (fields[6] != "1" && fields[6] != "0")
    return false;
  parsed.generation = generation;
  parsed.display_id = static_cast<std::uint32_t>(display_id);
  parsed.cookie = cookie;
  parsed.admitted = fields[6] == "1";
  parsed.presence = std::string(fields[3]);
  if (!AcceptablePresence(parsed.presence))
    return false;
  parsed.error = std::string(fields[4]);
  // A success frame carrying an error string is contradictory; refuse it rather
  // than pick one half to believe.
  if (parsed.ok && parsed.error != "-")
    return false;
  if (!parsed.ok && parsed.error == "-")
    return false;
  if (parsed.error == "-")
    parsed.error.clear();
  *reply = parsed;
  return true;
}

std::string SerializeVirtualDisplayHelperReply(
    const VirtualDisplayHelperReply& reply) {
  std::string error = reply.error.empty() ? "-" : reply.error;
  for (char& character : error) {
    // The error is free text from the OS; keep it inside the frame grammar.
    if (character < 0x20 || character > 0x7e || character == ' ')
      character = '_';
  }
  const std::string presence =
      AcceptablePresence(reply.presence) ? reply.presence : "absent";
  if (reply.ok && !reply.error.empty())
    return {};
  if (!reply.ok && reply.error.empty())
    error = "unspecified";
  std::string line = reply.ok ? "ok" : "err";
  line += ' ';
  line += std::to_string(reply.generation);
  line += ' ';
  line += std::to_string(reply.display_id);
  line += ' ';
  line += presence;
  line += ' ';
  line += error;
  line += ' ';
  line += std::to_string(reply.cookie);
  line += ' ';
  // Explicit, never inferred from `ok`. A helper can answer correctly and hold
  // nothing; conflating the two is how "the socket replied" becomes "display
  // control is available".
  line += reply.admitted ? "1" : "0";
  if (line.size() > kVirtualDisplayHelperMaxFrameBytes) {
    // Truncating a frame would change its meaning. Drop it instead.
    return {};
  }
  return line;
}

bool HelperReplyProvesAdmission(const VirtualDisplayHelperReply& reply,
                                std::uint64_t expected_cookie,
                                std::uint64_t expected_generation) noexcept {
  // A zero cookie or generation is not a wildcard, it is an unusable question.
  // Treating it as a match would let a default-constructed reply authorise
  // display control.
  if (expected_cookie == 0 || expected_generation == 0)
    return false;
  if (!reply.ok)
    return false;
  // Binds the answer to THIS question.
  if (reply.cookie != expected_cookie)
    return false;
  // Binds the answer to the generation the caller believes it holds, so a
  // superseded helper cannot vouch for a newer route.
  if (reply.generation != expected_generation)
    return false;
  // Running and answering is not holding.
  if (!reply.admitted)
    return false;
  // Registered-but-inactive is NOT display control. It is precisely the state
  // that looks like success to any check that only asks whether a display
  // exists.
  if (reply.presence != "active")
    return false;
  if (reply.display_id == 0)
    return false;
  return true;
}

}  // namespace imcodes::remote_desktop::macos
