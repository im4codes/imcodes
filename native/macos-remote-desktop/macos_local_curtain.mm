#include "macos_local_curtain.h"

#import <ApplicationServices/ApplicationServices.h>

#include <array>
#include <condition_variable>
#include <mutex>

#include "cg_event_input_adapter.h"

namespace imcodes::remote_desktop::macos {
namespace {

constexpr std::uint32_t kMaxDisplays = 16;
constexpr std::uint32_t kGammaSamples = 256;

bool DarkenAllDisplays() noexcept {
  std::array<CGDirectDisplayID, kMaxDisplays> displays{};
  std::uint32_t count = 0;
  if (CGGetOnlineDisplayList(kMaxDisplays, displays.data(), &count) !=
          kCGErrorSuccess ||
      count == 0) {
    return false;
  }
  const std::array<CGGammaValue, kGammaSamples> zero{};
  bool any = false;
  for (std::uint32_t index = 0; index < count; ++index) {
    any = CGSetDisplayTransferByTable(displays[index], kGammaSamples,
                                      zero.data(), zero.data(), zero.data()) ==
              kCGErrorSuccess ||
          any;
  }
  return any;
}

}  // namespace

// Drops physical keyboard, mouse and scroll input on its own CFRunLoop
// thread. Events this worker injected carry the synthetic marker and pass.
class MacosLocalCurtain::InputBlocker {
 public:
  ~InputBlocker() { Stop(); }

  bool Start() {
    std::unique_lock lock(mutex_);
    if (thread_.joinable()) return started_;
    thread_ = std::thread([this] { Run(); });
    ready_.wait(lock, [this] { return run_loop_ready_; });
    return started_;
  }

  void Stop() noexcept {
    CFRunLoopRef loop = nullptr;
    {
      std::lock_guard lock(mutex_);
      loop = run_loop_;
    }
    if (loop != nullptr) CFRunLoopStop(loop);
    if (thread_.joinable()) thread_.join();
  }

 private:
  static CGEventRef Callback(CGEventTapProxy, CGEventType type,
                             CGEventRef event, void* context) {
    auto* self = static_cast<InputBlocker*>(context);
    if (type == kCGEventTapDisabledByTimeout ||
        type == kCGEventTapDisabledByUserInput) {
      if (self->tap_ != nullptr) CGEventTapEnable(self->tap_, true);
      return event;
    }
    if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) ==
        kImcodesSyntheticEventMarker) {
      return event;
    }
    return nullptr;  // physical input while curtained: swallowed
  }

  void Run() {
    const CGEventMask mask =
        CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
        CGEventMaskBit(kCGEventFlagsChanged) |
        CGEventMaskBit(kCGEventLeftMouseDown) |
        CGEventMaskBit(kCGEventLeftMouseUp) |
        CGEventMaskBit(kCGEventRightMouseDown) |
        CGEventMaskBit(kCGEventRightMouseUp) |
        CGEventMaskBit(kCGEventOtherMouseDown) |
        CGEventMaskBit(kCGEventOtherMouseUp) |
        CGEventMaskBit(kCGEventMouseMoved) |
        CGEventMaskBit(kCGEventLeftMouseDragged) |
        CGEventMaskBit(kCGEventRightMouseDragged) |
        CGEventMaskBit(kCGEventOtherMouseDragged) |
        CGEventMaskBit(kCGEventScrollWheel);
    tap_ = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap,
                            kCGEventTapOptionDefault, mask, &Callback, this);
    CFRunLoopSourceRef source =
        tap_ != nullptr ? CFMachPortCreateRunLoopSource(nullptr, tap_, 0)
                        : nullptr;
    {
      std::lock_guard lock(mutex_);
      started_ = source != nullptr;
      run_loop_ = started_ ? CFRunLoopGetCurrent() : nullptr;
      run_loop_ready_ = true;
    }
    ready_.notify_all();
    if (source != nullptr) {
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap_, true);
      CFRunLoopRun();
      CGEventTapEnable(tap_, false);
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source,
                            kCFRunLoopCommonModes);
      CFRelease(source);
    }
    if (tap_ != nullptr) {
      CFRelease(tap_);
      tap_ = nullptr;
    }
    std::lock_guard lock(mutex_);
    run_loop_ = nullptr;
  }

  std::mutex mutex_;
  std::condition_variable ready_;
  std::thread thread_;
  CFMachPortRef tap_ = nullptr;
  CFRunLoopRef run_loop_ = nullptr;
  bool run_loop_ready_ = false;
  bool started_ = false;
};

MacosLocalCurtain::MacosLocalCurtain() = default;

MacosLocalCurtain::~MacosLocalCurtain() { Release(); }

bool MacosLocalCurtain::Engage() {
  if (engaged_.load(std::memory_order_acquire)) return true;
  if (!DarkenAllDisplays()) return false;
  input_blocker_ = std::make_unique<InputBlocker>();
  if (!input_blocker_->Start()) {
    // Never leave a Mac dark while its owner could not be stopped from
    // touching it -- and never pretend the curtain is whole.
    input_blocker_.reset();
    CGDisplayRestoreColorSyncSettings();
    return false;
  }
  engaged_.store(true, std::memory_order_release);
  return true;
}

void MacosLocalCurtain::Release() noexcept {
  if (!engaged_.exchange(false, std::memory_order_acquire)) return;
  if (input_blocker_) {
    input_blocker_->Stop();
    input_blocker_.reset();
  }
  CGDisplayRestoreColorSyncSettings();
}

void MacosLocalCurtain::Refresh() noexcept {
  if (engaged_.load(std::memory_order_acquire)) (void)DarkenAllDisplays();
}

}  // namespace imcodes::remote_desktop::macos
