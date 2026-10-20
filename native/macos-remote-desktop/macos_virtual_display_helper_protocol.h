// Bounded control protocol between the worker and the long-lived display helper.
//
// The helper exists because the display's lifetime IS the holder process's
// lifetime — that is the one property macOS 26.2 still honours after
// -dealloc stopped removing displays. Lumen's vd_helper and DeskPad's app
// lifecycle are the same shape.
//
// The worker therefore cannot "destroy" a display by dropping an object; it can
// only ask the helper to hold, enable, disable, or exit. Those four verbs are
// this protocol, and nothing here carries a credential or a route.
//
// Frames are single newline-terminated lines with a hard length cap, so a
// wedged or hostile peer cannot make the reader allocate without bound.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_PROTOCOL_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_PROTOCOL_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

/** Hard cap for one control line, newline included. */
inline constexpr std::size_t kVirtualDisplayHelperMaxFrameBytes = 512;

enum class VirtualDisplayHelperVerb {
  kInvalid,
  kHold,     // create and hold the single warm display
  kEnable,   // SkyLight enable + force extend
  kDisable,  // SkyLight disable; stays registered and warm
  kStatus,   // report id and presence
  kRelease,  // drop the hold and exit
};

struct VirtualDisplayHelperCommand {
  VirtualDisplayHelperVerb verb = VirtualDisplayHelperVerb::kInvalid;
  /**
   * Generation the worker believes it holds. The helper echoes it back and
   * refuses any verb stamped with a generation other than the one currently
   * bound, so a late frame from a superseded worker cannot disable a display a
   * newer generation just enabled.
   */
  std::uint64_t generation = 0;
  std::uint32_t display_id = 0;
  /**
   * Per-request nonce. The helper must echo it. Without it a status reply
   * proves only that SOMETHING answered the socket, not that it answered THIS
   * question — a stale frame still in the buffer, or a reply to a previous
   * caller, would otherwise read as a live admission.
   */
  std::uint64_t cookie = 0;
  /** Host epoch this frame claims to belong to. Must equal the launch binding. */
  std::uint64_t epoch = 0;
  /** Strictly advancing request index; the replay floor is kept against it. */
  std::uint64_t request_index = 0;
  /**
   * Approved mode for kEnable, in exact units. Carried because the helper is
   * the only process that may touch the display: without it the worker's mode
   * and scale selection is simply discarded, and the display keeps whatever
   * WindowServer picked. Zero for every other verb.
   */
  std::uint32_t pixels_wide = 0;
  std::uint32_t pixels_high = 0;
  std::uint32_t refresh_millihertz = 0;
  std::uint32_t scale_percent = 0;

  [[nodiscard]] bool IsValid() const noexcept;
};

struct VirtualDisplayHelperReply {
  bool ok = false;
  std::uint64_t generation = 0;
  std::uint32_t display_id = 0;
  std::uint64_t cookie = 0;
  /**
   * Whether this helper currently HOLDS the warm display under the generation
   * it reports. Distinct from `ok`: a helper that is running and answering
   * correctly but holds nothing must not read as display control being
   * available.
   */
  bool admitted = false;
  /** "absent" | "inactive" | "active" */
  std::string presence;
  std::string error;
};

/**
 * Decides whether a status exchange proves live, authenticated, held display
 * control. Every unmet condition is false; there is no "probably".
 *
 * Split out as a pure function so the fail-closed rules are provable offline,
 * with no helper, no socket and no display.
 */
[[nodiscard]] bool HelperReplyProvesAdmission(
    const VirtualDisplayHelperReply& reply,
    std::uint64_t expected_cookie,
    std::uint64_t expected_generation) noexcept;

/** Parses exactly one frame. Rejects oversized, malformed or unknown verbs. */
[[nodiscard]] bool ParseVirtualDisplayHelperCommand(
    const std::string& line,
    VirtualDisplayHelperCommand* command);

[[nodiscard]] std::string SerializeVirtualDisplayHelperCommand(
    const VirtualDisplayHelperCommand& command);

[[nodiscard]] bool ParseVirtualDisplayHelperReply(
    const std::string& line,
    VirtualDisplayHelperReply* reply);

[[nodiscard]] std::string SerializeVirtualDisplayHelperReply(
    const VirtualDisplayHelperReply& reply);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_PROTOCOL_H_
