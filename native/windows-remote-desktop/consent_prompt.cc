#include "third_party/imcodes_remote_desktop/consent_prompt.h"

#include <algorithm>
#include <cstring>

#include <windowsx.h>

#include "third_party/imcodes_remote_desktop/brand_logo_generated.h"

namespace imcodes::rd {
namespace {

constexpr wchar_t kWindowClass[] = L"IMCodesRemoteDesktopConsent";
constexpr wchar_t kWindowTitle[] = L"IM.codes Remote Desktop — permission";
constexpr wchar_t kProductName[] = L"IM.codes";
constexpr UINT kFinishMessage = WM_APP + 11;
// Logical (96-dpi) geometry; every literal is scaled before use.
constexpr int kWidth = 420;
constexpr int kHeight = 210;
constexpr int kLogoLogicalSize = 24;
constexpr int kTimerId = 1;

int Scaled(UINT dpi, int logical) {
  return MulDiv(logical, dpi > 0 ? static_cast<int>(dpi) : 96, 96);
}

UINT WindowDpi(HWND window) {
  const UINT dpi = window ? GetDpiForWindow(window) : 0;
  return dpi > 0 ? dpi : 96;
}

bool HighContrastActive() {
  HIGHCONTRASTW info{};
  info.cbSize = sizeof(info);
  if (!SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(info), &info, 0)) {
    return false;
  }
  return (info.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

/**
 * An interactive desktop must be attached AND be the one in front. The secure
 * desktop (UAC / credential provider / lock screen) is a different desktop
 * that ordinary processes cannot draw on: a prompt "shown" while it is in
 * front is invisible, and an invisible consent prompt that later times out is
 * indistinguishable to the operator from a request nobody ever made.
 */
bool InteractiveDesktopAvailable() {
  const HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return false;
  wchar_t name[256] = {};
  DWORD needed = 0;
  const bool named =
      GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &needed) != FALSE;
  CloseDesktop(desktop);
  if (!named) return false;
  // Winlogon / Screen-saver are the protected desktops we must refuse.
  return _wcsicmp(name, L"Default") == 0;
}

HFONT CreateUiFont(HWND window, int points, int weight) {
  const UINT dpi = WindowDpi(window);
  const int height = -MulDiv(points, static_cast<int>(dpi), 72);
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

const brand::LogoBitmap* SelectLogoBitmap(int wanted) {
  const brand::LogoBitmap* best = nullptr;
  for (int i = 0; i < brand::kLogoBitmapCount; ++i) {
    const brand::LogoBitmap& candidate = brand::kLogoBitmaps[i];
    if (candidate.size >= wanted && (!best || candidate.size < best->size)) {
      best = &candidate;
    }
  }
  if (best) return best;
  for (int i = 0; i < brand::kLogoBitmapCount; ++i) {
    if (!best || brand::kLogoBitmaps[i].size > best->size) {
      best = &brand::kLogoBitmaps[i];
    }
  }
  return best;
}

/** False on any compositing failure; the caller then draws text only. */
bool DrawBrandLogo(HDC dc, int x, int y, int edge) {
  const brand::LogoBitmap* bitmap = SelectLogoBitmap(edge);
  if (!bitmap || !bitmap->premultiplied_bgra || bitmap->size <= 0) return false;
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(info.bmiHeader);
  info.bmiHeader.biWidth = bitmap->size;
  info.bmiHeader.biHeight = -bitmap->size;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  const HDC memory = CreateCompatibleDC(dc);
  if (!memory) return false;
  const HBITMAP dib =
      CreateDIBSection(memory, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!dib || !pixels) {
    if (dib) DeleteObject(dib);
    DeleteDC(memory);
    return false;
  }
  memcpy(pixels, bitmap->premultiplied_bgra,
         static_cast<size_t>(bitmap->size) * bitmap->size * 4);
  const HGDIOBJ old = SelectObject(memory, dib);
  BLENDFUNCTION blend{};
  blend.BlendOp = AC_SRC_OVER;
  blend.SourceConstantAlpha = 255;
  blend.AlphaFormat = AC_SRC_ALPHA;
  const BOOL drawn = AlphaBlend(dc, x, y, edge, edge, memory, 0, 0,
                                bitmap->size, bitmap->size, blend);
  SelectObject(memory, old);
  DeleteObject(dib);
  DeleteDC(memory);
  return drawn != FALSE;
}

RECT AllowRect(const RECT& client, UINT dpi) {
  return RECT{client.right - Scaled(dpi, 200), client.bottom - Scaled(dpi, 56),
              client.right - Scaled(dpi, 108), client.bottom - Scaled(dpi, 18)};
}

RECT DenyRect(const RECT& client, UINT dpi) {
  return RECT{client.right - Scaled(dpi, 100), client.bottom - Scaled(dpi, 56),
              client.right - Scaled(dpi, 18), client.bottom - Scaled(dpi, 18)};
}

bool Contains(const RECT& rect, int x, int y) {
  const POINT point{x, y};
  return PtInRect(&rect, point) != FALSE;
}

}  // namespace

ConsentPrompt::ConsentPrompt() = default;
ConsentPrompt::~ConsentPrompt() { Cancel(); }

void ConsentPrompt::Finish(Outcome outcome) {
  // First terminal state wins. A late click must not overwrite a timeout the
  // daemon has already reported to the Server.
  if (finished_.exchange(true)) return;
  outcome_ = outcome;
  const HWND window = window_.load();
  if (window) PostMessageW(window, kFinishMessage, 0, 0);
}

void ConsentPrompt::Cancel() {
  cancellation_generation_.fetch_add(1);
  Finish(Outcome::kCancelled);
}

LRESULT CALLBACK ConsentPrompt::WindowProc(HWND window, UINT message,
                                           WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCCREATE) {
    auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  }
  auto* self = reinterpret_cast<ConsentPrompt*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (!self) return DefWindowProcW(window, message, wparam, lparam);
  return self->HandleMessage(window, message, wparam, lparam);
}

LRESULT ConsentPrompt::HandleMessage(HWND window, UINT message, WPARAM wparam,
                                     LPARAM lparam) {
  switch (message) {
    case WM_PAINT:
      PaintWindow(window);
      return 0;
    case WM_LBUTTONUP: {
      RECT client{};
      GetClientRect(window, &client);
      const UINT dpi = WindowDpi(window);
      const int x = GET_X_LPARAM(lparam);
      const int y = GET_Y_LPARAM(lparam);
      if (Contains(AllowRect(client, dpi), x, y)) Finish(Outcome::kAllowed);
      else if (Contains(DenyRect(client, dpi), x, y)) Finish(Outcome::kDenied);
      return 0;
    }
    case WM_KEYDOWN:
      // Escape denies rather than dismisses: closing the question without an
      // answer must never leave the requester waiting on nothing.
      if (wparam == VK_ESCAPE) Finish(Outcome::kDenied);
      return 0;
    case WM_TIMER:
      if (wparam == kTimerId) Finish(Outcome::kTimedOut);
      return 0;
    case WM_CLOSE:
      Finish(Outcome::kDenied);
      return 0;
    case kFinishMessage:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void ConsentPrompt::PaintWindow(HWND window) {
  PAINTSTRUCT paint{};
  const HDC dc = BeginPaint(window, &paint);
  RECT client{};
  GetClientRect(window, &client);
  const UINT dpi = WindowDpi(window);
  const bool high_contrast = HighContrastActive();
  const COLORREF surface = high_contrast ? GetSysColor(COLOR_WINDOW) : RGB(5, 16, 29);
  const COLORREF text = high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(227, 247, 255);
  const COLORREF muted = high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(137, 177, 205);
  const COLORREF border = high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(50, 196, 255);
  SetBkMode(dc, TRANSPARENT);
  DrawRoundedFill(dc, client, Scaled(dpi, 16), surface, border);

  const int logo_edge = Scaled(dpi, kLogoLogicalSize);
  const int logo_x = Scaled(dpi, 20);
  const int logo_y = Scaled(dpi, 18);
  if (!DrawBrandLogo(dc, logo_x, logo_y, logo_edge)) {
    // Image failure must not move the text or drop the attribution.
    const HBRUSH mark = CreateSolidBrush(border);
    const HGDIOBJ old = SelectObject(dc, mark);
    Ellipse(dc, logo_x, logo_y, logo_x + logo_edge, logo_y + logo_edge);
    SelectObject(dc, old);
    DeleteObject(mark);
  }

  const HFONT title_font = CreateUiFont(window, 12, FW_SEMIBOLD);
  const HFONT body_font = CreateUiFont(window, 10, FW_NORMAL);
  const HFONT button_font = CreateUiFont(window, 10, FW_SEMIBOLD);
  const HGDIOBJ old_font = SelectObject(dc, title_font);
  SetTextColor(dc, text);
  RECT title{logo_x + logo_edge + Scaled(dpi, 12), Scaled(dpi, 16),
             client.right - Scaled(dpi, 18), Scaled(dpi, 46)};
  DrawTextW(dc, kProductName, -1, &title,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);

  SelectObject(dc, body_font);
  SetTextColor(dc, text);
  // Mode is daemon-chosen, never requester-chosen, and stated in plain words:
  // control and view are materially different grants.
  const std::wstring ask = control_mode_
      ? std::wstring(L"Allow remote CONTROL of this computer?")
      : std::wstring(L"Allow someone to VIEW this computer's screen?");
  RECT ask_rect{Scaled(dpi, 20), Scaled(dpi, 52),
                client.right - Scaled(dpi, 18), Scaled(dpi, 82)};
  DrawTextW(dc, ask.c_str(), -1, &ask_rect,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);

  SetTextColor(dc, muted);
  // Untrusted. Length-bounded by the contract, drawn on its own line as inert
  // text with DT_NOPREFIX so it cannot forge an accelerator or extra chrome,
  // and DT_END_ELLIPSIS so it cannot push the buttons off the window.
  const std::wstring who = L"Requested by: " + requester_label_;
  RECT who_rect{Scaled(dpi, 20), Scaled(dpi, 86),
                client.right - Scaled(dpi, 18), Scaled(dpi, 112)};
  DrawTextW(dc, who.c_str(), -1, &who_rect,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);

  RECT hint{Scaled(dpi, 20), Scaled(dpi, 114),
            client.right - Scaled(dpi, 18), Scaled(dpi, 140)};
  DrawTextW(dc, L"No answer denies the request.", -1, &hint,
            DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);

  const RECT allow = AllowRect(client, dpi);
  DrawRoundedFill(dc, allow, Scaled(dpi, 10),
                  high_contrast ? surface : RGB(15, 74, 54),
                  high_contrast ? border : RGB(56, 230, 151));
  const RECT deny = DenyRect(client, dpi);
  DrawRoundedFill(dc, deny, Scaled(dpi, 10),
                  high_contrast ? surface : RGB(116, 29, 49),
                  high_contrast ? border : RGB(244, 80, 112));
  SelectObject(dc, button_font);
  SetTextColor(dc, text);
  RECT allow_text = allow;
  DrawTextW(dc, L"Allow", -1, &allow_text,
            DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);
  RECT deny_text = deny;
  DrawTextW(dc, L"Deny", -1, &deny_text,
            DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX);

  SelectObject(dc, old_font);
  DeleteObject(title_font);
  DeleteObject(body_font);
  DeleteObject(button_font);
  EndPaint(window, &paint);
}

ConsentPrompt::Outcome ConsentPrompt::Ask(const std::wstring& requester_label,
                                          bool control_mode,
                                          uint32_t deadline_ms,
                                          uint64_t cancellation_generation) {
  if (!InteractiveDesktopAvailable()) return Outcome::kUnavailable;
  if (deadline_ms == 0) return Outcome::kTimedOut;
  requester_label_ = requester_label;
  control_mode_ = control_mode;
  finished_.store(false);
  outcome_ = Outcome::kCancelled;
  // Dismiss can race the scheduling of this dedicated UI thread. It is bound
  // to the request generation captured by the dispatcher, so an early cancel
  // remains terminal instead of being erased by the reset above.
  if (cancellation_generation_.load() != cancellation_generation) {
    finished_.store(true);
    return Outcome::kCancelled;
  }

  const HINSTANCE instance = GetModuleHandleW(nullptr);
  WNDCLASSW window_class{};
  window_class.lpfnWndProc = &ConsentPrompt::WindowProc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.lpszClassName = kWindowClass;
  RegisterClassW(&window_class);

  // WS_EX_TOPMOST but NOT WS_EX_TOOLWINDOW: unlike the indicator this window
  // is a question, so it belongs in the taskbar/alt-tab where a user who
  // clicked away can find it again.
  const HWND window = CreateWindowExW(
      WS_EX_TOPMOST, kWindowClass, kWindowTitle, WS_POPUP, 0, 0,
      kWidth, kHeight, nullptr, nullptr, instance, this);
  if (!window) return Outcome::kUnavailable;
  window_.store(window);
  // Cover the smaller race between the pre-create check and publishing HWND.
  if (cancellation_generation_.load() != cancellation_generation) {
    Finish(Outcome::kCancelled);
  }

  const UINT dpi = WindowDpi(window);
  const int width = Scaled(dpi, kWidth);
  const int height = Scaled(dpi, kHeight);
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  const HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTOPRIMARY);
  int x = 0;
  int y = 0;
  if (GetMonitorInfoW(monitor, &info)) {
    x = (info.rcWork.left + info.rcWork.right - width) / 2;
    // Upper third, not centre: the Stop indicator lives in the bottom-right
    // corner and has to stay reachable while the question is on screen.
    y = info.rcWork.top + (info.rcWork.bottom - info.rcWork.top - height) / 3;
  }
  SetWindowPos(window, HWND_TOPMOST, x, y, width, height, SWP_SHOWWINDOW);
  SetWindowRgn(window, CreateRoundRectRgn(0, 0, width + 1, height + 1,
                                          Scaled(dpi, 16), Scaled(dpi, 16)),
               TRUE);
  SetTimer(window, kTimerId, deadline_ms, nullptr);

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  KillTimer(window, kTimerId);
  window_.store(nullptr);
  return outcome_;
}

}  // namespace imcodes::rd
