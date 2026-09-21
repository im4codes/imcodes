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


// Port of the Windows host's LocalIndicator (local_indicator.cc): the same
// corner placement, geometry, palette, brand mark, fold control and Stop
// affordance, so an operator sees one product on both platforms. Geometry is
// in points on a flipped (top-left origin) view so the rectangles read exactly
// like the Windows client-area math.
static const CGFloat kIMCodesIndicatorExpandedWidth = 368.0;
static const CGFloat kIMCodesIndicatorExpandedHeight = 148.0;
static const CGFloat kIMCodesIndicatorCollapsedSize = 38.0;
static const CGFloat kIMCodesIndicatorCornerMargin = 14.0;
static const CGFloat kIMCodesIndicatorLogoSize = 20.0;
static NSString *const kIMCodesIndicatorCollapsedKey =
    @"RemoteDesktopIndicatorCollapsed";
// The canonical brand mark (web/public/imcodes-robot-avatar.png), shipped in
// aiDesk.app's Resources by scripts/build-aidesk-app.mjs.
static NSString *const kIMCodesIndicatorLogoResource = @"imcodes-robot-avatar.png";

static NSColor *IMCodesRgb(int r, int g, int b) {
  return [NSColor colorWithSRGBRed:r / 255.0 green:g / 255.0 blue:b / 255.0
                             alpha:1.0];
}

static NSImage *IMCodesIndicatorLogo() {
  static NSImage *logo = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // Helpers/<this executable> -> Contents/Resources/<logo>.
    NSString *executable = [[NSBundle mainBundle] executablePath];
    NSString *contents = [[executable stringByDeletingLastPathComponent]
        stringByDeletingLastPathComponent];
    NSString *path = [[contents stringByAppendingPathComponent:@"Resources"]
        stringByAppendingPathComponent:kIMCodesIndicatorLogoResource];
    logo = [[NSImage alloc] initWithContentsOfFile:path];
  });
  return logo;
}

@class IMCodesLocalDisclosureController;

@interface IMCodesIndicatorView : NSView
@property(nonatomic) BOOL collapsed;
@property(nonatomic) BOOL confirmingStop;
@property(nonatomic) BOOL stopping;
@property(nonatomic) std::uint32_t viewers;
@property(nonatomic) std::uint32_t controllers;
@property(nonatomic, weak) IMCodesLocalDisclosureController *owner;
- (NSRect)collapseRect;
- (NSRect)stopRect;
@end

@interface IMCodesLocalDisclosureController : NSObject <NSWindowDelegate> {
@private
  IMCodesDisclosureEventSink _eventSink;
  std::uint64_t _generation;
  BOOL _suppressCloseEvent;
  NSWindow *_window;
  NSTextField *_viewerLabel;
  NSTextField *_controllerLabel;
  IMCodesIndicatorView *_indicatorView;
}

@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *viewerLabel;
@property(nonatomic, strong) NSTextField *controllerLabel;
@property(nonatomic, strong) IMCodesIndicatorView *indicatorView;

- (void)setEventSink:(IMCodesDisclosureEventSink)sink
          generation:(std::uint64_t)generation;
- (void)stopPressed:(id)sender;
- (void)openManagement;
- (void)applyCollapsed:(BOOL)collapsed persist:(BOOL)persist;
- (void)anchorToCorner;
- (void)hideWithoutEvent;

@end

@implementation IMCodesLocalDisclosureController

@synthesize window = _window;
@synthesize viewerLabel = _viewerLabel;
@synthesize controllerLabel = _controllerLabel;
@synthesize indicatorView = _indicatorView;

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

- (void)openManagement {
  NSURL *url = [NSURL URLWithString:@(imcodes::remote_desktop::common::kLocalManagementUrl)];
  if (url != nil) [[NSWorkspace sharedWorkspace] openURL:url];
}


- (void)applyCollapsed:(BOOL)collapsed persist:(BOOL)persist {
  if (persist) {
    [[NSUserDefaults standardUserDefaults] setBool:collapsed
                                            forKey:kIMCodesIndicatorCollapsedKey];
  }
  _indicatorView.collapsed = collapsed;
  [self anchorToCorner];
  [_indicatorView setNeedsDisplay:YES];
  [_window invalidateCursorRectsForView:_indicatorView];
}

- (void)anchorToCorner {
  if (_window == nil) {
    return;
  }
  const BOOL collapsed = _indicatorView.collapsed;
  const CGFloat width =
      collapsed ? kIMCodesIndicatorCollapsedSize : kIMCodesIndicatorExpandedWidth;
  const CGFloat height =
      collapsed ? kIMCodesIndicatorCollapsedSize : kIMCodesIndicatorExpandedHeight;
  // The screen the operator is looking at: the one holding the pointer.
  NSScreen *screen = nil;
  const NSPoint mouse = [NSEvent mouseLocation];
  for (NSScreen *candidate in [NSScreen screens]) {
    if (NSPointInRect(mouse, candidate.frame)) {
      screen = candidate;
      break;
    }
  }
  if (screen == nil) {
    screen = [NSScreen mainScreen] ?: [[NSScreen screens] firstObject];
  }
  const NSRect visible =
      screen != nil ? screen.visibleFrame : NSMakeRect(0, 0, 1280, 800);
  const NSRect frame = NSMakeRect(
      NSMaxX(visible) - width - kIMCodesIndicatorCornerMargin,
      NSMinY(visible) + kIMCodesIndicatorCornerMargin, width, height);
  [_window setFrame:frame display:YES];
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
  _indicatorView = nil;
  _eventSink = {};
  _generation = 0;
  _suppressCloseEvent = NO;
}

@end

@implementation IMCodesIndicatorView

- (BOOL)isFlipped {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
  (void)event;
  // A non-activating panel never becomes key; without this the first click on
  // the collapsed badge was swallowed and the indicator could not be reopened.
  return YES;
}

- (NSRect)collapseRect {
  const NSRect b = self.bounds;
  return NSMakeRect(NSMaxX(b) - 42.0, 8.0, 34.0, 32.0);
}

- (NSRect)stopRect {
  const NSRect b = self.bounds;
  return NSMakeRect(16.0, NSMaxY(b) - 50.0, NSWidth(b) - 32.0, 36.0);
}

- (void)fillRounded:(NSRect)rect radius:(CGFloat)radius fill:(NSColor *)fill
             border:(NSColor *)border {
  NSBezierPath *path =
      [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(rect, 0.5, 0.5)
                                      xRadius:radius / 2.0
                                      yRadius:radius / 2.0];
  [fill setFill];
  [path fill];
  [border setStroke];
  path.lineWidth = 1.0;
  [path stroke];
}

- (BOOL)drawLogoInRect:(NSRect)rect {
  NSImage *logo = IMCodesIndicatorLogo();
  if (logo == nil) {
    return NO;
  }
  [logo drawInRect:rect
          fromRect:NSZeroRect
         operation:NSCompositingOperationSourceOver
          fraction:1.0
    respectFlipped:YES
             hints:@{NSImageHintInterpolation : @(NSImageInterpolationHigh)}];
  return YES;
}

- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  const NSRect client = self.bounds;
  NSColor *surface = IMCodesRgb(5, 16, 29);
  NSColor *border = IMCodesRgb(50, 196, 255);
  [[NSColor clearColor] setFill];
  NSRectFill(client);
  [self fillRounded:client
             radius:(self.collapsed ? 12.0 : 18.0) * 2.0
               fill:surface
             border:border];

  if (self.collapsed) {
    // Collapsed carries the mark itself; failing that, the original glyph.
    const CGFloat edge = 18.0;
    const CGFloat inset = (kIMCodesIndicatorCollapsedSize - edge) / 2.0;
    if (![self drawLogoInRect:NSMakeRect(inset, inset, edge, edge)]) {
      NSBezierPath *triangle = [NSBezierPath bezierPath];
      [triangle moveToPoint:NSMakePoint(13, 10)];
      [triangle lineToPoint:NSMakePoint(29, 19)];
      [triangle lineToPoint:NSMakePoint(13, 28)];
      [triangle closePath];
      [border setFill];
      [triangle fill];
    }
    return;
  }

  const NSRect logo = NSMakeRect(16.0, 12.0, kIMCodesIndicatorLogoSize,
                                 kIMCodesIndicatorLogoSize);
  if (![self drawLogoInRect:logo]) {
    [border setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSInsetRect(logo, 5.0, 5.0)] fill];
  }

  NSMutableParagraphStyle *truncating = [[NSMutableParagraphStyle alloc] init];
  truncating.lineBreakMode = NSLineBreakByTruncatingTail;
  // Product name spelled out beside the mark, as on Windows.
  NSString *heading = @"aiDesk.to by IM.codes  ·  Remote Desktop";
  [heading drawInRect:NSMakeRect(NSMaxX(logo) + 10.0, 13.0,
                                 NSWidth(client) - NSMaxX(logo) - 10.0 - 50.0,
                                 20.0)
       withAttributes:@{
         NSFontAttributeName : [NSFont systemFontOfSize:14.0
                                                 weight:NSFontWeightSemibold],
         NSForegroundColorAttributeName : IMCodesRgb(227, 247, 255),
         NSParagraphStyleAttributeName : truncating,
       }];

  // Counts only: nothing a requester sends can reach this surface.
  NSString *detail = [NSString
      stringWithFormat:@"%u VIEWING  ·  %u CONTROLLING", self.viewers,
                       self.controllers];
  [detail drawInRect:NSMakeRect(18.0, 50.0, NSWidth(client) - 36.0, 18.0)
      withAttributes:@{
        NSFontAttributeName : [NSFont systemFontOfSize:12.0],
        NSForegroundColorAttributeName : IMCodesRgb(137, 177, 205),
        NSParagraphStyleAttributeName : truncating,
      }];

  const NSRect fold = [self collapseRect];
  [self fillRounded:fold
             radius:20.0
               fill:IMCodesRgb(10, 35, 55)
             border:IMCodesRgb(43, 111, 149)];
  const CGFloat cx = NSMidX(fold);
  const CGFloat cy = NSMidY(fold);
  NSBezierPath *chevron = [NSBezierPath bezierPath];
  [chevron moveToPoint:NSMakePoint(cx - 7.0, cy - 4.0)];
  [chevron lineToPoint:NSMakePoint(cx + 7.0, cy - 4.0)];
  [chevron lineToPoint:NSMakePoint(cx, cy + 5.0)];
  [chevron closePath];
  [IMCodesRgb(119, 213, 255) setFill];
  [chevron fill];

  const NSRect stop = [self stopRect];
  const BOOL stopping = self.stopping;
  const BOOL confirming = self.confirmingStop;
  [self fillRounded:stop
             radius:24.0
               fill:(stopping ? IMCodesRgb(52, 63, 74) : IMCodesRgb(116, 29, 49))
             border:(stopping ? IMCodesRgb(88, 103, 117)
                              : IMCodesRgb(244, 80, 112))];
  NSMutableParagraphStyle *centered = [[NSMutableParagraphStyle alloc] init];
  centered.alignment = NSTextAlignmentCenter;
  centered.lineBreakMode = NSLineBreakByTruncatingTail;
  NSDictionary *buttonText = @{
    NSFontAttributeName : [NSFont systemFontOfSize:12.0 weight:NSFontWeightSemibold],
    NSForegroundColorAttributeName :
        (stopping ? IMCodesRgb(165, 179, 190) : IMCodesRgb(255, 236, 241)),
    NSParagraphStyleAttributeName : centered,
  };
  NSString *label = stopping ? @"STOPPING…"
      : confirming ? @"CONFIRM STOP ALL"
                   : @"STOP ALL REMOTE SESSIONS";
  const CGFloat textHeight = [label sizeWithAttributes:buttonText].height;
  [label drawInRect:NSMakeRect(NSMinX(stop), NSMidY(stop) - textHeight / 2.0,
                               NSWidth(stop), textHeight)
     withAttributes:buttonText];
}

- (void)resetCursorRects {
  if (self.collapsed) {
    [self addCursorRect:self.bounds cursor:[NSCursor pointingHandCursor]];
    return;
  }
  [self addCursorRect:[self collapseRect] cursor:[NSCursor pointingHandCursor]];
  [self addCursorRect:[self stopRect] cursor:[NSCursor pointingHandCursor]];
}

- (void)mouseDown:(NSEvent *)event {
  (void)event;
}

- (void)mouseUp:(NSEvent *)event {
  IMCodesLocalDisclosureController *owner = self.owner;
  if (owner == nil) {
    return;
  }
  if (self.collapsed) {
    [owner openManagement];
    return;
  }
  const NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  if (NSPointInRect(point, [self collapseRect])) {
    [owner applyCollapsed:YES persist:YES];
  } else if (NSPointInRect(point, [self stopRect]) && !self.stopping) {
    if (!self.confirmingStop) {
      self.confirmingStop = YES;
      [self setNeedsDisplay:YES];
      return;
    }
    self.stopping = YES;
    self.confirmingStop = NO;
    [self setNeedsDisplay:YES];
    [owner stopPressed:nil];
  }
}

@end


namespace imcodes::remote_desktop::macos {
namespace {


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
          NSPanel *window = [[NSPanel alloc]
              initWithContentRect:NSMakeRect(0, 0, kIMCodesIndicatorExpandedWidth,
                                             kIMCodesIndicatorExpandedHeight)
                        styleMask:(NSWindowStyleMaskBorderless |
                                   NSWindowStyleMaskNonactivatingPanel)
                          backing:NSBackingStoreBuffered
                            defer:NO];
          if (window == nil || window.contentView == nil) {
            return false;
          }
          window.title = @"aiDesk.to by IM.codes";
          window.level = NSFloatingWindowLevel;
          window.releasedWhenClosed = NO;
          window.hidesOnDeactivate = NO;
          window.opaque = NO;
          window.backgroundColor = [NSColor clearColor];
          window.hasShadow = YES;
          window.becomesKeyOnlyIfNeeded = YES;
          window.collectionBehavior =
              NSWindowCollectionBehaviorCanJoinAllSpaces |
              NSWindowCollectionBehaviorFullScreenAuxiliary |
              NSWindowCollectionBehaviorStationary;
          window.delegate = controller_;

          IMCodesIndicatorView *indicator =
              [[IMCodesIndicatorView alloc] initWithFrame:window.contentView.bounds];
          indicator.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
          indicator.owner = controller_;
          indicator.toolTip = @"aiDesk.to remote desktop is active";
          // Accessibility carries the full disclosure regardless of layout.
          indicator.accessibilityLabel =
              @"aiDesk.to remote desktop is active. This Mac is being viewed or controlled.";
          window.contentView = indicator;

          // Kept for accessibility/state queries; the view draws the counts.
          NSTextField *viewer =
              CreateFixedLabel(@"Viewers: 0", [NSFont systemFontOfSize:12.0]);
          NSTextField *controller = CreateFixedLabel(
              @"Controllers: 0", [NSFont systemFontOfSize:12.0]);

          controller_.window = window;
          controller_.viewerLabel = viewer;
          controller_.controllerLabel = controller;
          controller_.indicatorView = indicator;
          indicator.collapsed = [[NSUserDefaults standardUserDefaults]
              boolForKey:kIMCodesIndicatorCollapsedKey];
        }

        controller_.viewerLabel.stringValue =
            [NSString stringWithFormat:@"Viewers: %u", viewers];
        controller_.controllerLabel.stringValue =
            [NSString stringWithFormat:@"Controllers: %u", controllers];
        controller_.indicatorView.viewers = viewers;
        controller_.indicatorView.controllers = controllers;
        controller_.indicatorView.stopping = NO;
        // Re-anchor on every show: the screen layout may have changed since.
        [controller_ anchorToCorner];
        [controller_.indicatorView setNeedsDisplay:YES];
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
