#include "macos_worker_control.h"

#include <array>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

// sizeof(sockaddr_un::sun_path) on Darwin. Hard-coded rather than included so
// this translation unit stays free of OS headers and remains testable without
// a desktop session.
constexpr std::size_t kMaxUnixSocketPathBytes = 104;

bool ParseUnsigned(std::string_view text, std::uint64_t* out) noexcept {
  if (text.empty() || text.size() > 19) return false;
  if (text.size() > 1 && text[0] == '0') return false;
  std::uint64_t value = 0;
  for (const char digit : text) {
    if (digit < '0' || digit > '9') return false;
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  *out = value;
  return true;
}

bool HasControlCharacter(std::string_view value) noexcept {
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    if (byte < 0x20 || byte == 0x7f) return true;
  }
  return false;
}

// Splits on single spaces with no tolerance for runs or trailing separators:
// the wire format is fixed, so anything else is a different message.
bool SplitExact(std::string_view line, std::size_t expected,
                std::vector<std::string_view>* parts) {
  parts->clear();
  std::size_t start = 0;
  for (;;) {
    const std::size_t space = line.find(' ', start);
    if (space == std::string_view::npos) {
      parts->push_back(line.substr(start));
      break;
    }
    parts->push_back(line.substr(start, space - start));
    start = space + 1;
  }
  if (parts->size() != expected) return false;
  for (const auto& part : *parts) {
    if (part.empty()) return false;
  }
  return true;
}

const char* VerbToken(ControlVerb verb) noexcept {
  return verb == ControlVerb::kReleaseInput ? kControlVerbReleaseInput
                                            : kControlVerbStopCapture;
}

}  // namespace

bool BuildControlSocketPath(std::uint32_t uid, std::string* out) {
  if (out == nullptr) return false;
  std::string path;
  path.append(kControlRuntimeRoot)
      .append("/")
      .append(std::to_string(uid))
      .append("/")
      .append(kControlRuntimeLeaf)
      .append("/")
      .append(kControlSocketName);
  // A truncated sun_path would bind or connect somewhere other than intended.
  if (path.size() >= kMaxUnixSocketPathBytes) return false;
  *out = std::move(path);
  return true;
}

bool SerializeControlRequest(ControlVerb verb, std::uint64_t generation,
                             std::string* out) {
  if (out == nullptr) return false;
  std::string line;
  line.append(kControlProtocolTag)
      .append(" ")
      .append(VerbToken(verb))
      .append(" ")
      .append(std::to_string(generation));
  if (line.size() > kControlMaxLineBytes) return false;
  *out = std::move(line);
  return true;
}

bool ParseControlRequest(std::string_view line, ControlVerb* verb,
                         std::uint64_t* generation) {
  if (verb == nullptr || generation == nullptr) return false;
  if (line.empty() || line.size() > kControlMaxLineBytes) return false;
  if (HasControlCharacter(line)) return false;
  std::vector<std::string_view> parts;
  if (!SplitExact(line, 3, &parts)) return false;
  if (parts[0] != kControlProtocolTag) return false;
  if (parts[1] == kControlVerbReleaseInput) {
    *verb = ControlVerb::kReleaseInput;
  } else if (parts[1] == kControlVerbStopCapture) {
    *verb = ControlVerb::kStopCapture;
  } else {
    return false;
  }
  return ParseUnsigned(parts[2], generation);
}

bool SerializeControlOk(std::uint64_t generation, std::string* out) {
  if (out == nullptr || generation == 0) return false;
  std::string line;
  line.append(kControlProtocolTag)
      .append(" ")
      .append(kControlStatusOk)
      .append(" ")
      .append(std::to_string(generation));
  if (line.size() > kControlMaxLineBytes) return false;
  *out = std::move(line);
  return true;
}

bool SerializeControlError(std::string_view reason, std::string* out) {
  if (out == nullptr || reason.empty()) return false;
  if (HasControlCharacter(reason) ||
      reason.find(' ') != std::string_view::npos) {
    return false;
  }
  std::string line;
  line.append(kControlProtocolTag)
      .append(" ")
      .append(kControlStatusError)
      .append(" ")
      .append(reason);
  if (line.size() > kControlMaxLineBytes) return false;
  *out = std::move(line);
  return true;
}

bool ParseControlResponse(std::string_view line, ControlResponse* out) {
  if (out == nullptr) return false;
  if (line.empty() || line.size() > kControlMaxLineBytes) return false;
  if (HasControlCharacter(line)) return false;
  std::vector<std::string_view> parts;
  if (!SplitExact(line, 3, &parts)) return false;
  if (parts[0] != kControlProtocolTag) return false;
  if (parts[1] == kControlStatusOk) {
    std::uint64_t generation = 0;
    // A success that does not name a generation is not proof of anything.
    if (!ParseUnsigned(parts[2], &generation) || generation == 0) return false;
    out->ok = true;
    out->generation = generation;
    out->error.clear();
    return true;
  }
  if (parts[1] == kControlStatusError) {
    out->ok = false;
    out->generation = 0;
    out->error.assign(parts[2]);
    return true;
  }
  return false;
}

bool ControlRequestMayAct(std::uint64_t requested_generation,
                          std::uint64_t active_generation,
                          std::string* error_reason) {
  if (active_generation == 0) {
    if (error_reason != nullptr) *error_reason = kControlErrorNoActiveSession;
    return false;
  }
  // Zero means "whatever you own"; a nonzero value must be exact so a stale
  // daemon cannot clean up a session it no longer owns.
  if (requested_generation != 0 && requested_generation != active_generation) {
    if (error_reason != nullptr)
      *error_reason = kControlErrorGenerationMismatch;
    return false;
  }
  return true;
}

}  // namespace imcodes::remote_desktop::macos
