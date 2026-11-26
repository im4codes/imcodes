#include "accessibility_bridge.h"

#include <FL/Fl_Window.H>

namespace imcodes::aidesk::ui {
namespace {

class LinuxAccessibilityBridge final : public AccessibilityBridge {
 public:
  explicit LinuxAccessibilityBridge(Fl_Window*) {}
  void Update(const std::vector<AccessibleItem>& items) override { items_ = items; }
  const char* Coverage() const override {
    // FLTK does not publish an AT-SPI child tree. The retained semantic model
    // is intentionally explicit so a future AT-SPI adapter can publish it
    // without moving any business or translation logic out of the shared UI.
    return "AT-SPI child publishing unavailable in FLTK; keyboard and text/color redundancy only";
  }
 private:
  std::vector<AccessibleItem> items_;
};

}  // namespace

std::unique_ptr<AccessibilityBridge> CreateAccessibilityBridge(Fl_Window* window) {
  return std::make_unique<LinuxAccessibilityBridge>(window);
}

}  // namespace imcodes::aidesk::ui
