#include "macos_virtual_display_version_gate.h"

#include <cstdlib>

namespace imcodes::remote_desktop::macos {
namespace {

// Oldest build the adapter's mode/descriptor shape has been exercised against.
constexpr std::uint32_t kMinimumMajor = 13;
// Newest MAJOR this code has been qualified against. A newer major is refused
// outright rather than probed: the 26.x teardown regression is exactly what an
// optimistic probe would have missed.
constexpr std::uint32_t kMaximumQualifiedMajor = 26;
// The LEGACY CGVirtualDisplay release path was measured broken on 26.2 (25C56),
// so the whole major is treated as legacy-removal-regressed.
constexpr std::uint32_t kRemovalRegressedMajor = 26;
// SLVirtualDisplay (with a real -destroy) is expected from this major onward.
// Probed present on 26.2; the exact introduction release is NOT established, so
// this is an expectation the runtime seam must still confirm.
constexpr std::uint32_t kModernDestroyExpectedMajor = 15;

bool ParseComponent(const std::string& text,
                    std::size_t& cursor,
                    std::uint32_t* out) noexcept {
  if (cursor >= text.size() || out == nullptr)
    return false;
  std::uint64_t value = 0;
  std::size_t digits = 0;
  while (cursor < text.size() && text[cursor] >= '0' && text[cursor] <= '9') {
    // Bounded accumulate: a pathological version string must not wrap.
    if (digits >= 6)
      return false;
    value = value * 10 + static_cast<std::uint64_t>(text[cursor] - '0');
    ++cursor;
    ++digits;
  }
  if (digits == 0)
    return false;
  *out = static_cast<std::uint32_t>(value);
  return true;
}

}  // namespace

MacosVersion ParseMacosVersion(const std::string& text) noexcept {
  MacosVersion version;
  std::size_t cursor = 0;
  std::uint32_t major = 0;
  if (!ParseComponent(text, cursor, &major) || major == 0)
    return version;
  std::uint32_t minor = 0;
  std::uint32_t patch = 0;
  if (cursor < text.size() && text[cursor] == '.') {
    ++cursor;
    if (!ParseComponent(text, cursor, &minor))
      return version;
    if (cursor < text.size() && text[cursor] == '.') {
      ++cursor;
      if (!ParseComponent(text, cursor, &patch))
        return version;
    }
  }
  // Trailing junk means this is not a version string we understand. Refusing is
  // the point: a half-parsed "26.2-beta-something" must not read as 26.2.
  if (cursor != text.size())
    return version;
  version.major = major;
  version.minor = minor;
  version.patch = patch;
  return version;
}

VirtualDisplayVersionDecision EvaluateVirtualDisplayVersion(
    const MacosVersion& version) noexcept {
  VirtualDisplayVersionDecision decision;
  if (!version.IsValid()) {
    decision.verdict = VirtualDisplayVersionVerdict::kUnknownVersion;
    decision.reason = "macOS version could not be determined";
    return decision;
  }
  if (version.major < kMinimumMajor) {
    decision.verdict = VirtualDisplayVersionVerdict::kBelowMinimum;
    decision.reason = "macOS predates the qualified virtual-display surface";
    return decision;
  }
  if (version.major > kMaximumQualifiedMajor) {
    decision.verdict = VirtualDisplayVersionVerdict::kAboveQualified;
    decision.reason =
        "macOS is newer than any build this private surface was qualified "
        "against";
    return decision;
  }
  decision.modern_destroy_path_expected =
      version.major >= kModernDestroyExpectedMajor;
  if (version.major == kRemovalRegressedMajor) {
    decision.verdict = VirtualDisplayVersionVerdict::kRemovalRegressed;
    decision.may_hold = true;
    decision.legacy_release_removes = false;
    decision.reason =
        "dropping the legacy CGVirtualDisplay owner does not remove the display "
        "on this macOS major; use the SLVirtualDisplay destroy path if the "
        "runtime seam resolves it, otherwise hold the display warm and tear "
        "down authority only";
    return decision;
  }
  decision.verdict = VirtualDisplayVersionVerdict::kQualified;
  decision.may_hold = true;
  decision.legacy_release_removes = true;
  return decision;
}

}  // namespace imcodes::remote_desktop::macos
