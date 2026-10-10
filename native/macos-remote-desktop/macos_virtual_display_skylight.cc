#include "macos_virtual_display_skylight.h"

namespace imcodes::remote_desktop::macos {

bool SkyLightSeam::IsComplete() const noexcept {
  // Every call must be present. A partially resolved seam is the dangerous
  // case: enumeration without configure_display_enabled would let the caller
  // observe a display it cannot disable, and configure without enumeration
  // would let it claim a transition it cannot verify.
  return static_cast<bool>(list_displays) &&
         static_cast<bool>(configure_display_enabled) &&
         static_cast<bool>(force_extend) &&
         static_cast<bool>(online_display_ids);
}

SkyLightDisplayPresence PresenceOf(const std::vector<SkyLightDisplay>& displays,
                                   std::uint32_t display_id) noexcept {
  if (display_id == 0)
    return SkyLightDisplayPresence::kAbsent;
  for (const SkyLightDisplay& display : displays) {
    if (display.display_id != display_id)
      continue;
    // Registered-but-inactive is the state the whole design turns on: the
    // display is disabled and gone from CGGetOnlineDisplayList, yet it still
    // exists and can be re-enabled by id. Reporting that as kAbsent would let
    // a caller "create" a second display on top of the one it already owns.
    if (!display.registered)
      return SkyLightDisplayPresence::kAbsent;
    return display.active ? SkyLightDisplayPresence::kActive
                          : SkyLightDisplayPresence::kRegisteredInactive;
  }
  return SkyLightDisplayPresence::kAbsent;
}

}  // namespace imcodes::remote_desktop::macos
