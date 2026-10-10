#include "accessibility_bridge.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <commctrl.h>

#include <FL/Fl_Window.H>
#include <FL/x.H>

#include <memory>
#include <functional>
#include <vector>

namespace imcodes::aidesk::ui {
namespace {

std::wstring Wide(const std::string& value) {
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(), static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0) return {};
  std::wstring output(static_cast<std::size_t>(count), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), output.data(), count);
  return output;
}

class WindowsAccessibilityBridge final : public AccessibilityBridge {
 public:
  explicit WindowsAccessibilityBridge(Fl_Window* window) : window_(window) {
    if (window_ != nullptr && window_->shown()) {
      parent_ = fl_xid(window_);
      SetWindowSubclass(parent_, ParentSubclass, 1,
                        reinterpret_cast<DWORD_PTR>(this));
    }
  }
  ~WindowsAccessibilityBridge() override {
    Clear();
    if (parent_ != nullptr) RemoveWindowSubclass(parent_, ParentSubclass, 1);
  }
  void Update(const std::vector<AccessibleItem>& items) override {
    Clear();
    if (window_ == nullptr || !window_->shown()) return;
    const HWND parent = fl_xid(window_);
    if (parent_ == nullptr) {
      parent_ = parent;
      SetWindowSubclass(parent_, ParentSubclass, 1,
                        reinterpret_cast<DWORD_PTR>(this));
    }
    int index = 0;
    for (const auto& item : items) {
      const wchar_t* kind = item.role == AccessibleRole::kButton ? L"BUTTON" : L"STATIC";
      const std::wstring text = Wide(item.name + (item.value.empty() ? "" : ": " + item.value));
      // A one-pixel semantic mirror keeps FLTK as the only visible renderer,
      // while exposing actual HWND children to UIA/MSAA. Native button Invoke
      // events are forwarded to the same callbacks as their visible controls.
      const int control_id = 1000 + index++;
      const DWORD style = WS_CHILD | WS_VISIBLE |
          (item.role == AccessibleRole::kButton ? BS_PUSHBUTTON : SS_LEFT);
      HWND child = CreateWindowExW(WS_EX_TRANSPARENT | WS_EX_NOACTIVATE, kind,
          text.c_str(), style, -2, index, 1, 1, parent,
          reinterpret_cast<HMENU>(static_cast<INT_PTR>(control_id)),
          GetModuleHandleW(nullptr), nullptr);
      if (!item.enabled && child != nullptr) EnableWindow(child, FALSE);
      callbacks_.push_back(item.activate);
      if (child != nullptr) children_.push_back(child);
    }
    NotifyWinEvent(EVENT_OBJECT_REORDER, parent, OBJID_CLIENT, CHILDID_SELF);
  }
  const char* Coverage() const override {
    return "UIA/MSAA HWND semantic mirror with Invoke forwarding; FLTK controls remain keyboard reachable";
  }
 private:
  static LRESULT CALLBACK ParentSubclass(HWND hwnd, UINT message, WPARAM wparam,
                                          LPARAM lparam, UINT_PTR,
                                          DWORD_PTR reference) {
    auto* self = reinterpret_cast<WindowsAccessibilityBridge*>(reference);
    if (message == WM_COMMAND && HIWORD(wparam) == BN_CLICKED) {
      const int index = LOWORD(wparam) - 1000;
      if (index >= 0 && static_cast<std::size_t>(index) < self->callbacks_.size()) {
        const auto& callback = self->callbacks_[static_cast<std::size_t>(index)];
        if (callback) callback();
        return 0;
      }
    }
    return DefSubclassProc(hwnd, message, wparam, lparam);
  }
  void Clear() {
    for (HWND child : children_) DestroyWindow(child);
    children_.clear();
    callbacks_.clear();
  }
  Fl_Window* window_;
  HWND parent_ = nullptr;
  std::vector<HWND> children_;
  std::vector<std::function<void()>> callbacks_;
};

}  // namespace

std::unique_ptr<AccessibilityBridge> CreateAccessibilityBridge(Fl_Window* window) {
  return std::make_unique<WindowsAccessibilityBridge>(window);
}

}  // namespace imcodes::aidesk::ui
