#import <AppKit/AppKit.h>

#include "accessibility_bridge.h"

#include <FL/Fl_Window.H>
#include <FL/x.H>

@interface AiDeskAccessibilityElement : NSAccessibilityElement
@property(nonatomic, copy) dispatch_block_t onPress;
@end

@implementation AiDeskAccessibilityElement
- (BOOL)accessibilityPerformPress {
  if (self.onPress == nil || !self.accessibilityEnabled) return NO;
  self.onPress();
  return YES;
}
@end

namespace imcodes::aidesk::ui {
namespace {

NSString* Utf8(const std::string& value) {
  return [NSString stringWithUTF8String:value.c_str()];
}

NSString* Role(AccessibleRole role) {
  switch (role) {
    case AccessibleRole::kButton: return NSAccessibilityButtonRole;
    case AccessibleRole::kList: return NSAccessibilityListRole;
    case AccessibleRole::kListItem: return NSAccessibilityGroupRole;
    case AccessibleRole::kStatus: return NSAccessibilityStaticTextRole;
    case AccessibleRole::kText: return NSAccessibilityStaticTextRole;
  }
}

class MacAccessibilityBridge final : public AccessibilityBridge {
 public:
  explicit MacAccessibilityBridge(Fl_Window* window) : window_(window) {}
  void Update(const std::vector<AccessibleItem>& items) override {
    if (window_ == nullptr || !window_->shown()) return;
    NSWindow* native_window = (NSWindow*)fl_xid(window_);
    if (native_window == nil) return;
    NSMutableArray* children = [NSMutableArray arrayWithCapacity:items.size()];
    for (const auto& item : items) {
      NSView* content = native_window.contentView;
      const CGFloat content_height = content.bounds.size.height;
      const NSRect local = NSMakeRect(item.x,
          content_height - item.y - item.height, item.width, item.height);
      const NSRect screen = [native_window convertRectToScreen:
          [content convertRect:local toView:nil]];
      AiDeskAccessibilityElement* element = [AiDeskAccessibilityElement
          accessibilityElementWithRole:Role(item.role)
          frame:screen
          label:Utf8(item.name)
          parent:native_window.contentView];
      element.accessibilityIdentifier = Utf8(item.identifier);
      element.accessibilityValue = Utf8(item.value);
      element.accessibilityEnabled = item.enabled;
      if (item.activate) {
        const std::function<void()> activate = item.activate;
        element.onPress = ^{ activate(); };
      }
      [children addObject:element];
    }
    native_window.contentView.accessibilityChildren = children;
    NSAccessibilityPostNotification(native_window.contentView,
                                    NSAccessibilityLayoutChangedNotification);
  }
  const char* Coverage() const override {
    return "NSAccessibility semantic mirror: status, text, buttons and list rows";
  }
 private:
  Fl_Window* window_;
};

}  // namespace

std::unique_ptr<AccessibilityBridge> CreateAccessibilityBridge(Fl_Window* window) {
  return std::make_unique<MacAccessibilityBridge>(window);
}

}  // namespace imcodes::aidesk::ui
