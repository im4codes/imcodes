#include "third_party/imcodes_remote_desktop/display_preferences.h"

#include <windows.h>

#include "third_party/imcodes_remote_desktop/worker_policy.h"

namespace imcodes::rd {
namespace {

constexpr wchar_t kPreferencesKey[] = L"Software\\IM.codes\\RemoteDesktop";
constexpr wchar_t kSchemaValue[] = L"DisplayPreferenceSchema";
constexpr wchar_t kWidthValue[] = L"VirtualWidth";
constexpr wchar_t kHeightValue[] = L"VirtualHeight";
constexpr wchar_t kDpiValue[] = L"VirtualDpiScalePercent";
constexpr DWORD kPreferenceSchema = 1;

bool ReadDword(HKEY key, const wchar_t* name, DWORD* value) {
  DWORD type = 0;
  DWORD bytes = sizeof(*value);
  return RegQueryValueExW(key, name, nullptr, &type,
                          reinterpret_cast<BYTE*>(value), &bytes) ==
             ERROR_SUCCESS &&
         type == REG_DWORD && bytes == sizeof(*value);
}

bool WriteDword(HKEY key, const wchar_t* name, DWORD value) {
  return RegSetValueExW(key, name, 0, REG_DWORD,
                        reinterpret_cast<const BYTE*>(&value),
                        sizeof(value)) == ERROR_SUCCESS;
}

}  // namespace

bool LoadVirtualDisplayPreferences(VirtualDisplayPreferences* preferences) {
  if (!preferences) return false;
  HKEY raw_key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kPreferencesKey, 0, KEY_QUERY_VALUE,
                    &raw_key) != ERROR_SUCCESS) {
    return false;
  }
  struct CloseKey {
    HKEY key;
    ~CloseKey() { RegCloseKey(key); }
  } close{raw_key};
  DWORD schema = 0;
  DWORD width = 0;
  DWORD height = 0;
  DWORD dpi = 0;
  if (!ReadDword(raw_key, kSchemaValue, &schema) ||
      !ReadDword(raw_key, kWidthValue, &width) ||
      !ReadDword(raw_key, kHeightValue, &height) ||
      !ReadDword(raw_key, kDpiValue, &dpi) ||
      schema != kPreferenceSchema ||
      !IsAllowedRemoteDisplayMode(static_cast<int>(width),
                                  static_cast<int>(height)) ||
      !IsAllowedRemoteDisplayScale(static_cast<int>(dpi))) {
    return false;
  }
  preferences->width = static_cast<int>(width);
  preferences->height = static_cast<int>(height);
  preferences->dpi_scale_percent = static_cast<int>(dpi);
  return true;
}

bool SaveVirtualDisplayPreferences(
    const VirtualDisplayPreferences& preferences) {
  if (!IsAllowedRemoteDisplayMode(preferences.width, preferences.height) ||
      !IsAllowedRemoteDisplayScale(preferences.dpi_scale_percent)) {
    return false;
  }
  HKEY raw_key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, kPreferencesKey, 0, nullptr, 0,
                      KEY_SET_VALUE, nullptr, &raw_key, nullptr) !=
      ERROR_SUCCESS) {
    return false;
  }
  struct CloseKey {
    HKEY key;
    ~CloseKey() { RegCloseKey(key); }
  } close{raw_key};

  // Invalidate first. Termination between writes leaves schema 0, so a
  // partially updated record is never accepted on the next connection.
  bool ok = WriteDword(raw_key, kSchemaValue, 0) &&
            WriteDword(raw_key, kWidthValue,
                       static_cast<DWORD>(preferences.width)) &&
            WriteDword(raw_key, kHeightValue,
                       static_cast<DWORD>(preferences.height)) &&
            WriteDword(raw_key, kDpiValue,
                       static_cast<DWORD>(preferences.dpi_scale_percent)) &&
            WriteDword(raw_key, kSchemaValue, kPreferenceSchema);
  if (ok) ok = RegFlushKey(raw_key) == ERROR_SUCCESS;
  return ok;
}

}  // namespace imcodes::rd
