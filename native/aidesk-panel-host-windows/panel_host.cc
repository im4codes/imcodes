// aidesk-local-ui.exe -- the local management panel as aiDesk's own Windows application window.
//
// The panel is a web page served by the node on the loopback. Shown in a browser's app mode it carries the browser's taskbar icon;
// shown here, in a WebView2 control inside a window of this executable (icon resource, AppUserModelID), the taskbar, Alt-Tab and the
// title bar are aiDesk's. One window per desktop session (a named mutex; a second start raises the first). The web view may only
// ever show the panel's own origin: every other navigation is cancelled, new windows are never created, there is no script bridge
// to the host and no developer tools.
//
// Built with the fixed WebView2 SDK headers and the static loader (native/aidesk-panel-host-windows/webview2.lock.json); nothing is
// downloaded when it runs. Without the WebView2 runtime it exits with kExitRuntimeMissing and the node uses the browser window.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>

#include <atomic>
#include <functional>
#include <string>

#include "WebView2.h"
#include "panel_host_ids.h"
#include "../remote-desktop-common/aidesk_product_name.h"
#include "../remote-desktop-common/platform_interfaces.h"

namespace ids = imcodes::aidesk_panel_host;
namespace common = imcodes::remote_desktop::common;

namespace {

constexpr UINT kActivateMessage = WM_APP + 1;
constexpr UINT_PTR kRetryTimer = 1;

std::wstring Widen(const char* text) {
  const int length = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
  if (length <= 1) return std::wstring();
  std::wstring out(static_cast<size_t>(length - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text, -1, out.data(), length);
  return out;
}

// The panel's origin plus the root path, e.g. "http://127.0.0.1:43751/": a URI is the panel's own when it starts with it (the slash
// ends the authority, so "http://127.0.0.1:43751@evil/" and "http://127.0.0.1:437510/" do not match).
const std::wstring& PanelPrefix() {
  static const std::wstring prefix = Widen(common::kLocalManagementUrl);
  return prefix;
}

bool IsPanelUri(const wchar_t* uri) {
  if (uri == nullptr) return false;
  const std::wstring& prefix = PanelPrefix();
  return prefix.size() > 0 && prefix.back() == L'/' && std::wstring(uri).compare(0, prefix.size(), prefix) == 0;
}

// Minimal COM event handler: a reference-counted object that forwards Invoke to a lambda.
template <typename Interface, typename... Args>
class Handler final : public Interface {
 public:
  explicit Handler(std::function<HRESULT(Args...)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
    if (object == nullptr) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(Interface))) {
      *object = static_cast<Interface*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --references_;
    if (remaining == 0) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return fn_(args...); }

 private:
  ~Handler() = default;
  std::function<HRESULT(Args...)> fn_;
  std::atomic<ULONG> references_{1};
};

// MakeHandler<Interface, Args...>(callable): the Interface and its Invoke argument types are given, the callable is deduced.
template <typename Interface, typename... Args, typename Callable>
Interface* MakeHandler(Callable fn) {
  return new Handler<Interface, Args...>(std::function<HRESULT(Args...)>(std::move(fn)));
}

struct HostState {
  HWND window = nullptr;
  ICoreWebView2Controller* controller = nullptr;
  ICoreWebView2* view = nullptr;
};
HostState g_host;

UINT DpiOf(HWND window) {
  using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
  static const auto get_dpi = reinterpret_cast<GetDpiForWindowFn>(
      reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow")));
  const UINT dpi = get_dpi != nullptr && window != nullptr ? get_dpi(window) : 0;
  return dpi != 0 ? dpi : 96;
}

// A client size in device-independent pixels -> the outer window size at this DPI (frame and title bar included).
SIZE OuterSize(HWND window, int client_width, int client_height, DWORD style, DWORD ex_style) {
  const UINT dpi = DpiOf(window);
  RECT rect = {0, 0, MulDiv(client_width, dpi, 96), MulDiv(client_height, dpi, 96)};
  using AdjustFn = BOOL(WINAPI*)(LPRECT, DWORD, BOOL, DWORD, UINT);
  static const auto adjust_for_dpi = reinterpret_cast<AdjustFn>(
      reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "AdjustWindowRectExForDpi")));
  if (adjust_for_dpi != nullptr) adjust_for_dpi(&rect, style, FALSE, ex_style, dpi);
  else AdjustWindowRectEx(&rect, style, FALSE, ex_style);
  return SIZE{rect.right - rect.left, rect.bottom - rect.top};
}

void ResizeView() {
  if (g_host.controller == nullptr || g_host.window == nullptr) return;
  RECT bounds;
  GetClientRect(g_host.window, &bounds);
  g_host.controller->put_Bounds(bounds);
}

void Navigate() {
  if (g_host.view != nullptr) g_host.view->Navigate(PanelPrefix().c_str());
}

// Bring the window to the front. Windows lets only the foreground process do that; the Alt key tap is the established way for a
// process that was started in the background to qualify, and the taskbar flash is the honest fallback when it still may not.
void Raise(HWND window) {
  if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
  else ShowWindow(window, SW_SHOW);
  keybd_event(VK_MENU, 0, 0, 0);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  if (!SetForegroundWindow(window)) {
    FLASHWINFO flash = {sizeof(flash), window, FLASHW_ALL | FLASHW_TIMERNOFG, 3, 0};
    FlashWindowEx(&flash);
  }
}

void ConfigureView(ICoreWebView2* view) {
  ICoreWebView2Settings* settings = nullptr;
  if (SUCCEEDED(view->get_Settings(&settings)) && settings != nullptr) {
    settings->put_AreDevToolsEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsWebMessageEnabled(FALSE);        // no script bridge from the page to this process
    settings->put_AreHostObjectsAllowed(FALSE);      // and no host objects
    settings->put_AreDefaultScriptDialogsEnabled(FALSE);
    settings->Release();
  }
  EventRegistrationToken token;
  // Only the panel's own origin may be shown.
  view->add_NavigationStarting(
      MakeHandler<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            const bool allowed = SUCCEEDED(args->get_Uri(&uri)) && IsPanelUri(uri);
            if (uri != nullptr) CoTaskMemFree(uri);
            if (!allowed) args->put_Cancel(TRUE);
            return S_OK;
          }),
      &token);
  // window.open / target=_blank never opens a window.
  view->add_NewWindowRequested(
      MakeHandler<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            args->put_Handled(TRUE);
            return S_OK;
          }),
      &token);
  // The node is not answering yet (a restart): try again every couple of seconds while the window is open.
  view->add_NavigationCompleted(
      MakeHandler<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
            BOOL success = TRUE;
            args->get_IsSuccess(&success);
            if (!success && g_host.window != nullptr) SetTimer(g_host.window, kRetryTimer, ids::kRetryMilliseconds, nullptr);
            return S_OK;
          }),
      &token);
  view->add_ProcessFailed(
      MakeHandler<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
            if (g_host.window != nullptr) SetTimer(g_host.window, kRetryTimer, ids::kRetryMilliseconds, nullptr);
            return S_OK;
          }),
      &token);
}

HRESULT OnControllerCreated(HRESULT result, ICoreWebView2Controller* controller) {
  if (FAILED(result) || controller == nullptr) {
    // Nothing to show: close, the node falls back to the browser window the next time.
    if (g_host.window != nullptr) PostMessageW(g_host.window, WM_CLOSE, 0, 0);
    return result;
  }
  g_host.controller = controller;
  controller->AddRef();
  controller->get_CoreWebView2(&g_host.view);
  if (g_host.view == nullptr) return E_FAIL;
  ConfigureView(g_host.view);
  ResizeView();
  Navigate();
  return S_OK;
}

HRESULT OnEnvironmentCreated(HRESULT result, ICoreWebView2Environment* environment) {
  if (FAILED(result) || environment == nullptr) {
    if (g_host.window != nullptr) PostMessageW(g_host.window, WM_CLOSE, 0, 0);
    return result;
  }
  return environment->CreateCoreWebView2Controller(
      g_host.window,
      MakeHandler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller*>(OnControllerCreated));
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_SIZE:
      ResizeView();
      return 0;
    case WM_GETMINMAXINFO: {
      auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
      const SIZE minimum = OuterSize(window, common::kLocalPanelWindowMinWidth, common::kLocalPanelWindowMinHeight,
                                     static_cast<DWORD>(GetWindowLongPtrW(window, GWL_STYLE)),
                                     static_cast<DWORD>(GetWindowLongPtrW(window, GWL_EXSTYLE)));
      info->ptMinTrackSize.x = minimum.cx;
      info->ptMinTrackSize.y = minimum.cy;
      return 0;
    }
    case WM_DPICHANGED: {
      const auto* suggested = reinterpret_cast<const RECT*>(lparam);
      SetWindowPos(window, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
                   suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_TIMER:
      if (wparam == kRetryTimer) {
        KillTimer(window, kRetryTimer);
        Navigate();
      }
      return 0;
    case kActivateMessage:
      Raise(window);
      return 0;
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, kRetryTimer);
      if (g_host.controller != nullptr) { g_host.controller->Close(); g_host.controller->Release(); g_host.controller = nullptr; }
      if (g_host.view != nullptr) { g_host.view->Release(); g_host.view = nullptr; }
      g_host.window = nullptr;
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

// The user data folder the web view keeps its profile in: per user, inside aiDesk's own directory, never the browser's.
std::wstring UserDataFolder() {
  PWSTR local = nullptr;
  std::wstring folder;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local)) && local != nullptr) {
    folder = std::wstring(local) + L"\\IM.codes";
    CreateDirectoryW(folder.c_str(), nullptr);
    folder += L"\\local-panel";
    CreateDirectoryW(folder.c_str(), nullptr);
    folder += L"\\webview2";
    CreateDirectoryW(folder.c_str(), nullptr);
  }
  if (local != nullptr) CoTaskMemFree(local);
  return folder;
}

// A second start: raise the window that exists (it is raised by its own process, which owns the foreground right it may have).
void ActivateRunningInstance() {
  HWND existing = FindWindowW(ids::kWindowClass, nullptr);
  if (existing == nullptr) return;
  DWORD owner = 0;
  GetWindowThreadProcessId(existing, &owner);
  if (owner != 0) AllowSetForegroundWindow(owner);
  PostMessageW(existing, kActivateMessage, 0, 0);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetCurrentProcessExplicitAppUserModelID(ids::kAppUserModelId);

  HANDLE single_instance = CreateMutexW(nullptr, FALSE, ids::kSingleInstanceMutex);
  if (single_instance != nullptr && GetLastError() == ERROR_ALREADY_EXISTS) {
    ActivateRunningInstance();
    CloseHandle(single_instance);
    return 0;
  }

  // No runtime, no window: exit at once with the code the node reads as "use the browser window".
  PWSTR runtime_version = nullptr;
  if (FAILED(GetAvailableCoreWebView2BrowserVersionString(nullptr, &runtime_version)) || runtime_version == nullptr) {
    return ids::kExitRuntimeMissing;
  }
  CoTaskMemFree(runtime_version);

  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;

  WNDCLASSEXW window_class = {};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = WindowProc;
  window_class.hInstance = instance;
  window_class.lpszClassName = ids::kWindowClass;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  window_class.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                                       GetSystemMetrics(SM_CYSMICON), 0));
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  if (RegisterClassExW(&window_class) == 0) return 1;

  const DWORD style = WS_OVERLAPPEDWINDOW;
  const std::wstring title = Widen(common::kAiDeskProductName);
  const SIZE size = OuterSize(nullptr, common::kLocalPanelWindowWidth, common::kLocalPanelWindowHeight, style, 0);
  g_host.window = CreateWindowExW(0, ids::kWindowClass, title.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT, size.cx, size.cy, nullptr,
                                  nullptr, instance, nullptr);
  if (g_host.window == nullptr) return 1;
  // The size above was computed at 96 DPI; now the window knows its monitor, give it the same client size at that DPI.
  const SIZE sized = OuterSize(g_host.window, common::kLocalPanelWindowWidth, common::kLocalPanelWindowHeight, style, 0);
  SetWindowPos(g_host.window, nullptr, 0, 0, sized.cx, sized.cy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  ShowWindow(g_host.window, SW_SHOW);
  UpdateWindow(g_host.window);
  Raise(g_host.window);

  const std::wstring user_data = UserDataFolder();
  const HRESULT started = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, user_data.empty() ? nullptr : user_data.c_str(), nullptr,
      MakeHandler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>(OnEnvironmentCreated));
  if (FAILED(started)) {
    DestroyWindow(g_host.window);
    return 1;
  }

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  if (single_instance != nullptr) CloseHandle(single_instance);
  CoUninitialize();
  return static_cast<int>(message.wParam);
}
