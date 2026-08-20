#include "third_party/imcodes_remote_desktop/virtual_display_controller.h"

#include <windows.h>
#include <sddl.h>
#include <swdevice.h>

#include <atomic>

#include "third_party/imcodes_remote_desktop/display_preferences.h"

namespace imcodes::rd {
namespace {

constexpr wchar_t kEnumerator[] = L"ImcodesVirtualDisplay";
constexpr wchar_t kInstance[] = L"Display0";
constexpr wchar_t kHardwareIds[] = L"ImcodesVirtualDisplay\0\0";

struct CreationResult {
  HANDLE event = nullptr;
  std::atomic<HRESULT> result{E_PENDING};
};

void WINAPI Created(HSWDEVICE device,
                    HRESULT result,
                    PVOID context,
                    PCWSTR instance_id) {
  UNREFERENCED_PARAMETER(device);
  UNREFERENCED_PARAMETER(instance_id);
  auto* creation = static_cast<CreationResult*>(context);
  creation->result.store(result);
  SetEvent(creation->event);
}

bool IsLocalSystemInSessionZero() {
  DWORD session_id = MAXDWORD;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id) ||
      session_id != 0) {
    return false;
  }
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token))
    return false;
  struct CloseToken {
    HANDLE value;
    ~CloseToken() { CloseHandle(value); }
  } token{raw_token};
  DWORD bytes = 0;
  GetTokenInformation(raw_token, TokenUser, nullptr, 0, &bytes);
  if (bytes == 0) return false;
  auto* user = static_cast<TOKEN_USER*>(HeapAlloc(GetProcessHeap(), 0, bytes));
  if (!user) return false;
  struct FreeUser {
    TOKEN_USER* value;
    ~FreeUser() { HeapFree(GetProcessHeap(), 0, value); }
  } free_user{user};
  if (!GetTokenInformation(raw_token, TokenUser, user, bytes, &bytes))
    return false;
  BYTE system_sid[SECURITY_MAX_SID_SIZE]{};
  DWORD system_sid_size = sizeof(system_sid);
  return CreateWellKnownSid(WinLocalSystemSid, nullptr, system_sid,
                            &system_sid_size) &&
         EqualSid(user->User.Sid, system_sid);
}

bool IsInteractiveUserSession() {
  DWORD session_id = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session_id) ||
      session_id == 0) {
    return false;
  }
  HDESK desktop = OpenInputDesktop(
      0, FALSE, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
  if (!desktop) return false;
  wchar_t name[64]{};
  DWORD needed = 0;
  const bool valid = GetUserObjectInformationW(
      desktop, UOI_NAME, name, sizeof(name), &needed) != FALSE &&
      lstrcmpiW(name, L"Default") == 0;
  CloseDesktop(desktop);
  return valid;
}

bool FindExactVirtualDisplay(DISPLAY_DEVICEW* match) {
  bool found = false;
  for (DWORD index = 0;; ++index) {
    DISPLAY_DEVICEW device{};
    device.cb = sizeof(device);
    if (!EnumDisplayDevicesW(nullptr, index, &device, 0)) break;
    if (lstrcmpW(device.DeviceString, L"IM.codes Headless Display") != 0 ||
        lstrcmpiW(device.DeviceID, kEnumerator) != 0) {
      continue;
    }
    if (found) return false;
    *match = device;
    found = true;
  }
  return found;
}

POINTL SecondaryDisplayPosition(const wchar_t* excluded_device_name) {
  LONG right = 0;
  LONG top = 0;
  bool attached = false;
  for (DWORD index = 0;; ++index) {
    DISPLAY_DEVICEW device{};
    device.cb = sizeof(device);
    if (!EnumDisplayDevicesW(nullptr, index, &device, 0)) break;
    if ((device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) == 0)
      continue;
    if (lstrcmpiW(device.DeviceName, excluded_device_name) == 0) continue;
    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    if (!EnumDisplaySettingsExW(device.DeviceName, ENUM_CURRENT_SETTINGS,
                                &mode, EDS_RAWMODE)) {
      continue;
    }
    const LONG candidate = mode.dmPosition.x +
        static_cast<LONG>(mode.dmPelsWidth);
    if (!attached || candidate > right) right = candidate;
    if (!attached || mode.dmPosition.y < top) top = mode.dmPosition.y;
    attached = true;
  }
  return {attached ? right : 0, attached ? top : 0};
}

}  // namespace

int RunVirtualDisplayController() {
  if (!IsLocalSystemInSessionZero()) return 20;
  HANDLE parent_lifetime = GetStdHandle(STD_INPUT_HANDLE);
  if (!parent_lifetime || parent_lifetime == INVALID_HANDLE_VALUE ||
      GetFileType(parent_lifetime) != FILE_TYPE_PIPE) {
    return 21;
  }
  CreationResult creation;
  creation.event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!creation.event) return 22;
  SW_DEVICE_CREATE_INFO information{};
  information.cbSize = sizeof(information);
  information.pszInstanceId = kInstance;
  information.pszzHardwareIds = kHardwareIds;
  information.pszzCompatibleIds = kHardwareIds;
  information.pszDeviceDescription = L"IM.codes Headless Display";
  information.CapabilityFlags = SWDeviceCapabilitiesRemovable |
                                SWDeviceCapabilitiesSilentInstall |
                                SWDeviceCapabilitiesDriverRequired;
  HSWDEVICE device = nullptr;
  const HRESULT started = SwDeviceCreate(
      kEnumerator, L"HTREE\\ROOT\\0", &information, 0, nullptr, Created,
      &creation, &device);
  if (FAILED(started)) {
    CloseHandle(creation.event);
    return 23;
  }
  const DWORD wait = WaitForSingleObject(creation.event, 15'000);
  CloseHandle(creation.event);
  if (wait != WAIT_OBJECT_0 || FAILED(creation.result.load())) {
    SwDeviceClose(device);
    return 24;
  }

  // No commands or authority cross this pipe. The single blocking read exists
  // solely so parent death/close deterministically tears down the SwDevice.
  BYTE ignored = 0;
  DWORD read = 0;
  while (ReadFile(parent_lifetime, &ignored, 1, &read, nullptr) && read > 0) {
  }
  SwDeviceClose(device);
  return 0;
}

int ActivateVirtualDisplayForCurrentUser() {
  if (!IsInteractiveUserSession()) return 30;
  DISPLAY_DEVICEW device{};
  device.cb = sizeof(device);
  if (!FindExactVirtualDisplay(&device)) return 31;

  DEVMODEW mode{};
  mode.dmSize = sizeof(mode);
  VirtualDisplayPreferences preferences{1920, 1080, 150};
  LoadVirtualDisplayPreferences(&preferences);
  const bool attached =
      (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0;
  if (!EnumDisplaySettingsExW(
          device.DeviceName,
          attached ? ENUM_CURRENT_SETTINGS : ENUM_REGISTRY_SETTINGS,
          &mode, EDS_RAWMODE)) {
    mode.dmPelsWidth = 1920;
    mode.dmPelsHeight = 1080;
    mode.dmBitsPerPel = 32;
    mode.dmDisplayFrequency = 60;
  }
  if (!attached) mode.dmPosition = SecondaryDisplayPosition(device.DeviceName);
  if (attached && mode.dmPelsWidth == static_cast<DWORD>(preferences.width) &&
      mode.dmPelsHeight == static_cast<DWORD>(preferences.height) &&
      mode.dmDisplayFrequency == 60) {
    return 0;
  }
  mode.dmPelsWidth = static_cast<DWORD>(preferences.width);
  mode.dmPelsHeight = static_cast<DWORD>(preferences.height);
  mode.dmBitsPerPel = 32;
  mode.dmDisplayFrequency = 60;
  mode.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT |
                  DM_BITSPERPEL | DM_DISPLAYFREQUENCY;
  if (ChangeDisplaySettingsExW(device.DeviceName, &mode, nullptr, CDS_TEST,
                               nullptr) != DISP_CHANGE_SUCCESSFUL) {
    return 32;
  }
  if (ChangeDisplaySettingsExW(
          device.DeviceName, &mode, nullptr,
          CDS_UPDATEREGISTRY | CDS_NORESET, nullptr) !=
      DISP_CHANGE_SUCCESSFUL) {
    return 33;
  }
  return ChangeDisplaySettingsExW(nullptr, nullptr, nullptr, 0, nullptr) ==
                 DISP_CHANGE_SUCCESSFUL
             ? 0
             : 34;
}

}  // namespace imcodes::rd
