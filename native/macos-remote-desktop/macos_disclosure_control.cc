#include "macos_disclosure_control.h"

namespace imcodes::remote_desktop::macos {
namespace {

const char* EventToken(DisclosureEvent event) noexcept {
  switch (event) {
    case DisclosureEvent::kReady:
      return kDisclosureEventReady;
    case DisclosureEvent::kStop:
      return kDisclosureEventStop;
    case DisclosureEvent::kClosed:
      return kDisclosureEventClosed;
    case DisclosureEvent::kFailed:
      return kDisclosureEventFailed;
  }
  return "";
}

bool TokenToEvent(std::string_view token, DisclosureEvent* event) noexcept {
  if (token == kDisclosureEventReady) {
    *event = DisclosureEvent::kReady;
    return true;
  }
  if (token == kDisclosureEventStop) {
    *event = DisclosureEvent::kStop;
    return true;
  }
  if (token == kDisclosureEventClosed) {
    *event = DisclosureEvent::kClosed;
    return true;
  }
  if (token == kDisclosureEventFailed) {
    *event = DisclosureEvent::kFailed;
    return true;
  }
  return false;
}

bool ParseGeneration(std::string_view text, std::uint64_t* out) noexcept {
  if (text.empty() || text.size() > 19) return false;
  if (text.size() > 1 && text[0] == '0') return false;
  std::uint64_t value = 0;
  for (const char digit : text) {
    if (digit < '0' || digit > '9') return false;
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  if (value == 0) return false;
  *out = value;
  return true;
}

}  // namespace

bool SerializeDisclosureEvent(DisclosureEvent event, std::uint64_t generation,
                              std::string* out) {
  if (out == nullptr || generation == 0) return false;
  const std::string_view token(EventToken(event));
  if (token.empty()) return false;
  std::string line;
  line.reserve(kDisclosureEventMaxLineBytes);
  line.append(token).append(" ").append(std::to_string(generation));
  if (line.size() > kDisclosureEventMaxLineBytes) return false;
  *out = std::move(line);
  return true;
}

bool ParseDisclosureEvent(std::string_view line, DisclosureEvent* event,
                          std::uint64_t* generation) {
  if (event == nullptr || generation == nullptr) return false;
  if (line.empty() || line.size() > kDisclosureEventMaxLineBytes) return false;
  for (const char character : line) {
    const auto byte = static_cast<unsigned char>(character);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  const std::size_t space = line.find(' ');
  if (space == std::string_view::npos) return false;
  // Exactly one separator: a second field would mean this is not the fixed
  // two-token line the seam is defined as.
  if (line.find(' ', space + 1) != std::string_view::npos) return false;

  DisclosureEvent parsed_event = DisclosureEvent::kFailed;
  if (!TokenToEvent(line.substr(0, space), &parsed_event)) return false;
  std::uint64_t parsed_generation = 0;
  if (!ParseGeneration(line.substr(space + 1), &parsed_generation)) {
    return false;
  }
  *event = parsed_event;
  *generation = parsed_generation;
  return true;
}

bool DisclosureAdmission::Apply(DisclosureEvent event,
                                std::uint64_t generation) noexcept {
  // A late event from a replaced disclosure process must not touch the live
  // session, in either direction.
  if (generation != generation_) return false;
  if (terminated_) return false;
  switch (event) {
    case DisclosureEvent::kReady:
      ready_ = true;
      return true;
    case DisclosureEvent::kStop:
      stop_requested_ = true;
      ready_ = false;
      terminated_ = true;
      return true;
    case DisclosureEvent::kClosed:
    case DisclosureEvent::kFailed:
      // No visible disclosure means no admissible route. Losing the window is
      // treated exactly like an explicit Stop for admission purposes; only the
      // user-intent flag differs.
      ready_ = false;
      terminated_ = true;
      return true;
  }
  return false;
}

}  // namespace imcodes::remote_desktop::macos
