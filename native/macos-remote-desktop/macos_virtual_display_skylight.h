// Dynamic SkyLight seam for virtual-display activation and topology truth.
//
// CoreGraphics' public surface cannot express what this needs. Two independent
// mature implementations converge on the same private path:
//   * Lumen drives SLSConfigureDisplayEnabled inside a display configuration
//     transaction, forces extend mode, and holds the display until SIGTERM.
//   * DeskPad ships as a notarized Developer ID app, sandboxed with a temporary
//     mach-lookup exception for com.apple.VirtualDisplay.
//
// Two facts from this host make the seam mandatory rather than optional:
//   1. Releasing the CGVirtualDisplay owner does NOT remove the display. The
//      refcount reaches zero and -dealloc runs; WindowServer keeps it, and it
//      survives process exit. Runtime enumeration shows no invalidate selector,
//      so there is no public teardown call to reach for.
//   2. CGGetOnlineDisplayList reported ONLY the aiDesk ids while
//      SLSGetDisplayList additionally reported inactive 1/2/3, and the prior
//      baseline id disappeared. The host's display was a FALLBACK that got
//      displaced. CGGetOnlineDisplayList alone therefore cannot distinguish
//      "removed" from "disabled but still registered", and cannot see whether
//      the fallback came back.
//
// Every symbol is resolved dynamically. A missing symbol makes the seam
// unavailable; it never degrades into assuming an undocumented shape still
// works, and it never links against a private framework.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SKYLIGHT_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SKYLIGHT_H_

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace imcodes::remote_desktop::macos {

/** One display as SkyLight sees it, which is more than CoreGraphics reports. */
struct SkyLightDisplay {
  std::uint32_t display_id = 0;
  /** Registered with WindowServer. A disabled display is still registered. */
  bool registered = false;
  /** Active in the current topology, i.e. what CGGetOnlineDisplayList shows. */
  bool active = false;
};

/**
 * Why enumeration matters more than any return code: the difference between
 * "disabled but still registered" and "fully removed" is the difference between
 * a display that will reappear and one that is gone.
 */
enum class SkyLightDisplayPresence {
  kAbsent,             // not registered at all: truly removed
  kRegisteredInactive, // disabled, still registered: NOT removed
  kActive,             // enabled and in the topology
};

/**
 * The private calls, behind a struct so the lifecycle is testable with no
 * SkyLight at all and so a real mutation cannot happen by accident.
 */
struct SkyLightSeam {
  /** SLSGetDisplayList: registered displays, including inactive ones. */
  std::function<std::vector<SkyLightDisplay>()> list_displays;
  /** SLSConfigureDisplayEnabled inside a begin/commit configuration transaction. */
  std::function<bool(std::uint32_t display_id, bool enabled, std::string* error)>
      configure_display_enabled;
  /** Forces extend rather than mirror, so capture sees its own surface. */
  std::function<bool(std::uint32_t display_id, std::string* error)> force_extend;
  /** CGGetOnlineDisplayList, kept separate: it is the weaker of the two views. */
  std::function<std::vector<std::uint32_t>()> online_display_ids;

  [[nodiscard]] bool IsComplete() const noexcept;
};

[[nodiscard]] SkyLightDisplayPresence PresenceOf(
    const std::vector<SkyLightDisplay>& displays,
    std::uint32_t display_id) noexcept;

/**
 * Resolves the private symbols by name at runtime.
 *
 * Returns an incomplete seam when any symbol is missing, which the caller must
 * treat as "display control unavailable" rather than as a reason to guess.
 * Declared here and defined in the .mm so pure C++ tests never link SkyLight.
 */
[[nodiscard]] SkyLightSeam ResolveSystemSkyLightSeam();

/**
 * Whether a genuinely destroy-capable virtual-display backend is available.
 *
 * MEASURED on this host: -[CGVirtualDisplay dealloc] has no reliable teardown --
 * its single destroy call sits behind a NULL check on a soft-linked pointer
 * with no error path, and the mach-port ivars are never released -- so
 * release-to-remove does not remove on macOS 26.x. SLVirtualDisplay DOES expose
 * an unconditional -destroy that tail-calls _CGSVirtualDisplayDestroy, and was
 * probed present on 26.2.
 *
 * This resolves the class and every selector at runtime. It returns false when
 * any of them is missing, and the caller must then REFUSE to create on an OS
 * whose legacy path is known not to remove. A version comment claiming the
 * modern path exists is not the same as the path existing, and creating anyway
 * would strand a display on every route.
 */
[[nodiscard]] bool DestroyCapableVirtualDisplayBackendAvailable();

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_SKYLIGHT_H_
