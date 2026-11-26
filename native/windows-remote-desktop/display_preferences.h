#ifndef IMCODES_REMOTE_DESKTOP_DISPLAY_PREFERENCES_H_
#define IMCODES_REMOTE_DESKTOP_DISPLAY_PREFERENCES_H_

namespace imcodes::rd {

struct VirtualDisplayPreferences {
  int width = 0;
  int height = 0;
  int dpi_scale_percent = 0;
};

// Preferences contain only allow-listed display values and live in the
// interactive user's registry hive. They never carry authority or paths.
bool LoadVirtualDisplayPreferences(VirtualDisplayPreferences* preferences);
bool SaveVirtualDisplayPreferences(
    const VirtualDisplayPreferences& preferences);

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_DISPLAY_PREFERENCES_H_
