#include "third_party/imcodes_remote_desktop/local_indicator.h"

#include <algorithm>
#include <string>

#include <windowsx.h>
#include <dwmapi.h>
#include <wtsapi32.h>

namespace imcodes::rd {
namespace {

constexpr wchar_t kWindowClass[] = L"IMCodesRemoteDesktopIndicator";
constexpr wchar_t kWindowTitle[] = L"IM.codes Remote Desktop";
constexpr wchar_t kRegistryPath[] = L"Software\\IM.codes\\RemoteDesktop";
constexpr wchar_t kCollapsedValue[] = L"IndicatorCollapsed";
constexpr UINT kUpdateMessage = WM_APP + 1;
constexpr UINT kStopMessage = WM_APP + 2;
constexpr UINT kDispatchInputMessage = WM_APP + 3;
constexpr UINT kProbeInputMessage = WM_APP + 4;
constexpr UINT kReadClipboardMessage = WM_APP + 5;
constexpr UINT kMovePointerMessage = WM_APP + 6;
constexpr int kExpandedWidth = 368;
constexpr int kExpandedHeight = 148;
constexpr int kCollapsedSize = 38;
constexpr int kCornerMargin = 14;

struct InputDispatchRequest {
  UINT count = 0;
  LPINPUT inputs = nullptr;
  int size = 0;
  UINT accepted = 0;
  DWORD error = ERROR_SUCCESS;
};

struct ClipboardReadRequest {
  DWORD previous_sequence = 0;
  std::u16string text;
  bool available = false;
};

struct PointerMoveRequest {
  int x = 0;
  int y = 0;
  bool accepted = false;
  DWORD error = ERROR_SUCCESS;
};

bool ReadCollapsedPreference() {
  DWORD value = 0;
  DWORD size = sizeof(value);
  const LONG result = RegGetValueW(HKEY_CURRENT_USER, kRegistryPath,
                                   kCollapsedValue, RRF_RT_REG_DWORD, nullptr,
                                   &value, &size);
  return result == ERROR_SUCCESS && value != 0;
}

void WriteCollapsedPreference(bool collapsed) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, kRegistryPath, 0, nullptr, 0,
                      KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  const DWORD value = collapsed ? 1 : 0;
  RegSetValueExW(key, kCollapsedValue, 0, REG_DWORD,
                 reinterpret_cast<const BYTE*>(&value), sizeof(value));
  RegCloseKey(key);
}

RECT CollapseRect(const RECT& client) {
  return RECT{client.right - 42, 8, client.right - 8, 40};
}

RECT StopRect(const RECT& client) {
  return RECT{16, client.bottom - 50, client.right - 16,
              client.bottom - 14};
}

bool Contains(const RECT& rect, int x, int y) {
  const POINT point{x, y};
  return PtInRect(&rect, point) != FALSE;
}

HMONITOR ActiveMonitor() {
  if (const HWND foreground = GetForegroundWindow()) {
    if (const HMONITOR monitor =
            MonitorFromWindow(foreground, MONITOR_DEFAULTTONULL)) {
      return monitor;
    }
  }
  POINT cursor{};
  if (GetCursorPos(&cursor))
    return MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
  return MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
}

HFONT CreateUiFont(HWND window, int points, int weight) {
  const UINT dpi = GetDpiForWindow(window);
  const int height = -MulDiv(points, dpi > 0 ? static_cast<int>(dpi) : 96, 72);
  return CreateFontW(height, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
                     L"Segoe UI Variable Text");
}

void DrawRoundedFill(HDC dc, const RECT& rect, int radius, COLORREF fill,
                     COLORREF border) {
  const HBRUSH brush = CreateSolidBrush(fill);
  const HPEN pen = CreatePen(PS_SOLID, 1, border);
  const HGDIOBJ old_brush = SelectObject(dc, brush);
  const HGDIOBJ old_pen = SelectObject(dc, pen);
  RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, radius, radius);
  SelectObject(dc, old_brush);
  SelectObject(dc, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
}

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
  const HWND window = window_.load();
  // Visibility is a privacy boundary: the signaling thread must not return
  // (and start DXGI capture) until the interactive indicator applied state.
  if (window) SendMessageW(window, kUpdateMessage, 0, 0);
}

UINT LocalIndicator::DispatchInput(UINT count, LPINPUT inputs, int size) {
  const HWND window = window_.load();
  if (!window || !inputs || count == 0 || size != sizeof(INPUT)) return 0;
  InputDispatchRequest request{count, inputs, size};
  SendMessageW(window, kDispatchInputMessage, 0,
               reinterpret_cast<LPARAM>(&request));
  SetLastError(request.error);
  return request.accepted;
}

bool LocalIndicator::MovePointer(int x, int y) {
  const HWND window = window_.load();
  if (!window) return false;
  PointerMoveRequest request{x, y};
  SendMessageW(window, kMovePointerMessage, 0,
               reinterpret_cast<LPARAM>(&request));
  SetLastError(request.error);
  return request.accepted;
}

bool LocalIndicator::InputAvailable() {
  const HWND window = window_.load();
  return window && SendMessageW(window, kProbeInputMessage, 0, 0) == TRUE;
}

DWORD LocalIndicator::ClipboardSequence() const {
  return GetClipboardSequenceNumber();
}

std::optional<std::u16string> LocalIndicator::ReadClipboardText(
    DWORD previous_sequence) {
  const HWND window = window_.load();
  if (!window) return std::nullopt;
  ClipboardReadRequest request;
  request.previous_sequence = previous_sequence;
  SendMessageW(window, kReadClipboardMessage, 0,
               reinterpret_cast<LPARAM>(&request));
  return request.available
             ? std::optional<std::u16string>(std::move(request.text))
             : std::nullopt;
}

void LocalIndicator::Stop() {
  if (!thread_.joinable()) return;
  stopping_ = true;
  const HWND window = window_.load();
  if (window) PostMessageW(window, kStopMessage, 0, 0);
  thread_.join();
  window_ = nullptr;
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
    case WM_PAINT:
      PaintWindow(window);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_LBUTTONUP: {
      if (collapsed_) {
        SetCollapsed(false, true);
        return 0;
      }
      RECT client{};
      GetClientRect(window, &client);
      const int x = GET_X_LPARAM(lparam);
      const int y = GET_Y_LPARAM(lparam);
      if (Contains(CollapseRect(client), x, y)) {
        SetCollapsed(true, true);
      } else if (Contains(StopRect(client), x, y)) {
        RequestStopAll();
      }
      return 0;
    }
    case WM_SETCURSOR: {
      POINT cursor{};
      GetCursorPos(&cursor);
      ScreenToClient(window, &cursor);
      RECT client{};
      GetClientRect(window, &client);
      if (collapsed_ || Contains(CollapseRect(client), cursor.x, cursor.y) ||
          Contains(StopRect(client), cursor.x, cursor.y)) {
        SetCursor(LoadCursorW(nullptr, IDC_HAND));
        return TRUE;
      }
      break;
    }
    case WM_CLOSE:
      RequestStopAll();
      return 0;
    case WM_DISPLAYCHANGE:
      AnchorToCorner(window);
      if (environment_changed_)
        environment_changed_(kEnvironmentDisplayChanged);
      return 0;
    case WM_DWMCOMPOSITIONCHANGED:
      // A DWM restart invalidates more than the output rectangle: active DXGI
      // duplication and encoder state may remain alive but never progress.
      // Force the bounded media reinitialization path instead of treating the
      // compositor restart as an ordinary topology refresh.
      AnchorToCorner(window);
      if (environment_changed_)
        environment_changed_(kEnvironmentCompositionChanged);
      return 0;
    case WM_SETTINGCHANGE:
    case WM_DPICHANGED:
      AnchorToCorner(window);
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
    case kDispatchInputMessage: {
      auto* request = reinterpret_cast<InputDispatchRequest*>(lparam);
      if (!request || !request->inputs || request->count == 0 ||
          request->size != sizeof(INPUT)) {
        return 0;
      }
      SetLastError(ERROR_SUCCESS);
      request->accepted =
          SendInput(request->count, request->inputs, request->size);
      request->error = GetLastError();
      return request->accepted;
    }
    case kProbeInputMessage: {
      POINT cursor{};
      return GetCursorPos(&cursor) && SetCursorPos(cursor.x, cursor.y);
    }
    case kMovePointerMessage: {
      auto* request = reinterpret_cast<PointerMoveRequest*>(lparam);
      if (!request) return FALSE;
      SetLastError(ERROR_SUCCESS);
      request->accepted = SetCursorPos(request->x, request->y) == TRUE;
      request->error = GetLastError();
      return request->accepted ? TRUE : FALSE;
    }
    case kReadClipboardMessage: {
      auto* request = reinterpret_cast<ClipboardReadRequest*>(lparam);
      if (!request || GetClipboardSequenceNumber() == 0 ||
          GetClipboardSequenceNumber() == request->previous_sequence ||
          !OpenClipboard(window)) {
        return 0;
      }
      const HANDLE data = GetClipboardData(CF_UNICODETEXT);
      const SIZE_T allocation_bytes = data ? GlobalSize(data) : 0;
      const auto* value = data
          ? static_cast<const wchar_t*>(GlobalLock(data))
          : nullptr;
      constexpr size_t kMaximumClipboardCodeUnits = 4096;
      size_t length = 0;
      if (value && allocation_bytes >= sizeof(wchar_t)) {
        const size_t allocation_units = allocation_bytes / sizeof(wchar_t);
        const size_t scan_limit = std::min(
            allocation_units, kMaximumClipboardCodeUnits + 1);
        while (length < scan_limit && value[length] != L'\0') ++length;
        if (length > 0 && length <= kMaximumClipboardCodeUnits &&
            length < allocation_units) {
          request->text.assign(
              reinterpret_cast<const char16_t*>(value), length);
          request->available = true;
        }
      }
      if (value) GlobalUnlock(data);
      CloseClipboard();
      return request->available ? TRUE : FALSE;
    }
    case kStopMessage:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      if (wts_registered_) WTSUnRegisterSessionNotification(window);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void LocalIndicator::ThreadMain() {
  const HINSTANCE instance = GetModuleHandleW(nullptr);
  WNDCLASSW window_class{};
  window_class.style = CS_HREDRAW | CS_VREDRAW;
  window_class.lpfnWndProc = &LocalIndicator::WindowProc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.lpszClassName = kWindowClass;
  RegisterClassW(&window_class);

  collapsed_ = ReadCollapsedPreference();
  const int width = collapsed_ ? kCollapsedSize : kExpandedWidth;
  const int height = collapsed_ ? kCollapsedSize : kExpandedHeight;
  const HWND window = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW, kWindowClass, kWindowTitle,
      WS_POPUP, 0, 0, width, height, nullptr, nullptr, instance, this);
  window_ = window;
  if (window) {
    // Session notifications improve response time, but their registration can
    // transiently fail during logon. The bounded desktop poll remains active,
    // so do not kill the media worker (the old source of 56ms worker_failed).
    wts_registered_ =
        WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) != FALSE;
    AnchorToCorner(window);
    RefreshWindow();
  }
  {
    std::lock_guard lock(start_mutex_);
    start_ok_ = window != nullptr;
    start_complete_ = true;
  }
  start_cv_.notify_all();
  if (!start_ok_) return;

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  window_ = nullptr;
}

void LocalIndicator::RefreshWindow() {
  const HWND window = window_.load();
  if (!window) return;
  if (viewers_.load() > 0) {
    AnchorToCorner(window);
    InvalidateRect(window, nullptr, FALSE);
    ShowWindow(window, SW_SHOWNOACTIVATE);
    SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } else {
    stop_requested_ = false;
    ShowWindow(window, SW_HIDE);
  }
}

void LocalIndicator::AnchorToCorner(HWND window) {
  if (!window) return;
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(ActiveMonitor(), &info)) return;
  const int width = collapsed_ ? kCollapsedSize : kExpandedWidth;
  const int height = collapsed_ ? kCollapsedSize : kExpandedHeight;
  const int x = std::max(info.rcWork.left,
                         info.rcWork.right - width - kCornerMargin);
  const int y = std::max(info.rcWork.top,
                         info.rcWork.bottom - height - kCornerMargin);
  SetWindowPos(window, HWND_TOPMOST, x, y, width, height,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);
  const int radius = collapsed_ ? 12 : 18;
  SetWindowRgn(window, CreateRoundRectRgn(0, 0, width + 1, height + 1,
                                          radius, radius), TRUE);
}

void LocalIndicator::SetCollapsed(bool collapsed, bool persist) {
  if (collapsed_ == collapsed) return;
  collapsed_ = collapsed;
  if (persist) WriteCollapsedPreference(collapsed);
  const HWND window = window_.load();
  if (!window) return;
  AnchorToCorner(window);
  InvalidateRect(window, nullptr, FALSE);
}

void LocalIndicator::PaintWindow(HWND window) {
  PAINTSTRUCT paint{};
  const HDC dc = BeginPaint(window, &paint);
  RECT client{};
  GetClientRect(window, &client);
  SetBkMode(dc, TRANSPARENT);
  DrawRoundedFill(dc, client, collapsed_ ? 12 : 18, RGB(5, 16, 29),
                  RGB(50, 196, 255));

  if (collapsed_) {
    const HBRUSH glow = CreateSolidBrush(RGB(84, 219, 255));
    const HGDIOBJ old = SelectObject(dc, glow);
    POINT triangle[] = {{13, 10}, {29, 19}, {13, 28}};
    Polygon(dc, triangle, 3);
    SelectObject(dc, old);
    DeleteObject(glow);
    EndPaint(window, &paint);
    return;
  }

  const HBRUSH live = CreateSolidBrush(RGB(56, 230, 151));
  const HGDIOBJ old_live = SelectObject(dc, live);
  Ellipse(dc, 18, 18, 28, 28);
  SelectObject(dc, old_live);
  DeleteObject(live);

  const HFONT title_font = CreateUiFont(window, 11, FW_SEMIBOLD);
  const HFONT detail_font = CreateUiFont(window, 9, FW_NORMAL);
  const HFONT button_font = CreateUiFont(window, 9, FW_SEMIBOLD);
  const HGDIOBJ old_font = SelectObject(dc, title_font);
  SetTextColor(dc, RGB(227, 247, 255));
  RECT title{36, 9, client.right - 50, 39};
  DrawTextW(dc, L"IM.CODES  //  REMOTE LINK", -1, &title,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  SelectObject(dc, detail_font);
  SetTextColor(dc, RGB(137, 177, 205));
  const std::wstring detail = std::to_wstring(viewers_.load()) +
      L" VIEWING  ·  " + std::to_wstring(controllers_.load()) +
      L" CONTROLLING";
  RECT detail_rect{18, 42, client.right - 18, 75};
  DrawTextW(dc, detail.c_str(), -1, &detail_rect,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);

  const RECT collapse = CollapseRect(client);
  DrawRoundedFill(dc, collapse, 10, RGB(10, 35, 55), RGB(43, 111, 149));
  const HBRUSH arrow = CreateSolidBrush(RGB(119, 213, 255));
  const HGDIOBJ old_arrow = SelectObject(dc, arrow);
  const int cx = (collapse.left + collapse.right) / 2;
  const int cy = (collapse.top + collapse.bottom) / 2;
  POINT fold[] = {{cx - 7, cy - 4}, {cx + 7, cy - 4}, {cx, cy + 5}};
  Polygon(dc, fold, 3);
  SelectObject(dc, old_arrow);
  DeleteObject(arrow);

  const RECT stop = StopRect(client);
  const bool stopping = stop_requested_.load();
  DrawRoundedFill(dc, stop, 12,
                  stopping ? RGB(52, 63, 74) : RGB(116, 29, 49),
                  stopping ? RGB(88, 103, 117) : RGB(244, 80, 112));
  SelectObject(dc, button_font);
  SetTextColor(dc, stopping ? RGB(165, 179, 190) : RGB(255, 236, 241));
  RECT stop_text = stop;
  DrawTextW(dc, stopping ? L"STOPPING…" : L"STOP ALL REMOTE SESSIONS", -1,
            &stop_text, DT_SINGLELINE | DT_CENTER | DT_VCENTER);

  SelectObject(dc, old_font);
  DeleteObject(title_font);
  DeleteObject(detail_font);
  DeleteObject(button_font);
  EndPaint(window, &paint);
}

void LocalIndicator::RequestStopAll() {
  if (stopping_ || stop_requested_.exchange(true)) return;
  const HWND window = window_.load();
  if (window) InvalidateRect(window, nullptr, FALSE);
  if (stop_all_) stop_all_();
}

}  // namespace imcodes::rd
