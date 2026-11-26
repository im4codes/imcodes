#ifndef IMCODES_AIDESK_UI_ACCESSIBILITY_BRIDGE_H_
#define IMCODES_AIDESK_UI_ACCESSIBILITY_BRIDGE_H_

#include <functional>
#include <memory>
#include <string>
#include <vector>

class Fl_Window;

namespace imcodes::aidesk::ui {

enum class AccessibleRole { kStatus, kText, kButton, kList, kListItem };

struct AccessibleItem {
  AccessibleRole role = AccessibleRole::kText;
  std::string identifier;
  std::string name;
  std::string value;
  bool enabled = true;
  std::function<void()> activate;
  int x = 0;
  int y = 0;
  int width = 1;
  int height = 1;
};

class AccessibilityBridge {
 public:
  virtual ~AccessibilityBridge() = default;
  virtual void Update(const std::vector<AccessibleItem>& items) = 0;
  virtual const char* Coverage() const = 0;
};

std::unique_ptr<AccessibilityBridge> CreateAccessibilityBridge(Fl_Window* window);

}  // namespace imcodes::aidesk::ui

#endif  // IMCODES_AIDESK_UI_ACCESSIBILITY_BRIDGE_H_
