#include "macos_local_disclosure.h"

#import <AppKit/AppKit.h>

#include <sysexits.h>
#import <Foundation/Foundation.h>

#include <dispatch/dispatch.h>

#include <functional>
#include <mutex>
#include <utility>

using IMCodesDisclosureEventSink =
    imcodes::remote_desktop::macos::MacosDisclosureEventSink;

@interface IMCodesLocalDisclosureController : NSObject <NSWindowDelegate> {
@private
  IMCodesDisclosureEventSink _eventSink;
  std::uint64_t _generation;
  BOOL _suppressCloseEvent;
  NSWindow *_window;
  NSTextField *_viewerLabel;
  NSTextField *_controllerLabel;
}

@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *viewerLabel;
@property(nonatomic, strong) NSTextField *controllerLabel;

- (void)setEventSink:(IMCodesDisclosureEventSink)sink
          generation:(std::uint64_t)generation;
- (void)stopPressed:(id)sender;
- (void)hideWithoutEvent;

@end

@implementation IMCodesLocalDisclosureController

@synthesize window = _window;
@synthesize viewerLabel = _viewerLabel;
@synthesize controllerLabel = _controllerLabel;

- (void)setEventSink:(IMCodesDisclosureEventSink)sink
          generation:(std::uint64_t)generation {
  _eventSink = std::move(sink);
  _generation = generation;
}

- (void)stopPressed:(id)sender {
  (void)sender;
  [_window orderOut:nil];
  IMCodesDisclosureEventSink sink = _eventSink;
  if (sink) {
    sink(imcodes::remote_desktop::macos::MacosDisclosureEvent::kLocalStop,
         _generation);
  }
}

- (void)windowWillClose:(NSNotification *)notification {
  (void)notification;
  if (_suppressCloseEvent) {
    return;
  }
  IMCodesDisclosureEventSink sink = _eventSink;
  if (sink) {
    sink(imcodes::remote_desktop::macos::MacosDisclosureEvent::kWindowClosed,
         _generation);
  }
}

- (void)hideWithoutEvent {
  _suppressCloseEvent = YES;
  [_window orderOut:nil];
  [_window close];
  _window = nil;
  _viewerLabel = nil;
  _controllerLabel = nil;
  _eventSink = {};
  _generation = 0;
  _suppressCloseEvent = NO;
}

@end

namespace imcodes::remote_desktop::macos {
namespace {

constexpr CGFloat kDisclosureWindowWidth = 360.0;
constexpr CGFloat kDisclosureWindowHeight = 190.0;

common::ReadinessState RunReadinessOnMainThreadSync(
    const std::function<common::ReadinessState()> &callback) {
  if ([NSThread isMainThread]) {
    return callback();
  }
  __block common::ReadinessState result = common::ReadinessState::kUnavailable;
  dispatch_sync(dispatch_get_main_queue(), ^{
    result = callback();
  });
  return result;
}

bool RunBoolOnMainThreadSync(const std::function<bool()> &callback) {
  if ([NSThread isMainThread]) {
    return callback();
  }
  __block bool result = false;
  dispatch_sync(dispatch_get_main_queue(), ^{
    result = callback();
  });
  return result;
}

void RunVoidOnMainThreadSync(const std::function<void()> &callback) {
  if ([NSThread isMainThread]) {
    callback();
    return;
  }
  dispatch_sync(dispatch_get_main_queue(), ^{
    callback();
  });
}

NSTextField *CreateFixedLabel(NSString *value, NSFont *font) {
  NSTextField *label = [NSTextField labelWithString:value];
  label.font = font;
  label.textColor = [NSColor labelColor];
  label.selectable = NO;
  label.editable = NO;
  return label;
}

class AppKitLocalDisclosureBackend final : public MacosLocalDisclosureBackend {
public:
  common::ReadinessState ProbeReadiness() noexcept override {
    return RunReadinessOnMainThreadSync([this]() noexcept {
      return controller_ != nil && controller_.window != nil &&
                     controller_.window.visible
                 ? common::ReadinessState::kReady
                 : common::ReadinessState::kUnavailable;
    });
  }

  bool Show(std::uint32_t viewers, std::uint32_t controllers,
            std::uint64_t generation,
            MacosDisclosureEventSink event_sink) noexcept override {
    return RunBoolOnMainThreadSync([this, viewers, controllers, generation,
                                    event_sink =
                                        std::move(event_sink)]() mutable {
      @try {
        if (controller_ == nil) {
          controller_ = [[IMCodesLocalDisclosureController alloc] init];
        }
        [controller_ setEventSink:std::move(event_sink) generation:generation];

        if (controller_.window == nil) {
          const NSRect frame =
              NSMakeRect(0, 0, kDisclosureWindowWidth, kDisclosureWindowHeight);
          NSWindow *window =
              [[NSWindow alloc] initWithContentRect:frame
                                          styleMask:(NSWindowStyleMaskTitled |
                                                     NSWindowStyleMaskClosable)
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
          if (window == nil || window.contentView == nil) {
            return false;
          }
          window.title = @"aiDesk.to by IM.codes";
          window.level = NSFloatingWindowLevel;
          window.releasedWhenClosed = NO;
          window.collectionBehavior =
              NSWindowCollectionBehaviorCanJoinAllSpaces |
              NSWindowCollectionBehaviorFullScreenAuxiliary;
          window.delegate = controller_;

          NSTextField *brand =
              CreateFixedLabel(@"aiDesk.to remote desktop is active",
                               [NSFont boldSystemFontOfSize:17.0]);
          NSTextField *explanation =
              CreateFixedLabel(@"This Mac is being viewed or controlled.",
                               [NSFont systemFontOfSize:13.0]);
          NSTextField *viewer =
              CreateFixedLabel(@"Viewers: 0", [NSFont systemFontOfSize:13.0]);
          NSTextField *controller = CreateFixedLabel(
              @"Controllers: 0", [NSFont systemFontOfSize:13.0]);
          NSButton *stop = [NSButton buttonWithTitle:@"Stop"
                                              target:controller_
                                              action:@selector(stopPressed:)];
          stop.bezelStyle = NSBezelStyleRounded;
          stop.keyEquivalent = @"\r";
          stop.toolTip = @"Stop all aiDesk.to remote desktop sessions";

          NSStackView *stack = [NSStackView stackViewWithViews:@[
            brand, explanation, viewer, controller, stop
          ]];
          stack.orientation = NSUserInterfaceLayoutOrientationVertical;
          stack.alignment = NSLayoutAttributeLeading;
          stack.spacing = 8.0;
          stack.translatesAutoresizingMaskIntoConstraints = NO;
          [window.contentView addSubview:stack];
          [NSLayoutConstraint activateConstraints:@[
            [stack.leadingAnchor
                constraintEqualToAnchor:window.contentView.leadingAnchor
                               constant:20.0],
            [stack.trailingAnchor
                constraintEqualToAnchor:window.contentView.trailingAnchor
                               constant:-20.0],
            [stack.topAnchor
                constraintEqualToAnchor:window.contentView.topAnchor
                               constant:18.0],
            [stack.bottomAnchor
                constraintLessThanOrEqualToAnchor:window.contentView
                                                      .bottomAnchor
                                         constant:-18.0],
          ]];
          controller_.window = window;
          controller_.viewerLabel = viewer;
          controller_.controllerLabel = controller;
        }

        controller_.viewerLabel.stringValue =
            [NSString stringWithFormat:@"Viewers: %u", viewers];
        controller_.controllerLabel.stringValue =
            [NSString stringWithFormat:@"Controllers: %u", controllers];
        [controller_.window center];
        [controller_.window orderFrontRegardless];
        return [controller_.window isVisible] == YES;
      } @catch (NSException *) {
        MacosDisclosureEventSink failure_sink = event_sink;
        if (failure_sink) {
          failure_sink(MacosDisclosureEvent::kWindowFailed, generation);
        }
        return false;
      }
    });
  }

  void Hide() noexcept override {
    RunVoidOnMainThreadSync([this]() noexcept {
      if (controller_ != nil) {
        [controller_ hideWithoutEvent];
        controller_ = nil;
      }
    });
  }

private:
  __strong IMCodesLocalDisclosureController *controller_ = nil;
};

std::unique_ptr<MacosLocalDisclosureBackend> CreateSystemBackend() {
  return std::make_unique<AppKitLocalDisclosureBackend>();
}

struct DisclosureState {
  std::mutex mutex;
  MacosDisclosureStopAllRoutes stop_all_routes;
  bool alive = true;
  bool active = false;
  bool visible = false;
  bool stop_dispatched = false;
  std::uint64_t generation = 0;
};

bool FailClosed(const std::weak_ptr<DisclosureState> &weak_state,
                std::uint64_t generation) noexcept {
  const std::shared_ptr<DisclosureState> state = weak_state.lock();
  if (state == nullptr) {
    return false;
  }

  MacosDisclosureStopAllRoutes stop;
  {
    std::lock_guard lock(state->mutex);
    if (!state->alive || !state->active || state->generation != generation ||
        state->stop_dispatched) {
      return false;
    }
    state->visible = false;
    state->active = false;
    state->stop_dispatched = true;
    stop = state->stop_all_routes;
  }
  if (stop) {
    // Pinned WebRTC compiles this component with -fno-exceptions. The
    // route-stop boundary is required to be non-throwing.
    stop(generation);
  }
  return true;
}

} // namespace

class MacosLocalDisclosureAdapter::Impl {
public:
  Impl(std::unique_ptr<MacosLocalDisclosureBackend> backend,
       MacosDisclosureStopAllRoutes stop_all_routes,
       MacosLocalDisclosureOptions options)
      : backend_(std::move(backend)), options_(NormalizeOptions(options)),
        state_(std::make_shared<DisclosureState>()) {
    state_->stop_all_routes = std::move(stop_all_routes);
  }

  ~Impl() {
    Hide();
    std::lock_guard lock(state_->mutex);
    state_->alive = false;
    state_->stop_all_routes = {};
  }

  bool BeginSession(std::uint64_t generation) {
    if (generation == 0 || backend_ == nullptr) {
      return false;
    }
    bool had_surface = false;
    {
      std::lock_guard lock(state_->mutex);
      if (!state_->stop_all_routes || generation <= state_->generation) {
        return false;
      }
      had_surface = state_->active || state_->visible;
      state_->generation = generation;
      state_->active = true;
      state_->visible = false;
      state_->stop_dispatched = false;
    }
    if (had_surface) {
      backend_->Hide();
    }
    return true;
  }

  common::ReadinessState ProbeReadiness() {
    std::uint64_t generation = 0;
    {
      std::lock_guard lock(state_->mutex);
      if (!state_->alive || !state_->active || !state_->visible) {
        return common::ReadinessState::kUnavailable;
      }
      generation = state_->generation;
    }

    if (backend_->ProbeReadiness() == common::ReadinessState::kReady) {
      std::lock_guard lock(state_->mutex);
      return state_->alive && state_->active && state_->visible &&
                     state_->generation == generation
                 ? common::ReadinessState::kReady
                 : common::ReadinessState::kUnavailable;
    }

    FailClosed(state_, generation);
    backend_->Hide();
    return common::ReadinessState::kUnavailable;
  }

  bool Show(std::uint32_t viewers, std::uint32_t controllers) {
    if (viewers > options_.max_viewers ||
        controllers > options_.max_controllers || controllers > viewers) {
      return false;
    }

    std::uint64_t generation = 0;
    {
      std::lock_guard lock(state_->mutex);
      if (!state_->alive || !state_->active || state_->stop_dispatched) {
        return false;
      }
      generation = state_->generation;
    }

    const std::weak_ptr<DisclosureState> weak_state = state_;
    const bool shown = backend_->Show(
        viewers, controllers, generation,
        [weak_state](MacosDisclosureEvent, std::uint64_t event_generation) {
          FailClosed(weak_state, event_generation);
        });
    if (!shown ||
        backend_->ProbeReadiness() != common::ReadinessState::kReady) {
      FailClosed(state_, generation);
      backend_->Hide();
      return false;
    }

    bool still_current = false;
    {
      std::lock_guard lock(state_->mutex);
      still_current = state_->alive && state_->active &&
                      !state_->stop_dispatched &&
                      state_->generation == generation;
      if (still_current) {
        state_->visible = true;
      }
    }
    if (!still_current) {
      backend_->Hide();
      return false;
    }
    return true;
  }

  void Hide() noexcept {
    bool had_surface = false;
    {
      std::lock_guard lock(state_->mutex);
      had_surface = state_->active || state_->visible;
      state_->active = false;
      state_->visible = false;
      state_->stop_dispatched = true;
    }
    if (had_surface && backend_ != nullptr) {
      backend_->Hide();
    }
  }

  void ReportProcessCrash(std::uint64_t generation) noexcept {
    if (FailClosed(state_, generation) && backend_ != nullptr) {
      backend_->Hide();
    }
  }

  bool IsVisible() const noexcept {
    std::lock_guard lock(state_->mutex);
    return state_->alive && state_->active && state_->visible;
  }

  std::uint64_t generation() const noexcept {
    std::lock_guard lock(state_->mutex);
    return state_->generation;
  }

private:
  static MacosLocalDisclosureOptions
  NormalizeOptions(MacosLocalDisclosureOptions options) noexcept {
    if (options.max_viewers == 0 ||
        options.max_viewers > kMacosDisclosureMaxViewers) {
      options.max_viewers = kMacosDisclosureMaxViewers;
    }
    if (options.max_controllers == 0 ||
        options.max_controllers > kMacosDisclosureMaxControllers) {
      options.max_controllers = kMacosDisclosureMaxControllers;
    }
    return options;
  }

  std::unique_ptr<MacosLocalDisclosureBackend> backend_;
  MacosLocalDisclosureOptions options_;
  std::shared_ptr<DisclosureState> state_;
};

MacosLocalDisclosureAdapter::MacosLocalDisclosureAdapter(
    MacosDisclosureStopAllRoutes stop_all_routes,
    MacosLocalDisclosureOptions options)
    : MacosLocalDisclosureAdapter(CreateSystemBackend(),
                                  std::move(stop_all_routes), options) {}

MacosLocalDisclosureAdapter::MacosLocalDisclosureAdapter(
    std::unique_ptr<MacosLocalDisclosureBackend> backend,
    MacosDisclosureStopAllRoutes stop_all_routes,
    MacosLocalDisclosureOptions options)
    : impl_(std::make_unique<Impl>(std::move(backend),
                                   std::move(stop_all_routes), options)) {}

MacosLocalDisclosureAdapter::~MacosLocalDisclosureAdapter() = default;

bool MacosLocalDisclosureAdapter::BeginSession(std::uint64_t generation) {
  return impl_->BeginSession(generation);
}

void MacosLocalDisclosureAdapter::ReportProcessCrash(
    std::uint64_t generation) noexcept {
  impl_->ReportProcessCrash(generation);
}

bool MacosLocalDisclosureAdapter::IsVisible() const noexcept {
  return impl_->IsVisible();
}

std::uint64_t MacosLocalDisclosureAdapter::generation() const noexcept {
  return impl_->generation();
}

common::ReadinessState MacosLocalDisclosureAdapter::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

bool MacosLocalDisclosureAdapter::Show(std::uint32_t viewers,
                                       std::uint32_t controllers) {
  return impl_->Show(viewers, controllers);
}

void MacosLocalDisclosureAdapter::Hide() noexcept { impl_->Hide(); }

DisclosureStartupOutcome RunDisclosureStartup(
    MacosLocalDisclosureAdapter& adapter,
    std::uint64_t generation,
    std::uint32_t viewers,
    std::uint32_t controllers) noexcept {
  if (!adapter.BeginSession(generation)) {
    return DisclosureStartupOutcome::kBeginSessionFailed;
  }
  if (!adapter.Show(viewers, controllers)) {
    // Show owns fail-closed cleanup for backend refusal and in-Show failure.
    // Hide is idempotent and also covers future Show implementations that
    // reject before acquiring a backend surface.
    adapter.Hide();
    return DisclosureStartupOutcome::kShowFailed;
  }
  if (!adapter.IsVisible()) {
    adapter.Hide();
    return DisclosureStartupOutcome::kNotVisible;
  }
  if (adapter.ProbeReadiness() != common::ReadinessState::kReady) {
    adapter.Hide();
    return DisclosureStartupOutcome::kReadinessLost;
  }
  return DisclosureStartupOutcome::kVisibleAndReady;
}

int RunDisclosureProcessAfterStartup(
    DisclosureStartupOutcome outcome,
    std::uint64_t generation,
    bool probe_only,
    MacosLocalDisclosureAdapter& adapter,
    DisclosureProcessCallbacks callbacks) {
  if (outcome != DisclosureStartupOutcome::kVisibleAndReady) {
    if (callbacks.emit_failed) {
      callbacks.emit_failed(generation);
    }
    return EX_UNAVAILABLE;
  }

  if (probe_only) {
    if (callbacks.report_probe_success) {
      callbacks.report_probe_success();
    }
    adapter.Hide();
    return EX_OK;
  }

  if (!callbacks.emit_ready || !callbacks.emit_ready(generation)) {
    adapter.Hide();
    return EX_IOERR;
  }
  if (!callbacks.run_visible_loop) {
    adapter.Hide();
    return EX_IOERR;
  }
  const int exit_code = callbacks.run_visible_loop();
  adapter.Hide();
  return exit_code;
}

} // namespace imcodes::remote_desktop::macos
