// Version admission for the private virtual-display surface.
//
// Every symbol this feature needs is private. Apple has already moved it once:
// on macOS 26.2 releasing the CGVirtualDisplay owner no longer removes the
// display, which is the whole reason the helper architecture exists. A version
// this code has never been qualified against must therefore be refused, not
// probed optimistically — an unknown build is the case where "it looked like it
// worked" strands a display until the user reboots.
//
// Pure C++ so the policy is testable with no macOS at all.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_VERSION_GATE_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_VERSION_GATE_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

struct MacosVersion {
  std::uint32_t major = 0;
  std::uint32_t minor = 0;
  std::uint32_t patch = 0;

  [[nodiscard]] bool IsValid() const noexcept { return major != 0; }
};

/** Why a version was refused. Reported so an operator sees the real reason. */
enum class VirtualDisplayVersionVerdict {
  kUnknownVersion,      // could not read a version at all: fail closed
  kBelowMinimum,        // older than anything qualified
  kQualified,           // inside a range this code has been qualified against
  kRemovalRegressed,    // qualified for HOLD, but teardown is known broken here
  kAboveQualified,      // newer than anything qualified: fail closed
};

struct VirtualDisplayVersionDecision {
  VirtualDisplayVersionVerdict verdict =
      VirtualDisplayVersionVerdict::kUnknownVersion;
  /** May a display be created and held at all? */
  bool may_hold = false;
  /**
   * May dropping the legacy CGVirtualDisplay owner be reported as a removal?
   *
   * False on 26.x. MEASURED root cause (read-only runtime probe on 26.2/25C56):
   * CGVirtualDisplay exposes NO teardown selector at all — only -dealloc — and
   * -dealloc's single destroy call sits behind a NULL check on a soft-linked
   * function pointer with no error path, while the three mach-port ivars are
   * never released. So release-to-remove is fail-open by construction.
   *
   * This is deliberately NOT the same question as "can this OS remove a display
   * at all". SLVirtualDisplay, which DOES expose a real -destroy, was probed
   * present on this very host; see modern_destroy_path_expected.
   */
  bool legacy_release_removes = false;
  /**
   * Whether the modern SLVirtualDisplay/-destroy path is expected on this OS.
   * The gate only states an expectation; the seam must still resolve the class
   * and selector at runtime and fail closed if either is missing. Hard-coding
   * "26 cannot remove" would have permanently blocked the one path measured to
   * work.
   */
  bool modern_destroy_path_expected = false;
  std::string reason;
};

/** Parses "26.2", "26.2.1", "15.3" and the ProductVersion form. Fails closed. */
[[nodiscard]] MacosVersion ParseMacosVersion(const std::string& text) noexcept;

[[nodiscard]] VirtualDisplayVersionDecision EvaluateVirtualDisplayVersion(
    const MacosVersion& version) noexcept;

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_VERSION_GATE_H_
