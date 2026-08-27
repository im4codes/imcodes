#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

#if !__has_feature(objc_arc)
#error "macos_slvirtual_display_runtime.mm requires Objective-C ARC"
#endif

#include <dlfcn.h>
#include <sys/sysctl.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "macos_slvirtual_display_backend.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kSkyLightPath[] =
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
constexpr char kVerifiedDarwinBuild[] = "25C56";

struct SLFloatPoint { float x; float y; };
struct SLFloatSize { float width; float height; };
struct SLUIntSize { std::uint32_t width; std::uint32_t height; };
struct SLChromaticities {
  SLFloatPoint red;
  SLFloatPoint green;
  SLFloatPoint blue;
  SLFloatPoint white;
};

using AllocMessage = id (*)(Class, SEL);
using InitMessage = id (*)(id, SEL);
using ConfigurationInitMessage = id (*)(id, SEL, id, std::uint64_t,
                                         std::uint64_t, std::uint64_t,
                                         SLFloatSize, SLUIntSize,
                                         SLChromaticities, NSError**);
using DisplayInitMessage = id (*)(id, SEL, id, NSError**);
using ModeInitMessage = id (*)(id, SEL, SLUIntSize, SLUIntSize, float,
                               NSError**);
using SettingsInitMessage = id (*)(id, SEL, id, id, id, std::uint64_t,
                                   NSError**);
using ApplyMessage = BOOL (*)(id, SEL, id, NSError**);
using DisplayIdMessage = unsigned int (*)(id, SEL);
using DestroyMessage = void (*)(id, SEL);
using DisplayListFn = CGError (*)(std::uint32_t, CGDirectDisplayID*,
                                  std::uint32_t*);
using DisplayIsActiveFn = bool (*)(CGDirectDisplayID);

extern "C" void objc_release(id value);

bool EncodingEquals(Method method, const char* expected) {
  const char* actual = method == nullptr ? nullptr : method_getTypeEncoding(method);
  return actual != nullptr && std::strcmp(actual, expected) == 0;
}

std::string ExpectedApplySettingsEncoding() {
  // BOOL is unsigned char (`B`) on arm64 and signed char (`c`) on x86_64.
  // Derive only the return code from the compiler ABI; every offset and
  // argument remains pinned to the measured method contract.
  return std::string(@encode(BOOL)) + "32@0:8@16^@24";
}

bool ApplySettingsEncodingEquals(Method method) {
  const char* actual =
      method == nullptr ? nullptr : method_getTypeEncoding(method);
  return actual != nullptr && ExpectedApplySettingsEncoding() == actual;
}

bool StructurallySafeNoArgumentVoidMethod(Method method) {
  if (method == nullptr || method_getNumberOfArguments(method) != 2)
    return false;
  char* return_type = method_copyReturnType(method);
  char* self_type = method_copyArgumentType(method, 0);
  char* selector_type = method_copyArgumentType(method, 1);
  const bool safe = return_type != nullptr && self_type != nullptr &&
                    selector_type != nullptr &&
                    std::strcmp(return_type, "v") == 0 &&
                    std::strcmp(self_type, "@") == 0 &&
                    std::strcmp(selector_type, ":") == 0;
  free(return_type);
  free(self_type);
  free(selector_type);
  return safe;
}

bool InvokeMismatchedExactDestroy(id object, Method method,
                                  std::string* error) {
  if (object == nil || error == nullptr ||
      !StructurallySafeNoArgumentVoidMethod(method)) {
    if (error != nullptr)
      *error = "mismatched destroy method is not structurally safe to invoke";
    return false;
  }
  const SEL selector = method_getName(method);
  const IMP implementation = method_getImplementation(method);
  if (selector == nullptr || implementation == nullptr) {
    *error = "mismatched destroy method has no exact selector or IMP";
    return false;
  }
  reinterpret_cast<void (*)(id, SEL)>(implementation)(object, selector);
  error->clear();
  return true;
}

void QuarantineUnverifiedObject(id object) {
  // Never let ARC deallocation masquerade as removal. A process-lifetime
  // quarantine is intentionally preferable to dropping the last owner of a
  // display whose exact teardown could not be invoked or verified.
  static NSMutableArray* quarantine = [NSMutableArray array];
  if (object != nil)
    [quarantine addObject:object];
}

bool CleanupPostInitEncodingMismatch(
    id object, Method method, const std::function<bool()>& removal_verified,
    std::string* error) {
  if (error == nullptr)
    return false;
  std::string invoke_error;
  if (!InvokeMismatchedExactDestroy(object, method, &invoke_error)) {
    QuarantineUnverifiedObject(object);
    *error = invoke_error;
    return false;
  }
  if (!removal_verified()) {
    QuarantineUnverifiedObject(object);
    *error = "exact destroy invoked but removal was not verified";
    return false;
  }
  error->clear();
  return true;
}

bool HandlePostInitDestroyEncodingMismatch(
    id object, Method method, const std::function<bool()>& removal_verified,
    std::string* error) {
  // This named seam is shared by production and the no-display runtime
  // counterexample. Replacing it with the former bare return leaves a
  // compile-clean mutant whose missing exact-object teardown is observable.
  return CleanupPostInitEncodingMismatch(object, method, removal_verified,
                                         error);
}

std::string DarwinBuild() {
  std::size_t size = 0;
  if (sysctlbyname("kern.osversion", nullptr, &size, nullptr, 0) != 0 ||
      size == 0 || size > 64) {
    return {};
  }
  std::string build(size, '\0');
  if (sysctlbyname("kern.osversion", build.data(), &size, nullptr, 0) != 0)
    return {};
  while (!build.empty() && build.back() == '\0')
    build.pop_back();
  return build;
}

id TransferInitialized(__unsafe_unretained id value) {
  return value == nil ? nil : (__bridge_transfer id)(__bridge void*)value;
}

id Allocate(Class cls) {
  return cls == Nil ? nil
                    : reinterpret_cast<AllocMessage>(objc_msgSend)(
                          cls, sel_registerName("alloc"));
}

std::string ErrorText(NSError* error, const char* fallback) {
  if (error == nil)
    return fallback;
  const char* text = error.localizedDescription.UTF8String;
  return text == nullptr ? fallback : text;
}

class SystemSLVirtualDisplayRuntime final : public SLVirtualDisplayRuntime {
 public:
  bool ProbeVerifiedRuntime(std::string* error) noexcept override {
    @autoreleasepool {
      if (error == nullptr)
        return false;
      const NSOperatingSystemVersion version =
          NSProcessInfo.processInfo.operatingSystemVersion;
      if (version.majorVersion != 26 || version.minorVersion != 2 ||
          DarwinBuild() != kVerifiedDarwinBuild) {
        *error = "SLVirtualDisplay is verified only on macOS 26.2 build 25C56";
        return false;
      }
      handle_ = dlopen(kSkyLightPath, RTLD_LAZY | RTLD_LOCAL);
      if (handle_ == nullptr) {
        *error = "SkyLight could not be loaded";
        return false;
      }
      display_class_ = NSClassFromString(@"SLVirtualDisplay");
      configuration_class_ = NSClassFromString(@"SLVirtualDisplayConfiguration");
      mode_class_ = NSClassFromString(@"SLVirtualDisplayMode");
      settings_class_ = NSClassFromString(@"SLVirtualDisplaySettings");
      if (display_class_ == Nil || configuration_class_ == Nil ||
          mode_class_ == Nil || settings_class_ == Nil) {
        *error = "required SLVirtualDisplay classes are unavailable";
        return false;
      }
      const bool encodings_ok =
          EncodingEquals(class_getInstanceMethod(display_class_,
                                                  sel_registerName("initWithConfiguration:error:")),
                         "@32@0:8@16^@24") &&
          ApplySettingsEncodingEquals(class_getInstanceMethod(
              display_class_, sel_registerName("applySettings:error:"))) &&
          EncodingEquals(class_getInstanceMethod(display_class_,
                                                  sel_registerName("displayID")),
                         "I16@0:8") &&
          EncodingEquals(class_getInstanceMethod(display_class_,
                                                  sel_registerName("destroy")),
                         "v16@0:8") &&
          EncodingEquals(class_getInstanceMethod(configuration_class_,
              sel_registerName("initWithName:vendorID:productID:serialNumber:sizeInMillimeters:maximumSizeInPixels:chromaticities:error:")),
              "@104@0:8@16Q24Q32Q40{?=ff}48{?=II}56{?={?=ff}{?=ff}{?=ff}{?=ff}}64^@96") &&
          EncodingEquals(class_getInstanceMethod(mode_class_,
              sel_registerName("initWithSizeInPixels:sizeInPoints:refreshRate:error:")),
              "@44@0:8{?=II}16{?=II}24f32^@36") &&
          EncodingEquals(class_getInstanceMethod(settings_class_,
              sel_registerName("initWithNativeMode:preferredMode:optionalModes:rotations:error:")),
              "@56@0:8@16@24@32Q40^@48");
      if (!encodings_ok) {
        *error = "SLVirtualDisplay method signature mismatch";
        return false;
      }
      registered_list_ = reinterpret_cast<DisplayListFn>(
          dlsym(handle_, "SLSGetDisplayList"));
      online_list_ = reinterpret_cast<DisplayListFn>(
          dlsym(handle_, "SLSGetOnlineDisplayList"));
      is_active_ = reinterpret_cast<DisplayIsActiveFn>(
          dlsym(handle_, "SLDisplayIsActive"));
      if (registered_list_ == nullptr || online_list_ == nullptr ||
          is_active_ == nullptr) {
        *error = "SLVirtualDisplay removal evidence symbols are unavailable";
        return false;
      }
      error->clear();
      return true;
    }
  }

  bool CreateExact(const MacosVirtualDisplayConfiguration& configuration,
                   SLVirtualDisplayInstance* instance,
                   std::string* error) override {
    @autoreleasepool {
      if (instance == nullptr || error == nullptr ||
          !ProbeVerifiedRuntime(error)) {
        return false;
      }
      *instance = {};
      const auto widest = std::max_element(
          configuration.modes.begin(), configuration.modes.end(),
          [](const auto& a, const auto& b) { return a.pixels.width < b.pixels.width; });
      const auto tallest = std::max_element(
          configuration.modes.begin(), configuration.modes.end(),
          [](const auto& a, const auto& b) { return a.pixels.height < b.pixels.height; });
      NSError* native_error = nil;
      __unsafe_unretained id raw_configuration =
          reinterpret_cast<ConfigurationInitMessage>(objc_msgSend)(
              Allocate(configuration_class_),
              sel_registerName("initWithName:vendorID:productID:serialNumber:sizeInMillimeters:maximumSizeInPixels:chromaticities:error:"),
              [NSString stringWithUTF8String:configuration.name.c_str()],
              configuration.vendor_id, configuration.product_id,
              configuration.serial_number, SLFloatSize{600.0f, 340.0f},
              SLUIntSize{widest->pixels.width, tallest->pixels.height},
              SLChromaticities{{0.6797f, 0.3203f}, {0.2559f, 0.6983f},
                               {0.1494f, 0.0557f}, {0.3125f, 0.3291f}},
              &native_error);
      id native_configuration = TransferInitialized(raw_configuration);
      if (native_configuration == nil) {
        *error = ErrorText(native_error, "SLVirtualDisplayConfiguration creation failed");
        return false;
      }
      native_error = nil;
      __unsafe_unretained id raw_display =
          reinterpret_cast<DisplayInitMessage>(objc_msgSend)(
              Allocate(display_class_), sel_registerName("initWithConfiguration:error:"),
              native_configuration, &native_error);
      if (raw_display == nil) {
        *error = ErrorText(native_error, "SLVirtualDisplay creation failed");
        return false;
      }
      id display = TransferInitialized(raw_display);
      Method exact_destroy = class_getInstanceMethod(object_getClass(display),
                                                       sel_registerName("destroy"));
      if (!EncodingEquals(exact_destroy, "v16@0:8")) {
        const std::uint32_t mismatch_display_id =
            reinterpret_cast<DisplayIdMessage>(objc_msgSend)(
                display, sel_registerName("displayID"));
        std::string cleanup_error;
        const bool removed = HandlePostInitDestroyEncodingMismatch(
            display, exact_destroy,
            [this, mismatch_display_id] {
              return mismatch_display_id != 0 &&
                     WaitForRemoval(mismatch_display_id, 500);
            },
            &cleanup_error);
        *error = "created SLVirtualDisplay object has a destroy encoding mismatch";
        if (!removed) {
          *error += "; exact-object cleanup not verified: " +
                    (cleanup_error.empty() ? "display remains present"
                                           : cleanup_error);
        }
        return false;
      }
      const std::uint32_t display_id =
          reinterpret_cast<DisplayIdMessage>(objc_msgSend)(
              display, sel_registerName("displayID"));
      if (display_id == 0) {
        std::string cleanup_error;
        (void)CleanupPostInitEncodingMismatch(
            display, exact_destroy, [] { return false; }, &cleanup_error);
        *error = "SLVirtualDisplay returned an invalid display id; "
                 "exact destroy invoked but removal cannot be verified";
        return false;
      }
      SLVirtualDisplayInstance candidate{
          reinterpret_cast<std::uintptr_t>((__bridge void*)display),
          reinterpret_cast<std::uintptr_t>(method_getImplementation(exact_destroy)),
          configuration.worker_generation, display_id};
      // Transfer the +1 display out of ARC only after all exact-instance facts
      // are recorded. ReleaseObject owns the matching objc_release.
      (void)(__bridge_retained void*)display;
      *instance = candidate;
      error->clear();
      return true;
    }
  }

  bool ExactInstanceEndorsesDestroy(
      const SLVirtualDisplayInstance& instance) noexcept override {
    if (!instance.IsValid())
      return false;
    id object = (__bridge id)reinterpret_cast<void*>(instance.object);
    Method method = class_getInstanceMethod(object_getClass(object),
                                             sel_registerName("destroy"));
    return EncodingEquals(method, "v16@0:8") &&
           reinterpret_cast<std::uintptr_t>(method_getImplementation(method)) ==
               instance.destroy_implementation;
  }

  bool ApplySettings(const SLVirtualDisplayInstance& instance,
                     const MacosVirtualDisplayMode& selected,
                     const std::vector<MacosVirtualDisplayMode>& modes,
                     std::string* error) override {
    @autoreleasepool {
      if (error == nullptr || !ExactInstanceEndorsesDestroy(instance) ||
          modes.empty()) {
        return false;
      }
      NSMutableArray* native_modes = [NSMutableArray array];
      id preferred = nil;
      NSError* native_error = nil;
      for (const auto& mode : modes) {
        const auto point_width = static_cast<std::uint32_t>(mode.pixels.width / mode.scale);
        const auto point_height = static_cast<std::uint32_t>(mode.pixels.height / mode.scale);
        __unsafe_unretained id raw_mode =
            reinterpret_cast<ModeInitMessage>(objc_msgSend)(
                Allocate(mode_class_),
                sel_registerName("initWithSizeInPixels:sizeInPoints:refreshRate:error:"),
                SLUIntSize{mode.pixels.width, mode.pixels.height},
                SLUIntSize{point_width, point_height},
                static_cast<float>(mode.refresh_rate_hz), &native_error);
        id native_mode = TransferInitialized(raw_mode);
        if (native_mode == nil) {
          *error = ErrorText(native_error, "SLVirtualDisplayMode creation failed");
          return false;
        }
        [native_modes addObject:native_mode];
        if (mode.pixels.width == selected.pixels.width &&
            mode.pixels.height == selected.pixels.height &&
            mode.scale == selected.scale)
          preferred = native_mode;
      }
      if (preferred == nil) {
        *error = "selected SLVirtualDisplay mode is not in the advertised set";
        return false;
      }
      native_error = nil;
      __unsafe_unretained id raw_settings =
          reinterpret_cast<SettingsInitMessage>(objc_msgSend)(
              Allocate(settings_class_),
              sel_registerName("initWithNativeMode:preferredMode:optionalModes:rotations:error:"),
              preferred, preferred, native_modes, 0, &native_error);
      id settings = TransferInitialized(raw_settings);
      if (settings == nil) {
        *error = ErrorText(native_error, "SLVirtualDisplaySettings creation failed");
        return false;
      }
      id display = (__bridge id)reinterpret_cast<void*>(instance.object);
      native_error = nil;
      if (reinterpret_cast<ApplyMessage>(objc_msgSend)(
              display, sel_registerName("applySettings:error:"), settings,
              &native_error) == NO) {
        *error = ErrorText(native_error, "SLVirtualDisplay activation failed");
        return false;
      }
      error->clear();
      return true;
    }
  }

  bool QueryPresence(const SLVirtualDisplayInstance& instance,
                     bool* active,
                     bool* visible) noexcept override {
    if (active == nullptr || visible == nullptr || !instance.IsValid() ||
        registered_list_ == nullptr || online_list_ == nullptr ||
        is_active_ == nullptr) {
      return false;
    }
    std::vector<CGDirectDisplayID> registered;
    std::vector<CGDirectDisplayID> online;
    if (!ReadList(registered_list_, &registered) ||
        !ReadList(online_list_, &online)) {
      return false;
    }
    const auto id = static_cast<CGDirectDisplayID>(instance.display_id);
    const bool registered_now =
        std::find(registered.begin(), registered.end(), id) != registered.end();
    *active = registered_now && is_active_(id);
    *visible = std::find(online.begin(), online.end(), id) != online.end();
    return true;
  }

  bool InvokeExactDestroy(const SLVirtualDisplayInstance& instance,
                          std::string* error) noexcept override {
    if (error == nullptr || !ExactInstanceEndorsesDestroy(instance)) {
      if (error != nullptr)
        *error = "SLVirtualDisplay exact-instance destroy endorsement failed";
      return false;
    }
    id display = (__bridge id)reinterpret_cast<void*>(instance.object);
    reinterpret_cast<DestroyMessage>(objc_msgSend)(display,
                                                    sel_registerName("destroy"));
    error->clear();
    return true;
  }

  void SleepForRemovalPoll() noexcept override {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  void ReleaseObject(const SLVirtualDisplayInstance& instance) noexcept override {
    if (instance.object != 0)
      objc_release((__bridge id)reinterpret_cast<void*>(instance.object));
  }

 private:
  static bool ReadList(DisplayListFn function,
                       std::vector<CGDirectDisplayID>* result) noexcept {
    if (function == nullptr || result == nullptr)
      return false;
    std::uint32_t count = 0;
    if (function(0, nullptr, &count) != kCGErrorSuccess || count > 64)
      return false;
    result->assign(count, 0);
    std::uint32_t written = 0;
    if (count != 0 &&
        function(count, result->data(), &written) != kCGErrorSuccess) {
      return false;
    }
    if (written > count)
      return false;
    result->resize(written);
    return true;
  }

  bool WaitForRemoval(std::uint32_t display_id,
                      std::uint32_t maximum_polls) noexcept {
    if (display_id == 0 || registered_list_ == nullptr ||
        online_list_ == nullptr || is_active_ == nullptr) {
      return false;
    }
    for (std::uint32_t poll = 0; poll < maximum_polls; ++poll) {
      std::vector<CGDirectDisplayID> registered;
      std::vector<CGDirectDisplayID> online;
      if (ReadList(registered_list_, &registered) &&
          ReadList(online_list_, &online)) {
        const auto id = static_cast<CGDirectDisplayID>(display_id);
        const bool registered_now =
            std::find(registered.begin(), registered.end(), id) !=
            registered.end();
        const bool visible_now =
            std::find(online.begin(), online.end(), id) != online.end();
        if (!registered_now && !visible_now && !is_active_(id))
          return true;
      }
      SleepForRemovalPoll();
    }
    return false;
  }

  void* handle_ = nullptr;
  Class display_class_ = Nil;
  Class configuration_class_ = Nil;
  Class mode_class_ = Nil;
  Class settings_class_ = Nil;
  DisplayListFn registered_list_ = nullptr;
  DisplayListFn online_list_ = nullptr;
  DisplayIsActiveFn is_active_ = nullptr;
};

}  // namespace

std::unique_ptr<SLVirtualDisplayRuntime> CreateSystemSLVirtualDisplayRuntime() {
  return std::make_unique<SystemSLVirtualDisplayRuntime>();
}

std::unique_ptr<SLVirtualDisplayBackend> CreateSLVirtualDisplayBackend() {
  return std::make_unique<SLVirtualDisplayBackend>(
      CreateSystemSLVirtualDisplayRuntime());
}

}  // namespace imcodes::remote_desktop::macos
