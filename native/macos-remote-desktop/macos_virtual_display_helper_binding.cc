#include "macos_virtual_display_helper_binding.h"

#include <cstdio>
#include <string_view>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

bool ParseUnsigned(std::string_view text, int base, std::uint64_t* out) noexcept {
  if (out == nullptr || text.empty() || text.size() > 20)
    return false;
  std::uint64_t value = 0;
  for (const char character : text) {
    std::uint64_t digit = 0;
    if (character >= '0' && character <= '9')
      digit = static_cast<std::uint64_t>(character - '0');
    else if (base == 16 && character >= 'a' && character <= 'f')
      digit = static_cast<std::uint64_t>(character - 'a') + 10U;
    else
      return false;
    const auto radix = static_cast<std::uint64_t>(base);
    // Overflow is a rejection, not a wrap: a wrapped value would be a different
    // epoch that still parses.
    if (value > (UINT64_MAX - digit) / radix)
      return false;
    value = value * radix + digit;
  }
  *out = value;
  return true;
}

bool ValidReleaseIdentity(std::string_view text) noexcept {
  // 96: the published release name is `sha256-` + 64 hex = 71 characters.
  if (text.empty() || text.size() > 96)
    return false;
  for (const char character : text) {
    const bool allowed = (character >= 'a' && character <= 'z') ||
                         (character >= 'A' && character <= 'Z') ||
                         (character >= '0' && character <= '9') ||
                         character == '.' || character == '-' || character == '_';
    if (!allowed)
      return false;
  }
  return true;
}

}  // namespace

bool VirtualDisplayHelperBinding::IsValid() const noexcept {
  // Every field is load-bearing, so a zero in any of them is an unusable
  // binding rather than a defaulted one.
  return epoch != 0 && cookie_seed != 0 && uid != 0 && generation != 0 &&
         ValidReleaseIdentity(release_identity);
}

bool ParseVirtualDisplayHelperBinding(const std::string& line,
                                      VirtualDisplayHelperBinding* binding) {
  if (binding == nullptr || line.empty() ||
      line.size() > kVirtualDisplayHelperBindingMaxBytes) {
    return false;
  }
  std::string_view view(line);
  while (!view.empty() && (view.back() == '\n' || view.back() == '\r'))
    view.remove_suffix(1);
  if (view.rfind("v1 ", 0) != 0)
    return false;
  view.remove_prefix(3);

  VirtualDisplayHelperBinding parsed;
  bool saw_epoch = false, saw_cookie = false, saw_uid = false;
  bool saw_generation = false, saw_release = false;
  while (!view.empty()) {
    const std::size_t space = view.find(' ');
    const std::string_view token = view.substr(0, space);
    view = space == std::string_view::npos ? std::string_view()
                                           : view.substr(space + 1);
    const std::size_t equals = token.find('=');
    if (equals == std::string_view::npos || equals == 0)
      return false;
    const std::string_view key = token.substr(0, equals);
    const std::string_view value = token.substr(equals + 1);
    std::uint64_t number = 0;
    // A repeated key is rejected rather than last-wins: two epochs in one line
    // is an attempt to have the parser pick, and it must not pick.
    if (key == "epoch") {
      if (saw_epoch || !ParseUnsigned(value, 16, &number)) return false;
      parsed.epoch = number; saw_epoch = true;
    } else if (key == "cookie") {
      if (saw_cookie || !ParseUnsigned(value, 16, &number)) return false;
      parsed.cookie_seed = number; saw_cookie = true;
    } else if (key == "uid") {
      if (saw_uid || !ParseUnsigned(value, 10, &number) || number > 0xFFFFFFFFULL)
        return false;
      parsed.uid = static_cast<std::uint32_t>(number); saw_uid = true;
    } else if (key == "generation") {
      if (saw_generation || !ParseUnsigned(value, 10, &number)) return false;
      parsed.generation = number; saw_generation = true;
    } else if (key == "release") {
      if (saw_release || !ValidReleaseIdentity(value)) return false;
      parsed.release_identity = std::string(value); saw_release = true;
    } else {
      // Unknown key: refuse. Silently ignoring it would let a future field be
      // dropped by an old helper that then believes it understood the binding.
      return false;
    }
  }
  if (!saw_epoch || !saw_cookie || !saw_uid || !saw_generation || !saw_release)
    return false;
  if (!parsed.IsValid())
    return false;
  *binding = std::move(parsed);
  return true;
}

std::string SerializeVirtualDisplayHelperBinding(
    const VirtualDisplayHelperBinding& binding) {
  char buffer[kVirtualDisplayHelperBindingMaxBytes];
  const int written = std::snprintf(
      buffer, sizeof(buffer), "v1 epoch=%llx cookie=%llx uid=%u generation=%llu release=%s\n",
      static_cast<unsigned long long>(binding.epoch),
      static_cast<unsigned long long>(binding.cookie_seed), binding.uid,
      static_cast<unsigned long long>(binding.generation),
      binding.release_identity.c_str());
  if (written <= 0 || static_cast<std::size_t>(written) >= sizeof(buffer))
    return std::string();
  return std::string(buffer, static_cast<std::size_t>(written));
}

std::uint64_t DeriveHelperCookie(std::uint64_t cookie_seed,
                                 std::uint64_t request_index) noexcept {
  // splitmix64 over seed XOR index. Avalanche matters: consecutive request
  // indices must not produce guessable neighbouring cookies, or observing one
  // frame would let a peer mint the next.
  std::uint64_t value = cookie_seed ^ (request_index * 0x9E3779B97F4A7C15ULL);
  value += 0x9E3779B97F4A7C15ULL;
  value = (value ^ (value >> 30U)) * 0xBF58476D1CE4E5B9ULL;
  value = (value ^ (value >> 27U)) * 0x94D049BB133111EBULL;
  value ^= value >> 31U;
  // A zero cookie would compare equal to an unset field.
  return value == 0 ? 1U : value;
}

HelperAdmission EvaluateHelperAdmission(
    const VirtualDisplayHelperBinding& binding,
    bool bound,
    std::uint64_t highest_spent_index,
    const HelperAdmissionRequest& request) noexcept {
  // Never bound: the helper answers nothing until the host has established the
  // binding out of band. This is the check that stops first-frame self-binding.
  if (!bound || !binding.IsValid())
    return HelperAdmission::kNotBound;
  if (request.running_uid != binding.uid)
    return HelperAdmission::kUidMismatch;
  if (request.epoch != binding.epoch)
    return HelperAdmission::kEpochMismatch;
  if (request.generation != binding.generation)
    return HelperAdmission::kGenerationMismatch;
  // Strictly advancing: a captured frame replayed later carries an index that
  // is no longer above the floor. Equality is a replay too.
  if (request.request_index <= highest_spent_index)
    return HelperAdmission::kCookieReplay;
  if (request.cookie != DeriveHelperCookie(binding.cookie_seed,
                                           request.request_index)) {
    return HelperAdmission::kCookieUnbound;
  }
  return HelperAdmission::kAdmitted;
}

}  // namespace imcodes::remote_desktop::macos
