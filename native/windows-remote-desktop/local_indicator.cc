#include "third_party/imcodes_remote_desktop/local_indicator.h"

#include <algorithm>
#include <string>

#include <wtsapi32.h>

namespace imcodes::rd {
namespace {

constexpr wchar_t kWindowClass[] = L"IMCodesRemoteDesktopIndicator";
constexpr wchar_t kWindowTitle[] = L"IM.codes Remote Desktop";
constexpr UINT kUpdateMessage = WM_APP + 1;
constexpr UINT kStopMessage = WM_APP + 2;
constexpr int kStopButtonId = 1001;

}  // namespace

LocalIndicator::LocalIndicator() = default;
LocalIndicator::~LocalIndicator() { Stop(); }

bool LocalIndicator::Start(StopAll stop_all,
                           EnvironmentChanged environment_changed) {
  if (thread_.joinable()) return start_ok_;
  stop_all_ = std::move(stop_all);
  environment_changed_ = std::move(environment_changed);
  stopping_ = false;
  stop_requested_ = false;
  {
    std::lock_guard lock(start_mutex_);
    start_complete_ = false;
    start_ok_ = false;
  }
  thread_ = std::thread(&LocalIndicator::ThreadMain, this);
  std::unique_lock lock(start_mutex_);
  start_cv_.wait(lock, [this] { return start_complete_; });
  return start_ok_;
}

void LocalIndicator::Update(int viewers, int controllers) {
  viewers_ = std::max(0, viewers);
  controllers_ = std::max(0, controllers);
  HWND window = window_.load();
  // Visibility is a privacy boundary: the signaling thread must not return
  // from this call (and start DXGI capture) until the interactive-session
  // indicator has applied the new state.
  if (window) SendMessageW(window, kUpdateMessage, 0, 0);
}

void LocalIndicator::Stop() {
  if (!thread_.joinable()) return;
  stopping_ = true;
  HWND window = window_.load();
  if (window) PostMessageW(window, kStopMessage, 0, 0);
  thread_.join();
  window_ = nullptr;
  label_ = nullptr;
  button_ = nullptr;
}

LRESULT CALLBACK LocalIndicator::WindowProc(HWND window, UINT message,
                                             WPARAM wparam, LPARAM lparam) {
  LocalIndicator* self = reinterpret_cast<LocalIndicator*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    self = static_cast<LocalIndicator*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(self));
  }
  return self ? self->HandleMessage(window, message, wparam, lparam)
              : DefWindowProcW(window, message, wparam, lparam);
}

LRESULT LocalIndicator::HandleMessage(HWND window, UINT message,
                                       WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_COMMAND:
      if (LOWORD(wparam) == kStopButtonId) {
        RequestStopAll();
        return 0;
      }
      break;
    case WM_CLOSE:
      RequestStopAll();
      return 0;
    case WM_DISPLAYCHANGE:
      if (environment_changed_)
        environment_changed_(kEnvironmentDisplayChanged);
      return 0;
    case WM_POWERBROADCAST:
      if (environment_changed_) {
        if (wparam == PBT_APMSUSPEND)
          environment_changed_(kEnvironmentSuspend);
        else if (wparam == PBT_APMRESUMEAUTOMATIC ||
                 wparam == PBT_APMRESUMESUSPEND ||
                 wparam == PBT_APMRESUMECRITICAL)
          environment_changed_(kEnvironmentResume);
      }
      return TRUE;
    case WM_WTSSESSION_CHANGE:
      if (environment_changed_) {
        if (wparam == WTS_SESSION_LOCK || wparam == WTS_SESSION_LOGOFF ||
            wparam == WTS_CONSOLE_DISCONNECT ||
            wparam == WTS_REMOTE_DISCONNECT) {
          environment_changed_(kEnvironmentSessionUnavailable);
        } else if (wparam == WTS_SESSION_UNLOCK ||
                   wparam == WTS_SESSION_LOGON ||
                   wparam == WTS_CONSOLE_CONNECT ||
                   wparam == WTS_REMOTE_CONNECT) {
          environment_changed_(kEnvironmentSessionAvailable);
        }
      }
      return 0;
    case kUpdateMessage:
      RefreshWindow();
      return 0;
    case kStopMessage:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      WTSUnRegisterSessionNotification(window);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void LocalIndicator::ThreadMain() {
  HINSTANCE instance = GetModuleHandleW(nullptr);
  WNDCLASSW window_class{};
  window_class.lpfnWndProc = &LocalIndicator::WindowProc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  window_class.lpszClassName = kWindowClass;
  RegisterClassW(&window_class);

  const int width = 390;
  const int height = 128;
  RECT work_area{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work_area, 0);
  const int x = std::max(work_area.left, work_area.right - width - 16);
  const int y = std::max(work_area.top, work_area.bottom - height - 16);
  HWND window = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW, kWindowClass, kWindowTitle,
      WS_CAPTION | WS_SYSMENU, x, y, width, height, nullptr, nullptr,
      instance, this);
  window_ = window;
  if (window) {
    if (!WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)) {
      DestroyWindow(window);
      window = nullptr;
      window_ = nullptr;
    }
  }
  if (window) {
    label_ = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_VISIBLE,
                             16, 14, 350, 38, window, nullptr, instance,
                             nullptr);
    button_ = CreateWindowExW(
        0, L"BUTTON", L"Stop all remote desktop sessions",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
        16, 58, 350, 30, window,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kStopButtonId)),
        instance, nullptr);
    RefreshWindow();
  }
  {
    std::lock_guard lock(start_mutex_);
    start_ok_ = window && label_ && button_;
    start_complete_ = true;
  }
  start_cv_.notify_all();
  if (!start_ok_) {
    if (window) DestroyWindow(window);
    window_ = nullptr;
    return;
  }

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  window_ = nullptr;
}

void LocalIndicator::RefreshWindow() {
  HWND window = window_.load();
  if (!window || !label_) return;
  const int viewers = viewers_.load();
  const int controllers = controllers_.load();
  const std::wstring text = L"Remote desktop active — " +
      std::to_wstring(viewers) + L" viewing, " +
      std::to_wstring(controllers) + L" controlling";
  SetWindowTextW(label_, text.c_str());
  if (viewers > 0) {
    ShowWindow(window, SW_SHOWNOACTIVATE);
    SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } else {
    stop_requested_ = false;
    if (button_) EnableWindow(button_, TRUE);
    ShowWindow(window, SW_HIDE);
  }
}

void LocalIndicator::RequestStopAll() {
  if (stopping_ || stop_requested_.exchange(true)) return;
  if (button_) EnableWindow(button_, FALSE);
  if (label_) SetWindowTextW(label_, L"Stopping all remote desktop sessions…");
  if (stop_all_) stop_all_();
}

}  // namespace imcodes::rd
