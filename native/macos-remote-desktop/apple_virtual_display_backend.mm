#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "macos_virtual_display_adapter.h"

namespace imcodes::remote_desktop::macos {
namespace {

using InitMessage = id (*)(id, SEL);
using InitDescriptorMessage = id (*)(id, SEL, id);
using InitModeMessage = id (*)(id, SEL, unsigned int, unsigned int, double);
using SetUnsignedMessage = void (*)(id, SEL, unsigned int);
using SetObjectMessage = void (*)(id, SEL, id);
using SetSizeMessage = void (*)(id, SEL, CGSize);
using SetPointMessage = void (*)(id, SEL, CGPoint);
using ApplySettingsMessage = BOOL (*)(id, SEL, id);
using DisplayIdMessage = unsigned int (*)(id, SEL);
extern "C" id objc_retain(id value);
extern "C" void objc_release(id value);

id AllocateAndInitialize(Class cls) {
  if (cls == Nil)
    return nil;
  // Calling objc_msgSend through a function pointer bypasses ARC's method-
  // family ownership inference. Treat the +1 init result as transferred into
  // ARC explicitly; otherwise every dynamic alloc/init leaks one retain and a
  // CGVirtualDisplay can survive ReleaseVirtualDisplay until logout.
  __unsafe_unretained id allocated = reinterpret_cast<InitMessage>(
      objc_msgSend)(cls, sel_registerName("alloc"));
  if (allocated == nil)
    return nil;
  __unsafe_unretained id initialized = reinterpret_cast<InitMessage>(
      objc_msgSend)(allocated, sel_registerName("init"));
  return initialized == nil ? nil
                            : (__bridge_transfer id)(__bridge void*)initialized;
}

void* RetainOpaque(id value) {
  return value == nil ? nullptr : (__bridge void*)objc_retain(value);
}

bool HasInstanceMethod(Class cls, const char* selector) {
  return cls != Nil &&
         class_getInstanceMethod(cls, sel_registerName(selector)) != nullptr;
}

class AppleMacosVirtualDisplayBackend final
    : public MacosVirtualDisplayBackend {
 public:
  ~AppleMacosVirtualDisplayBackend() override { Destroy(); }

  common::ReadinessState ProbeSupport() noexcept override {
    @autoreleasepool {
      display_class_ = NSClassFromString(@"CGVirtualDisplay");
      descriptor_class_ = NSClassFromString(@"CGVirtualDisplayDescriptor");
      mode_class_ = NSClassFromString(@"CGVirtualDisplayMode");
      settings_class_ = NSClassFromString(@"CGVirtualDisplaySettings");
      const bool ready =
          display_class_ != Nil && descriptor_class_ != Nil &&
          mode_class_ != Nil && settings_class_ != Nil &&
          HasInstanceMethod(display_class_, "initWithDescriptor:") &&
          HasInstanceMethod(display_class_, "applySettings:") &&
          HasInstanceMethod(display_class_, "displayID") &&
          HasInstanceMethod(descriptor_class_, "setDispatchQueue:") &&
          HasInstanceMethod(descriptor_class_, "setName:") &&
          HasInstanceMethod(descriptor_class_, "setVendorID:") &&
          HasInstanceMethod(descriptor_class_, "setProductID:") &&
          (HasInstanceMethod(descriptor_class_, "setSerialNum:") ||
           HasInstanceMethod(descriptor_class_, "setSerialNumber:")) &&
          HasInstanceMethod(descriptor_class_, "setMaxPixelsWide:") &&
          HasInstanceMethod(descriptor_class_, "setMaxPixelsHigh:") &&
          HasInstanceMethod(descriptor_class_, "setSizeInMillimeters:") &&
          HasInstanceMethod(mode_class_, "initWithWidth:height:refreshRate:") &&
          HasInstanceMethod(settings_class_, "setModes:") &&
          HasInstanceMethod(settings_class_, "setHiDPI:") &&
          HasInstanceMethod(settings_class_, "setRotation:");
      return ready ? common::ReadinessState::kReady
                   : common::ReadinessState::kUnavailable;
    }
  }

  bool Create(const MacosVirtualDisplayConfiguration& configuration,
              std::uint32_t* native_display_id,
              std::string* error) override {
    if (native_display_id == nullptr || error == nullptr ||
        !configuration.IsValid()) {
      return false;
    }
    *native_display_id = 0;
    if (ProbeSupport() != common::ReadinessState::kReady) {
      *error = "CGVirtualDisplay classes or selectors are unavailable";
      return false;
    }
    Destroy();
    @autoreleasepool {
      id descriptor = AllocateAndInitialize(descriptor_class_);
      descriptor_ = RetainOpaque(descriptor);
      if (descriptor_ == nullptr) {
        *error = "CGVirtualDisplayDescriptor allocation failed";
        return false;
      }
      descriptor = (__bridge id)descriptor_;
      const auto max_width =
          std::max_element(configuration.modes.begin(),
                           configuration.modes.end(),
                           [](const auto& left, const auto& right) {
                             return left.pixels.width < right.pixels.width;
                           })
              ->pixels.width;
      const auto max_height =
          std::max_element(configuration.modes.begin(),
                           configuration.modes.end(),
                           [](const auto& left, const auto& right) {
                             return left.pixels.height < right.pixels.height;
                           })
              ->pixels.height;
      SetObject(descriptor, "setDispatchQueue:", dispatch_get_main_queue());
      SetObject(descriptor, "setName:",
                [NSString stringWithUTF8String:configuration.name.c_str()]);
      SetUnsigned(descriptor, "setVendorID:", configuration.vendor_id);
      SetUnsigned(descriptor, "setProductID:", configuration.product_id);
      if (HasInstanceMethod(descriptor_class_, "setSerialNum:")) {
        SetUnsigned(descriptor, "setSerialNum:", configuration.serial_number);
      }
      if (HasInstanceMethod(descriptor_class_, "setSerialNumber:")) {
        SetUnsigned(descriptor,
                    "setSerialNumber:", configuration.serial_number);
      }
      SetUnsigned(descriptor, "setMaxPixelsWide:", max_width);
      SetUnsigned(descriptor, "setMaxPixelsHigh:", max_height);
      reinterpret_cast<SetSizeMessage>(objc_msgSend)(
          descriptor, sel_registerName("setSizeInMillimeters:"),
          CGSizeMake(600.0, 340.0));
      SetChromaticity(descriptor);

      __unsafe_unretained id allocated = reinterpret_cast<InitMessage>(
          objc_msgSend)(display_class_, sel_registerName("alloc"));
      __unsafe_unretained id initialized =
          allocated == nil
              ? nil
              : reinterpret_cast<InitDescriptorMessage>(objc_msgSend)(
                    allocated, sel_registerName("initWithDescriptor:"),
                    descriptor);
      // Keep the +1 init result as an opaque manual retain. ARC cannot infer
      // the ownership family through this objc_msgSend function pointer, and
      // storing it as a strong id produced a leaked retain on current macOS.
      display_ = initialized == nil ? nullptr : (__bridge void*)initialized;
      if (display_ == nullptr) {
        *error = "CGVirtualDisplay creation failed";
        Destroy();
        return false;
      }
      const std::uint32_t display_id = reinterpret_cast<DisplayIdMessage>(
          objc_msgSend)((__bridge id)display_, sel_registerName("displayID"));
      if (display_id == 0 ||
          !Apply(configuration.modes.front(), configuration.modes, error)) {
        Destroy();
        if (error->empty())
          *error = "CGVirtualDisplay returned an invalid display id";
        return false;
      }
      display_id_ = display_id;
      *native_display_id = display_id;
      error->clear();
      return true;
    }
  }

  bool ApplyMode(std::uint32_t native_display_id,
                 const MacosVirtualDisplayMode& mode,
                 const std::vector<MacosVirtualDisplayMode>& modes,
                 std::string* error) override {
    if (error == nullptr || display_ == nullptr || native_display_id == 0 ||
        native_display_id != display_id_ || !mode.IsValid()) {
      return false;
    }
    return Apply(mode, modes, error);
  }

  bool WaitUntilOnline(std::uint32_t native_display_id,
                       std::uint32_t timeout_ms,
                       std::string* error) override {
    if (native_display_id == 0 || timeout_ms == 0 || error == nullptr)
      return false;
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
      CGDirectDisplayID displays[32] = {};
      std::uint32_t count = 0;
      if (CGGetOnlineDisplayList(32, displays, &count) == kCGErrorSuccess &&
          std::find(displays, displays + count, native_display_id) !=
              displays + count) {
        error->clear();
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    *error = "CGVirtualDisplay did not become online before deadline";
    return false;
  }

  void Destroy() noexcept override {
    // CGVirtualDisplay keeps non-owning references to both its descriptor and
    // last-applied settings on current macOS releases. Keep all three objects
    // alive together, then mirror the teardown order used by mature virtual-
    // display implementations. Releasing only the display leaves a WindowServer
    // display behind after the owner process exits.
    if (descriptor_ != nullptr) {
      objc_release((__bridge id)descriptor_);
      descriptor_ = nullptr;
    }
    if (settings_ != nullptr) {
      objc_release((__bridge id)settings_);
      settings_ = nullptr;
    }
    if (display_ != nullptr) {
      objc_release((__bridge id)display_);
      display_ = nullptr;
    }
    display_id_ = 0;
  }

 private:
  static void SetUnsigned(id object,
                          const char* selector,
                          std::uint32_t value) {
    reinterpret_cast<SetUnsignedMessage>(objc_msgSend)(
        object, sel_registerName(selector), value);
  }

  static void SetObject(id object, const char* selector, id value) {
    reinterpret_cast<SetObjectMessage>(objc_msgSend)(
        object, sel_registerName(selector), value);
  }

  static void SetChromaticity(id descriptor) {
    if (HasInstanceMethod(object_getClass(descriptor), "setWhitePoint:")) {
      reinterpret_cast<SetPointMessage>(objc_msgSend)(
          descriptor, sel_registerName("setWhitePoint:"),
          CGPointMake(0.3125, 0.3291));
    }
    if (HasInstanceMethod(object_getClass(descriptor), "setRedPrimary:")) {
      reinterpret_cast<SetPointMessage>(objc_msgSend)(
          descriptor, sel_registerName("setRedPrimary:"),
          CGPointMake(0.6797, 0.3203));
    }
    if (HasInstanceMethod(object_getClass(descriptor), "setGreenPrimary:")) {
      reinterpret_cast<SetPointMessage>(objc_msgSend)(
          descriptor, sel_registerName("setGreenPrimary:"),
          CGPointMake(0.2559, 0.6983));
    }
    if (HasInstanceMethod(object_getClass(descriptor), "setBluePrimary:")) {
      reinterpret_cast<SetPointMessage>(objc_msgSend)(
          descriptor, sel_registerName("setBluePrimary:"),
          CGPointMake(0.1494, 0.0557));
    }
  }

  bool Apply(const MacosVirtualDisplayMode& selected,
             const std::vector<MacosVirtualDisplayMode>& modes,
             std::string* error) {
    if (display_ == nullptr || error == nullptr)
      return false;
    @autoreleasepool {
      id settings = AllocateAndInitialize(settings_class_);
      if (settings == nil) {
        *error = "CGVirtualDisplaySettings allocation failed";
        return false;
      }
      NSMutableArray* native_modes = [NSMutableArray array];
      auto append_mode = [&](const MacosVirtualDisplayMode& mode) {
        if (std::abs(mode.scale - selected.scale) >
            std::numeric_limits<double>::epsilon()) {
          return;
        }
        __unsafe_unretained id allocated = reinterpret_cast<InitMessage>(
            objc_msgSend)(mode_class_, sel_registerName("alloc"));
        __unsafe_unretained id initialized =
            allocated == nil
                ? nil
                : reinterpret_cast<InitModeMessage>(objc_msgSend)(
                      allocated,
                      sel_registerName("initWithWidth:height:refreshRate:"),
                      mode.pixels.width, mode.pixels.height,
                      mode.refresh_rate_hz);
        id native_mode =
            initialized == nil
                ? nil
                : (__bridge_transfer id)(__bridge void*)initialized;
        if (native_mode != nil)
          [native_modes addObject:native_mode];
      };
      append_mode(selected);
      for (const auto& mode : modes) {
        if (mode.pixels.width != selected.pixels.width ||
            mode.pixels.height != selected.pixels.height) {
          append_mode(mode);
        }
      }
      if (native_modes.count == 0) {
        *error = "CGVirtualDisplay produced no approved modes";
        return false;
      }
      SetObject(settings, "setModes:", native_modes);
      SetUnsigned(settings, "setHiDPI:", selected.scale == 2.0 ? 1U : 0U);
      SetUnsigned(settings, "setRotation:", 0);
      if (!reinterpret_cast<ApplySettingsMessage>(objc_msgSend)(
              (__bridge id)display_, sel_registerName("applySettings:"),
              settings)) {
        *error = "CGVirtualDisplay rejected approved settings";
        return false;
      }
      void* retained_settings = RetainOpaque(settings);
      if (retained_settings == nullptr) {
        *error = "CGVirtualDisplaySettings retention failed";
        return false;
      }
      if (settings_ != nullptr)
        objc_release((__bridge id)settings_);
      settings_ = retained_settings;
      error->clear();
      return true;
    }
  }

  Class display_class_ = Nil;
  Class descriptor_class_ = Nil;
  Class mode_class_ = Nil;
  Class settings_class_ = Nil;
  void* descriptor_ = nullptr;
  void* settings_ = nullptr;
  void* display_ = nullptr;
  std::uint32_t display_id_ = 0;
};

}  // namespace

std::unique_ptr<MacosVirtualDisplayBackend>
CreateAppleMacosVirtualDisplayBackend() {
  return std::make_unique<AppleMacosVirtualDisplayBackend>();
}

}  // namespace imcodes::remote_desktop::macos
