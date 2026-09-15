// Runtime resolution of the SkyLight display calls.
//
// NOTHING here is linked at build time. SkyLight is a private framework; a link
// against it would make the whole product fail to launch the day Apple moves or
// renames it, and would embed a dependency no notarised build should declare.
// Every symbol is dlsym'd by name, and a single missing symbol makes the seam
// incomplete, which the authority layer treats as "display control unavailable".
//
// Two distinct mechanisms live here, and conflating them was an earlier mistake
// worth naming:
//
//   * ENUMERATION and ENABLE use dlsym'd C entry points (SLSGetDisplayList,
//     SLSGetOnlineDisplayList, SLSConfigureDisplayEnabled). Both the CGS* and
//     SLS* spellings are tried because CoreGraphics re-exports the CGS aliases
//     straight through; whichever resolves is used and neither is assumed.
//     Note that "SLSDisplayIsActive" DOES NOT EXIST -- the real symbol is
//     SLDisplayIsActive with a single S, verified read-only on 26.2.
//
//   * ACTIVATION uses -[SLWindowMirroringManager extend:], reached through the
//     ObjC runtime with its type encoding verified. This is what a shipping
//     implementation actually calls, and it is NOT the same operation as
//     breaking a mirror set and moving the origin: only extend: can bring a
//     registered-inactive display into the topology.

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <dlfcn.h>

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

#include "macos_virtual_display_skylight.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr char kSkyLightPath[] =
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";

using CGSConnectionID = int;
using MainConnectionFn = CGSConnectionID (*)(void);
using BeginConfigurationFn = CGError (*)(CGDisplayConfigRef*);
using ConfigureEnabledFn = CGError (*)(CGDisplayConfigRef,
                                       CGDirectDisplayID,
                                       bool);
using CompleteConfigurationFn = CGError (*)(CGDisplayConfigRef,
                                            CGConfigureOption);
using CancelConfigurationFn = CGError (*)(CGDisplayConfigRef);
using ConfigureOriginFn = CGError (*)(CGDisplayConfigRef,
                                      CGDirectDisplayID,
                                      std::int32_t,
                                      std::int32_t);
using DisplayListFn = CGError (*)(std::uint32_t,
                                  CGDirectDisplayID*,
                                  std::uint32_t*);
using DisplayIsActiveFn = bool (*)(CGDirectDisplayID);

// Handle is intentionally leaked for the process lifetime: unloading a private
// framework while WindowServer still holds a configuration would be worse than
// the leak.
void* SkyLightHandle() {
  static void* handle = dlopen(kSkyLightPath, RTLD_LAZY | RTLD_LOCAL);
  return handle;
}

template <typename Fn>
Fn Lookup(const char* primary, const char* fallback = nullptr) {
  void* handle = SkyLightHandle();
  if (handle == nullptr)
    return nullptr;
  if (void* symbol = dlsym(handle, primary))
    return reinterpret_cast<Fn>(symbol);
  if (fallback != nullptr) {
    if (void* symbol = dlsym(handle, fallback))
      return reinterpret_cast<Fn>(symbol);
  }
  return nullptr;
}

struct ResolvedSymbols {
  // PRIVATE surface, deliberately minimal — only what the public API cannot do.
  ConfigureEnabledFn configure_enabled = nullptr;  // SLSConfigureDisplayEnabled
  DisplayListFn registered_list = nullptr;         // SLSGetDisplayList
  DisplayListFn online_list = nullptr;             // SLSGetOnlineDisplayList
  DisplayIsActiveFn is_active = nullptr;           // SLDisplayIsActive (ONE S)

  [[nodiscard]] bool complete_enough() const noexcept {
    return configure_enabled != nullptr && registered_list != nullptr &&
           online_list != nullptr && is_active != nullptr;
  }
};

const ResolvedSymbols& Symbols() {
  static const ResolvedSymbols symbols = [] {
    ResolvedSymbols resolved;
    // Verified by read-only runtime probe on macOS 26.2 (25C56, arm64e):
    // SLSConfigureDisplayEnabled / SLSGetDisplayList / SLSGetOnlineDisplayList
    // all resolve, and CoreGraphics re-exports the CGS* aliases straight
    // through, so either name reaches the same implementation.
    resolved.configure_enabled = Lookup<ConfigureEnabledFn>(
        "SLSConfigureDisplayEnabled", "CGSConfigureDisplayEnabled");
    resolved.registered_list =
        Lookup<DisplayListFn>("SLSGetDisplayList", "CGSGetDisplayList");
    resolved.online_list = Lookup<DisplayListFn>("SLSGetOnlineDisplayList",
                                                 "CGSGetOnlineDisplayList");
    // MEASURED: "SLSDisplayIsActive" DOES NOT EXIST. The real symbol is
    // SLDisplayIsActive with a SINGLE S; the double-S spelling that appears in
    // several third-party headers resolves to nothing, which would have made
    // this seam permanently incomplete and the whole feature silently
    // unavailable. Probed read-only on 26.2 before any display was created.
    resolved.is_active =
        Lookup<DisplayIsActiveFn>("SLDisplayIsActive", "CGSDisplayIsActive");
    return resolved;
  }();
  return symbols;
}

std::vector<CGDirectDisplayID> ReadList(DisplayListFn fn) {
  std::vector<CGDirectDisplayID> ids;
  if (fn == nullptr)
    return ids;
  std::uint32_t count = 0;
  if (fn(0, nullptr, &count) != kCGErrorSuccess || count == 0)
    return ids;
  if (count > 64)  // bounded: a corrupted count must not become a huge alloc
    count = 64;
  ids.resize(count);
  std::uint32_t written = 0;
  if (fn(count, ids.data(), &written) != kCGErrorSuccess) {
    ids.clear();
    return ids;
  }
  ids.resize(written > count ? count : written);
  return ids;
}

std::vector<CGDirectDisplayID> OnlineIds() {
  return ReadList(Symbols().online_list);
}

std::vector<CGDirectDisplayID> RegisteredIds() {
  std::vector<CGDirectDisplayID> ids;
  const ResolvedSymbols& symbols = Symbols();
  if (symbols.registered_list == nullptr)
    return ids;
  std::uint32_t count = 0;
  if (symbols.registered_list(0, nullptr, &count) != kCGErrorSuccess ||
      count == 0) {
    return ids;
  }
  // Bounded: a corrupted count must not become an unbounded allocation.
  if (count > 64)
    count = 64;
  ids.resize(count);
  std::uint32_t written = 0;
  if (symbols.registered_list(count, ids.data(), &written) !=
      kCGErrorSuccess) {
    ids.clear();
    return ids;
  }
  ids.resize(written > count ? count : written);
  return ids;
}

// One begin/commit transaction per mutation.
//
// The transaction itself uses the PUBLIC CGBeginDisplayConfiguration /
// CGCompleteDisplayConfiguration / CGCancelDisplayConfiguration. Two reasons:
// they are documented and ABI-stable, and the private SLSCompleteDisplayConfiguration
// takes a THIRD undocumented argument, so calling it through a two-argument
// prototype would be an ABI mismatch for no benefit. That keeps the private
// surface down to three enumeration/enable symbols.
//
// Committing ForSession (not ForAppOnly) is what makes the change outlive this
// process, which is what a helper holding a warm display needs.
bool RunConfiguration(
    const std::function<bool(CGDisplayConfigRef, const ResolvedSymbols&)>& body,
    std::string* error) {
  const ResolvedSymbols& symbols = Symbols();
  if (!symbols.complete_enough()) {
    if (error != nullptr)
      *error = "SkyLight display configuration symbols unavailable";
    return false;
  }
  CGDisplayConfigRef configuration = nullptr;
  if (CGBeginDisplayConfiguration(&configuration) != kCGErrorSuccess ||
      configuration == nullptr) {
    if (error != nullptr)
      *error = "could not begin a display configuration";
    return false;
  }
  if (!body(configuration, symbols)) {
    CGCancelDisplayConfiguration(configuration);
    if (error != nullptr && error->empty())
      *error = "display configuration rejected";
    return false;
  }
  if (CGCompleteDisplayConfiguration(configuration, kCGConfigureForSession) !=
      kCGErrorSuccess) {
    if (error != nullptr)
      *error = "could not commit the display configuration";
    return false;
  }
  return true;
}

}  // namespace

SkyLightSeam ResolveSystemSkyLightSeam() {
  SkyLightSeam seam;
  const ResolvedSymbols& symbols = Symbols();
  if (!symbols.complete_enough()) {
    // Deliberately returns an INCOMPLETE seam. Never a partially wired one: the
    // caller must be unable to observe a display it has no way to disable.
    return seam;
  }

  seam.list_displays = [] {
    std::vector<SkyLightDisplay> displays;
    const ResolvedSymbols& resolved = Symbols();
    // There is no "is enabled" predicate. Registered-but-disabled is derived by
    // SET ARITHMETIC: everything in SLSGetDisplayList that is absent from
    // SLSGetOnlineDisplayList. Measured on 26.2: registered={5,6,1,2,3} while
    // online={5,6}, so 1/2/3 are registered-inactive and invisible to every
    // public enumerator.
    std::vector<CGDirectDisplayID> online = OnlineIds();
    for (CGDirectDisplayID id : RegisteredIds()) {
      SkyLightDisplay display;
      display.display_id = static_cast<std::uint32_t>(id);
      display.registered = true;
      const bool in_online =
          std::find(online.begin(), online.end(), id) != online.end();
      // SLDisplayIsActive is used to CROSS-CHECK the set difference rather than
      // to replace it. Where they disagree, the display is reported inactive:
      // treating a display as gone when it is merely disabled is what lets a
      // second one get created on top of it.
      const bool predicate =
          resolved.is_active != nullptr && resolved.is_active(id);
      display.active = in_online && predicate;
      displays.push_back(display);
    }
    return displays;
  };

  seam.configure_display_enabled = [](std::uint32_t display_id, bool enabled,
                                      std::string* error) {
    if (display_id == 0) {
      if (error != nullptr)
        *error = "invalid display id";
      return false;
    }
    return RunConfiguration(
        [display_id, enabled](CGDisplayConfigRef configuration,
                              const ResolvedSymbols& resolved) {
          return resolved.configure_enabled(
                     configuration, static_cast<CGDirectDisplayID>(display_id),
                     enabled) == kCGErrorSuccess;
        },
        error);
  };

  seam.force_extend = [](std::uint32_t display_id, std::string* error) {
    if (display_id == 0) {
      if (error != nullptr)
        *error = "invalid display id";
      return false;
    }
    // Activation goes through -[SLWindowMirroringManager extend:].
    //
    // This is the mechanism a shipping implementation actually uses, and it is
    // NOT interchangeable with breaking the mirror set and moving the origin.
    // Those two only rearrange a display that WindowServer has already brought
    // into the topology; they cannot bring in one that is registered-inactive,
    // which is exactly the state this seam exists to escape. Reporting success
    // from an origin change would advertise activation that never happened, so
    // there is deliberately no fallback: if extend: is unavailable or refuses,
    // this fails.
    Class manager_class = NSClassFromString(@"SLWindowMirroringManager");
    if (manager_class == Nil) {
      if (error != nullptr)
        *error = "SLWindowMirroringManager is unavailable";
      return false;
    }
    const SEL shared_selector = sel_registerName("shared");
    const SEL extend_selector = sel_registerName("extend:");
    Method shared_method =
        class_getClassMethod(manager_class, shared_selector);
    Method extend_method =
        class_getInstanceMethod(manager_class, extend_selector);
    if (shared_method == nullptr || extend_method == nullptr) {
      if (error != nullptr)
        *error = "SLWindowMirroringManager selectors are unavailable";
      return false;
    }
    // Strict encoding check, verified read-only on macOS 26.2 (25C56):
    //   -[SLWindowMirroringManager extend:]  ->  "B24@0:8@16"
    // The argument is `@` (an OBJECT), not `I` (a CGDirectDisplayID). Passing a
    // raw integer through an object parameter is undefined behaviour that
    // happens to look like it works, so the id is boxed. Verifying the encoding
    // rather than assuming it is what keeps a future signature change from
    // silently becoming a wild pointer.
    const char* extend_encoding = method_getTypeEncoding(extend_method);
    if (extend_encoding == nullptr ||
        std::strcmp(extend_encoding, "B24@0:8@16") != 0) {
      if (error != nullptr) {
        *error = std::string("SLWindowMirroringManager extend: encoding is ") +
                 (extend_encoding == nullptr ? "(null)" : extend_encoding) +
                 ", expected B24@0:8@16";
      }
      return false;
    }
    using SharedMessage = id (*)(Class, SEL);
    using ExtendMessage = BOOL (*)(id, SEL, id);
    id manager = reinterpret_cast<SharedMessage>(objc_msgSend)(manager_class,
                                                               shared_selector);
    if (manager == nil) {
      if (error != nullptr)
        *error = "SLWindowMirroringManager.shared returned nil";
      return false;
    }
    NSNumber* boxed = @(static_cast<unsigned int>(display_id));
    const BOOL extended = reinterpret_cast<ExtendMessage>(objc_msgSend)(
        manager, extend_selector, boxed);
    if (extended == NO) {
      if (error != nullptr)
        *error = "SLWindowMirroringManager refused to extend the display";
      return false;
    }
    return true;
  };

  seam.online_display_ids = [] {
    std::vector<std::uint32_t> ids;
    std::uint32_t count = 0;
    if (CGGetOnlineDisplayList(0, nullptr, &count) != kCGErrorSuccess ||
        count == 0) {
      return ids;
    }
    if (count > 64)
      count = 64;
    std::vector<CGDirectDisplayID> native(count);
    std::uint32_t written = 0;
    if (CGGetOnlineDisplayList(count, native.data(), &written) !=
        kCGErrorSuccess) {
      return ids;
    }
    if (written > count)
      written = count;
    for (std::uint32_t index = 0; index < written; ++index)
      ids.push_back(static_cast<std::uint32_t>(native[index]));
    return ids;
  };

  return seam;
}

bool DestroyCapableVirtualDisplayBackendAvailable() {
  static const bool available = [] {
    Class display_class = NSClassFromString(@"SLVirtualDisplay");
    Class configuration_class = NSClassFromString(@"SLVirtualDisplayConfiguration");
    Class settings_class = NSClassFromString(@"SLVirtualDisplaySettings");
    Class mode_class = NSClassFromString(@"SLVirtualDisplayMode");
    if (display_class == Nil || configuration_class == Nil ||
        settings_class == Nil || mode_class == Nil) {
      return false;
    }
    // -destroy is the whole point: it is the only unconditional teardown this
    // OS exposes. Without it the modern classes buy us nothing.
    const SEL required[] = {
        sel_registerName("initWithConfiguration:error:"),
        sel_registerName("applySettings:error:"),
        sel_registerName("displayID"),
        sel_registerName("destroy"),
    };
    for (SEL selector : required) {
      if (class_getInstanceMethod(display_class, selector) == nullptr)
        return false;
    }
    return true;
  }();
  return available;
}

}  // namespace imcodes::remote_desktop::macos
