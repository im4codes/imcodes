#include "cg_event_input_adapter.h"

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <mutex>
#include <optional>
#include <ranges>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "../remote-desktop-common/input_ledger.h"

namespace imcodes::remote_desktop::macos {

namespace {

constexpr std::size_t kMaximumTextCodeUnits = common::kMaximumInputTextBytes;

bool SameRect(const common::LogicalRect &left,
              const common::LogicalRect &right) noexcept {
  return left.x == right.x && left.y == right.y && left.width == right.width &&
         left.height == right.height;
}

bool Contains(const common::LogicalRect &bounds,
              const common::LogicalPoint &point) noexcept {
  const double maximum_x = bounds.x + bounds.width;
  const double maximum_y = bounds.y + bounds.height;
  return std::isfinite(point.x) && std::isfinite(point.y) &&
         std::isfinite(maximum_x) && std::isfinite(maximum_y) &&
         point.x >= bounds.x && point.y >= bounds.y && point.x <= maximum_x &&
         point.y <= maximum_y;
}

std::uint64_t MonotonicMilliseconds() noexcept {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

std::optional<CGKeyCode> MapKey(std::string_view code) {
  // These are the stable virtual key codes published by HIToolbox Events.h.
  // Keeping the table here avoids exposing Carbon/CGEvent types through the
  // adapter header and mirrors the browser's physical KeyboardEvent.code.
  // A constexpr table rather than a function-local `static const std::map`.
  //
  // That map had a non-trivial destructor, so it was an exit-time destructor:
  // it runs during process teardown, in an order nothing controls, after
  // threads that may still touch it have not necessarily stopped. Chromium
  // bans the construct outright and the build asks for `-Werror
  // -Wexit-time-destructors` -- but that flag was being swallowed by a
  // malformed plugin argument in the SDK's recorded flags, so nothing said so.
  //
  // Sorted, and the sorting is asserted at compile time rather than trusted,
  // because the binary search below silently returns the wrong key code for an
  // out-of-order entry instead of failing.
  static constexpr std::array<std::pair<std::string_view, CGKeyCode>, 43> kNamedKeys = {{
      {"AltLeft", 58},
      {"AltRight", 61},
      {"ArrowDown", 125},
      {"ArrowLeft", 123},
      {"ArrowRight", 124},
      {"ArrowUp", 126},
      {"Backquote", 50},
      {"Backslash", 42},
      {"Backspace", 51},
      {"BracketLeft", 33},
      {"BracketRight", 30},
      {"CapsLock", 57},
      {"Comma", 43},
      {"ControlLeft", 59},
      {"ControlRight", 62},
      {"Delete", 117},
      {"End", 119},
      {"Enter", 36},
      {"Equal", 24},
      {"Escape", 53},
      // Fn (Globe). Never sent by a viewer; the adapter only ever releases it,
      // clearing the Fn state an injected arrow key leaves latched.
      {"Fn", 63},
      {"Home", 115},
      {"Insert", 114},
      {"MetaLeft", 55},
      {"MetaRight", 54},
      {"Minus", 27},
      {"NumLock", 71},
      {"NumpadAdd", 69},
      {"NumpadDecimal", 65},
      {"NumpadDivide", 75},
      {"NumpadEnter", 76},
      {"NumpadMultiply", 67},
      {"NumpadSubtract", 78},
      {"PageDown", 121},
      {"PageUp", 116},
      {"Period", 47},
      {"Quote", 39},
      {"Semicolon", 41},
      {"ShiftLeft", 56},
      {"ShiftRight", 60},
      {"Slash", 44},
      {"Space", 49},
      {"Tab", 48},
  }};
  static_assert(std::ranges::is_sorted(kNamedKeys, {}, &std::pair<std::string_view, CGKeyCode>::first),
                "kNamedKeys must be sorted for the binary search below");
  static constexpr CGKeyCode kLetterCodes[] = {
      0,  11, 8,  2,  14, 3, 5,  4,  34, 38, 40, 37, 46,
      45, 31, 35, 12, 15, 1, 17, 32, 9,  13, 7,  16, 6,
  };
  static constexpr CGKeyCode kDigitCodes[] = {
      29, 18, 19, 20, 21, 23, 22, 26, 28, 25,
  };
  static constexpr CGKeyCode kNumpadCodes[] = {
      82, 83, 84, 85, 86, 87, 88, 89, 91, 92,
  };
  static constexpr CGKeyCode kFunctionCodes[] = {
      122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111,
  };

  if (code.size() == 4 && code.starts_with("Key") && code[3] >= 'A' &&
      code[3] <= 'Z') {
    return kLetterCodes[code[3] - 'A'];
  }
  if (code.size() == 6 && code.starts_with("Digit") && code[5] >= '0' &&
      code[5] <= '9') {
    return kDigitCodes[code[5] - '0'];
  }
  if (code.size() == 7 && code.starts_with("Numpad") && code[6] >= '0' &&
      code[6] <= '9') {
    return kNumpadCodes[code[6] - '0'];
  }
  if (code.size() >= 2 && code.size() <= 3 && code[0] == 'F' &&
      code[1] >= '0' && code[1] <= '9') {
    int number = 0;
    for (std::size_t index = 1; index < code.size(); ++index) {
      if (code[index] < '0' || code[index] > '9')
        return std::nullopt;
      number = number * 10 + (code[index] - '0');
    }
    if (number >= 1 && number <= 12)
      return kFunctionCodes[number - 1];
  }

  const auto found = std::ranges::lower_bound(
      kNamedKeys, code, {}, &std::pair<std::string_view, CGKeyCode>::first);
  return found == kNamedKeys.end() || found->first != code
             ? std::nullopt
             : std::optional<CGKeyCode>(found->second);
}

struct MouseMapping {
  CGMouseButton button;
  CGEventType down;
  CGEventType up;
};

std::optional<MouseMapping> MapButton(std::string_view button) {
  if (button == "left") {
    return MouseMapping{kCGMouseButtonLeft, kCGEventLeftMouseDown,
                        kCGEventLeftMouseUp};
  }
  if (button == "right") {
    return MouseMapping{kCGMouseButtonRight, kCGEventRightMouseDown,
                        kCGEventRightMouseUp};
  }
  if (button == "middle") {
    return MouseMapping{kCGMouseButtonCenter, kCGEventOtherMouseDown,
                        kCGEventOtherMouseUp};
  }
  if (button == "back") {
    return MouseMapping{static_cast<CGMouseButton>(3), kCGEventOtherMouseDown,
                        kCGEventOtherMouseUp};
  }
  if (button == "forward") {
    return MouseMapping{static_cast<CGMouseButton>(4), kCGEventOtherMouseDown,
                        kCGEventOtherMouseUp};
  }
  return std::nullopt;
}

// The mask plus NX_DEVICE*KEYMASK side bits CGEvent carries for each
// modifier, parallel to common::kLatchableModifiers.
struct ModifierBits {
  CGEventFlags mask;
  std::uint64_t left;
  std::uint64_t right;
};
constexpr ModifierBits kModifierBits[common::kLatchableModifierCount] = {
    {kCGEventFlagMaskControl, 0x00000001, 0x00002000},
    {kCGEventFlagMaskShift, 0x00000002, 0x00000004},
    {kCGEventFlagMaskAlternate, 0x00000020, 0x00000040},
    {kCGEventFlagMaskCommand, 0x00000008, 0x00000010},
};

// kVK_Function.
constexpr CGKeyCode kFunctionKeyCode = 63;

// Fn (Globe), numeric pad and Help: set by the keyboard itself on particular
// keys, never a state an injected event may inherit.
constexpr std::uint64_t kKeyIntrinsicFlags =
    kCGEventFlagMaskSecondaryFn | kCGEventFlagMaskNumericPad |
    kCGEventFlagMaskHelp;

// What a real Mac keyboard puts on this key's own events.
std::uint64_t IntrinsicKeyFlags(std::string_view key) noexcept {
  if (key == "ArrowLeft" || key == "ArrowRight" || key == "ArrowUp" ||
      key == "ArrowDown") {
    return kCGEventFlagMaskSecondaryFn | kCGEventFlagMaskNumericPad;
  }
  if (key == "Home" || key == "End" || key == "PageUp" || key == "PageDown" ||
      key == "Delete" || key == "Insert") {
    return kCGEventFlagMaskSecondaryFn;
  }
  if (key.size() >= 2 && key.size() <= 3 && key[0] == 'F' && key[1] >= '1' &&
      key[1] <= '9') {
    return kCGEventFlagMaskSecondaryFn;
  }
  if (key.starts_with("Numpad") || key == "NumLock")
    return kCGEventFlagMaskNumericPad;
  return 0;
}

} // namespace

std::uint64_t ComposeInjectedModifierFlags(
    std::uint64_t event_flags,
    const std::vector<std::string> &held_modifier_keys,
    std::string_view key) noexcept {
  std::uint64_t flags = event_flags & ~kKeyIntrinsicFlags;
  flags |= IntrinsicKeyFlags(key);
  for (const ModifierBits &bits : kModifierBits)
    flags &= ~(static_cast<std::uint64_t>(bits.mask) | bits.left | bits.right);
  for (std::size_t index = 0; index < common::kLatchableModifierCount; ++index) {
    const common::LatchableModifier &modifier = common::kLatchableModifiers[index];
    const ModifierBits &bits = kModifierBits[index];
    for (const std::string &held : held_modifier_keys) {
      if (held == modifier.left)
        flags |= static_cast<std::uint64_t>(bits.mask) | bits.left;
      else if (held == modifier.right)
        flags |= static_cast<std::uint64_t>(bits.mask) | bits.right;
    }
  }
  return flags;
}

namespace {

std::optional<CGPoint> CurrentPointerLocation() {
  CGEventRef current = CGEventCreate(nullptr);
  if (current == nullptr)
    return std::nullopt;
  const CGPoint location = CGEventGetLocation(current);
  CFRelease(current);
  return location;
}

class SystemCGEventInputBackend final : public CGEventInputBackend {
public:
  common::ReadinessState ProbeAccessibility() noexcept override {
    // Non-interactive by design. The LaunchAgent's local onboarding owns any
    // prompt; a remote route can only observe current trust.
    return AXIsProcessTrusted() ? common::ReadinessState::kReady
                                : common::ReadinessState::kUnavailable;
  }

  // The window server's own view of the modifier keys, including whatever a
  // dead worker left behind. The device-dependent bits name the side; a
  // modifier reported without one is released on the left key, which is what
  // the OS reports for a synthetic press that named neither.
  std::vector<std::string> LatchedModifierKeys() override {
    if (!AXIsProcessTrusted())
      return {};
    const CGEventFlags flags =
        CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    std::vector<std::string> latched = common::CollectLatchedModifiers(
        [flags](const common::LatchableModifier &, std::size_t index) {
          const ModifierBits &bits = kModifierBits[index];
          return common::ModifierHeldSides{(flags & bits.mask) != 0,
                                           (flags & bits.left) != 0,
                                           (flags & bits.right) != 0};
        });
    // Fn (Globe) latches too: an injected arrow key sets it (arrows carry Fn
    // on a real keyboard) and its own key-up leaves it set, so the next
    // letter becomes Fn+letter. A Fn key-up clears it, as a physical Fn
    // press would.
    if ((flags & kCGEventFlagMaskSecondaryFn) != 0)
      latched.emplace_back("Fn");
    return latched;
  }

  bool MovePointer(const common::LogicalPoint &point) override {
    if (!AXIsProcessTrusted())
      return false;
    // With a button held the system expects a drag, not a move: a window,
    // selection or slider only follows ...MouseDragged events.
    CGEventType type = kCGEventMouseMoved;
    CGMouseButton button = kCGMouseButtonLeft;
    if (!held_buttons_.empty()) {
      const auto mapping = MapButton(*held_buttons_.begin());
      if (mapping) {
        button = mapping->button;
        type = mapping->button == kCGMouseButtonLeft    ? kCGEventLeftMouseDragged
               : mapping->button == kCGMouseButtonRight ? kCGEventRightMouseDragged
                                                        : kCGEventOtherMouseDragged;
      }
    }
    CGEventRef event = CGEventCreateMouseEvent(nullptr, type,
                                               CGPointMake(point.x, point.y),
                                               button);
    if (event != nullptr && type != kCGEventMouseMoved)
      CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count_);
    return Post(event, {});
  }

  bool EmitKey(std::string_view key, bool pressed) override {
    if (!AXIsProcessTrusted())
      return false;
    const auto key_code = MapKey(key);
    if (!key_code)
      return false;
    if (common::IsLatchableModifierKey(key)) {
      if (pressed)
        held_modifiers_.insert(std::string(key));
      else
        held_modifiers_.erase(std::string(key));
    }
    CGEventRef event = CGEventCreateKeyboardEvent(nullptr, *key_code, pressed);
    if (!Post(event, key))
      return false;
    // An arrow, navigation, F- or keypad key carries Fn/numeric-pad on a real
    // keyboard, and the window server keeps that state after the key's own
    // key-up. Release it now, the way a physical Fn press would, so neither
    // the next injected key nor someone typing at the Mac inherits it.
    if (!pressed && IntrinsicKeyFlags(key) != 0)
      Post(CGEventCreateKeyboardEvent(nullptr, kFunctionKeyCode, false), "Fn");
    return true;
  }

  bool EmitButton(std::string_view button, bool pressed) override {
    if (!AXIsProcessTrusted())
      return false;
    const auto mapping = MapButton(button);
    if (!mapping)
      return false;
    const auto location = CurrentPointerLocation();
    if (!location)
      return false;
    // macOS does not derive double-clicks from timing the way Windows does:
    // an application sees one only when the event itself carries a click
    // count. Count consecutive presses of the same button that land within the
    // system double-click interval and a few points of the previous press,
    // and stamp the count on both the press and its release.
    const std::string name(button);
    if (pressed) {
      const auto now = std::chrono::steady_clock::now();
      // The user's own System Settings value (what NSEvent.doubleClickInterval
      // reports), read without pulling AppKit into the input adapter.
      double interval = [[NSUserDefaults standardUserDefaults]
          doubleForKey:@"com.apple.mouse.doubleClickThreshold"];
      if (!(interval > 0.0 && interval <= 5.0))
        interval = 0.5;
      const bool continues =
          click_count_ > 0 && name == last_click_button_ &&
          std::chrono::duration<double>(now - last_click_time_).count() <= interval &&
          std::hypot(location->x - last_click_location_.x,
                     location->y - last_click_location_.y) <= kClickSlopPoints;
      click_count_ = continues ? click_count_ + 1 : 1;
      last_click_button_ = name;
      last_click_time_ = now;
      last_click_location_ = *location;
      held_buttons_.insert(name);
    } else {
      held_buttons_.erase(name);
    }
    CGEventRef event =
        CGEventCreateMouseEvent(nullptr, pressed ? mapping->down : mapping->up,
                                *location, mapping->button);
    if (event != nullptr)
      CGEventSetIntegerValueField(event, kCGMouseEventClickState,
                                  name == last_click_button_ ? click_count_ : 1);
    return Post(event, {});
  }

  bool EmitWheel(double delta_x, double delta_y) override {
    if (!AXIsProcessTrusted())
      return false;
    // delta_y arrives in DOM WheelEvent convention: positive means the
    // operator scrolled toward later/lower content (content moves up).
    // CGEventCreateScrollWheelEvent's vertical wheel count is the opposite
    // sign -- positive scrolls UP (toward earlier/higher content), the same
    // convention as Win32's MOUSEEVENTF_WHEEL, which the Windows backend
    // already negates for exactly this reason (input_injector.cc). This
    // backend was missing the equivalent negation, so every vertical scroll
    // sent to a macOS target came out inverted.
    const auto vertical = static_cast<std::int32_t>(std::llround(-delta_y));
    const auto horizontal = static_cast<std::int32_t>(std::llround(delta_x));
    if (vertical == 0 && horizontal == 0)
      return true;
    CGEventRef event = CGEventCreateScrollWheelEvent(
        nullptr, kCGScrollEventUnitPixel, 2, vertical, horizontal);
    return Post(event, {});
  }

  bool EmitText(std::string_view text) override {
    @autoreleasepool {
      if (!AXIsProcessTrusted())
        return false;
      NSString *value = [[NSString alloc] initWithBytes:text.data()
                                                 length:text.size()
                                               encoding:NSUTF8StringEncoding];
      if (value == nil || value.length == 0 ||
          value.length > kMaximumTextCodeUnits) {
        return false;
      }
      std::vector<UniChar> code_units(value.length);
      [value getCharacters:code_units.data()
                     range:NSMakeRange(0, value.length)];
      CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 0, true);
      CGEventRef up = CGEventCreateKeyboardEvent(nullptr, 0, false);
      if (down == nullptr || up == nullptr) {
        if (down != nullptr)
          CFRelease(down);
        if (up != nullptr)
          CFRelease(up);
        return false;
      }
      CGEventKeyboardSetUnicodeString(down, code_units.size(),
                                      code_units.data());
      // Text is never a shortcut: carry no modifier at all, whatever the
      // window server currently reports as held.
      CGEventSetFlags(down, ComposeInjectedModifierFlags(CGEventGetFlags(down), {}, {}));
      CGEventSetFlags(up, ComposeInjectedModifierFlags(CGEventGetFlags(up), {}, {}));
      CGEventSetIntegerValueField(down, kCGEventSourceUserData,
                                  kImcodesSyntheticEventMarker);
      CGEventSetIntegerValueField(up, kCGEventSourceUserData,
                                  kImcodesSyntheticEventMarker);
      CGEventPost(kCGHIDEventTap, down);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(down);
      CFRelease(up);
      return true;
    }
  }

private:
  bool Post(CGEventRef event, std::string_view key) {
    if (event == nullptr)
      return false;
    // An event created without a source copies the window server's current
    // modifier flags. Once any modifier is latched there (a key-up that never
    // arrived, or the Fn state an injected arrow key leaves behind), every
    // later letter would be a shortcut -- Fn+E opens the emoji picker -- and
    // every click a modified click. Stamp what this session actually holds
    // and what this key itself carries instead of inheriting the global state.
    CGEventSetFlags(event, ComposeInjectedModifierFlags(
                               CGEventGetFlags(event),
                               std::vector<std::string>(held_modifiers_.begin(),
                                                        held_modifiers_.end()),
                               key));
    CGEventSetIntegerValueField(event, kCGEventSourceUserData,
                                kImcodesSyntheticEventMarker);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return true;
  }

  // A human hand never lands two clicks on the exact same point.
  static constexpr double kClickSlopPoints = 4.0;
  std::set<std::string> held_modifiers_;
  std::set<std::string> held_buttons_;
  std::string last_click_button_;
  std::chrono::steady_clock::time_point last_click_time_{};
  CGPoint last_click_location_{};
  std::int64_t click_count_ = 0;
};

} // namespace

class CGEventInputAdapter::Impl {
public:
  Impl(common::WorkerGeneration worker_generation,
       std::unique_ptr<CGEventInputBackend> backend)
      : worker_generation_(worker_generation), backend_(std::move(backend)) {}

  bool BindTopology(const common::DesktopTopology &topology,
                    std::string_view display_id) {
    std::lock_guard lock(mutex_);
    if (worker_generation_ == 0 || !topology.IsValid() ||
        topology.generation != worker_generation_) {
      SetError(CGEventInputErrorCode::kInvalidTopology,
               "topology generation does not match this worker");
      ++statistics_.rejected_topology_events;
      return false;
    }
    const common::DisplayTopology *display =
        topology.FindDisplay(std::string(display_id));
    const double maximum_x = display == nullptr
                                 ? 0.0
                                 : display->logical_input_bounds.x +
                                       display->logical_input_bounds.width;
    const double maximum_y = display == nullptr
                                 ? 0.0
                                 : display->logical_input_bounds.y +
                                       display->logical_input_bounds.height;
    if (display == nullptr || display->generation != worker_generation_ ||
        !display->logical_input_bounds.IsValid() || !std::isfinite(maximum_x) ||
        !std::isfinite(maximum_y)) {
      SetError(CGEventInputErrorCode::kInvalidTopology,
               "selected display is absent or has invalid logical bounds");
      ++statistics_.rejected_topology_events;
      return false;
    }
    if (topology_bound_ && topology.revision < topology_revision_) {
      SetError(CGEventInputErrorCode::kStaleTopology,
               "topology revision regressed");
      ++statistics_.rejected_topology_events;
      return false;
    }
    if (topology_bound_ && topology.revision == topology_revision_) {
      if (display_id_ != display->display_id ||
          !SameRect(logical_bounds_, display->logical_input_bounds)) {
        SetError(CGEventInputErrorCode::kStaleTopology,
                 "topology revision was reused with different input bounds");
        ++statistics_.rejected_topology_events;
        return false;
      }
      return true;
    }
    // A session begins on a clean keyboard. Whatever the window server still
    // holds down that this adapter never emitted was left by something it no
    // longer tracks -- a worker killed mid-press, a route lost between a
    // modifier's down and its up -- and on macOS a latched Control makes
    // every click a right-click for as long as it lasts (which, without
    // this, is until the Mac restarts). Before the release below, so this
    // adapter's own held keys stay with the path that tracks them.
    ReleaseLatchedModifiersLocked();
    if (!ReleaseAllLocked()) {
      SetError(CGEventInputErrorCode::kEmissionFailed,
               "held input could not be released before topology change");
      return false;
    }
    topology_bound_ = true;
    topology_revision_ = topology.revision;
    display_id_ = display->display_id;
    logical_bounds_ = display->logical_input_bounds;
    last_error_ = {};
    return true;
  }

  common::ReadinessState ProbeReadiness() {
    std::lock_guard lock(mutex_);
    const common::ReadinessState readiness = backend_->ProbeAccessibility();
    if (readiness != common::ReadinessState::kReady) {
      ++statistics_.rejected_permission_events;
      SetError(CGEventInputErrorCode::kPermissionDenied,
               "Accessibility trust is not currently granted");
      ReleaseAllLocked();
      topology_bound_ = false;
      topology_revision_ = 0;
      display_id_.clear();
      logical_bounds_ = {};
    } else if (release_pending_ && !ReleaseAllLocked()) {
      SetError(CGEventInputErrorCode::kEmissionFailed,
               "held input release is still pending after permission recovery");
      return common::ReadinessState::kUnavailable;
    } else if (last_error_.code == CGEventInputErrorCode::kPermissionDenied ||
               last_error_.code == CGEventInputErrorCode::kEmissionFailed) {
      last_error_ = {};
    }
    return readiness;
  }

  bool MovePointer(const common::LogicalPoint &point) {
    std::lock_guard lock(mutex_);
    if (!ReadyForEmissionLocked())
      return false;
    if (!Contains(logical_bounds_, point)) {
      ++statistics_.rejected_topology_events;
      SetError(CGEventInputErrorCode::kOutOfBounds,
               "pointer is outside the selected display logical bounds");
      return false;
    }
    if (!backend_->MovePointer(point))
      return EmissionFailure("pointer");
    ++statistics_.emitted_pointer_moves;
    last_error_ = {};
    return true;
  }

  bool EmitKey(std::string_view key, bool pressed) {
    std::lock_guard lock(mutex_);
    return EmitKeyLocked(key, pressed);
  }

  bool EmitClipboardShortcut(std::string_view key,
                             std::uint64_t deadline_monotonic_ms) {
    std::lock_guard lock(mutex_);
    if ((key != "KeyC" && key != "KeyV") ||
        deadline_monotonic_ms <= MonotonicMilliseconds() ||
        !ReadyForEmissionLocked()) {
      return false;
    }
    const auto within_deadline = [deadline_monotonic_ms] {
      return MonotonicMilliseconds() < deadline_monotonic_ms;
    };
    if (!EmitKeyLocked("MetaLeft", true) || !within_deadline() ||
        !EmitKeyLocked(key, true) || !within_deadline() ||
        !EmitKeyLocked(key, false) || !within_deadline() ||
        !EmitKeyLocked("MetaLeft", false)) {
      (void)ReleaseAllLocked();
      return false;
    }
    return true;
  }

  bool EmitKeyLocked(std::string_view key, bool pressed) {
    if (!ReadyForEmissionLocked())
      return false;
    if (pressed && emitted_keys_.contains(std::string(key)))
      return true;
    if (!pressed && !emitted_keys_.contains(std::string(key)))
      return true;
    if (!backend_->EmitKey(key, pressed))
      return EmissionFailure("key");
    if (pressed) {
      emitted_keys_.insert(std::string(key));
    } else {
      emitted_keys_.erase(std::string(key));
      if (emitted_keys_.empty() && emitted_buttons_.empty())
        release_pending_ = false;
    }
    ++statistics_.emitted_key_transitions;
    last_error_ = {};
    return true;
  }

  bool EmitButton(std::string_view button, bool pressed) {
    std::lock_guard lock(mutex_);
    if (!ReadyForEmissionLocked())
      return false;
    if (pressed && emitted_buttons_.contains(std::string(button)))
      return true;
    if (!pressed && !emitted_buttons_.contains(std::string(button)))
      return true;
    if (!backend_->EmitButton(button, pressed)) {
      return EmissionFailure("button");
    }
    if (pressed) {
      emitted_buttons_.insert(std::string(button));
    } else {
      emitted_buttons_.erase(std::string(button));
      if (emitted_keys_.empty() && emitted_buttons_.empty())
        release_pending_ = false;
    }
    ++statistics_.emitted_button_transitions;
    last_error_ = {};
    return true;
  }

  bool EmitWheel(double delta_x, double delta_y) {
    std::lock_guard lock(mutex_);
    if (!ReadyForEmissionLocked())
      return false;
    if (!std::isfinite(delta_x) || !std::isfinite(delta_y) ||
        std::abs(delta_x) > common::kMaximumWheelDelta ||
        std::abs(delta_y) > common::kMaximumWheelDelta) {
      SetError(CGEventInputErrorCode::kUnsupportedInput,
               "wheel delta is not finite or exceeds the common bound");
      return false;
    }
    if (!backend_->EmitWheel(delta_x, delta_y)) {
      return EmissionFailure("wheel");
    }
    ++statistics_.emitted_wheel_events;
    last_error_ = {};
    return true;
  }

  bool EmitText(std::string_view text) {
    std::lock_guard lock(mutex_);
    if (!ReadyForEmissionLocked())
      return false;
    if (text.empty() || text.size() > common::kMaximumInputTextBytes) {
      SetError(CGEventInputErrorCode::kUnsupportedInput,
               "text is empty or exceeds the common byte bound");
      return false;
    }
    if (!backend_->EmitText(text))
      return EmissionFailure("text");
    ++statistics_.emitted_text_events;
    last_error_ = {};
    return true;
  }

  void ReleaseAllEmittedState() noexcept {
    std::lock_guard lock(mutex_);
    ReleaseAllLocked();
  }

  std::size_t ReleaseLatchedModifiers() noexcept {
    std::lock_guard lock(mutex_);
    // Only while a session is bound: the same readiness that gates every
    // ordinary emission (topology and Accessibility trust).
    if (!topology_bound_ ||
        backend_->ProbeAccessibility() != common::ReadinessState::kReady)
      return 0;
    const std::uint64_t before = statistics_.released_latched_modifiers;
    ReleaseLatchedModifiersLocked();
    return static_cast<std::size_t>(statistics_.released_latched_modifiers - before);
  }

  void HandleLifecycleBoundary(CGEventInputReleaseReason reason) noexcept {
    std::lock_guard lock(mutex_);
    (void)reason;
    ReleaseAllLocked();
    topology_bound_ = false;
    topology_revision_ = 0;
    display_id_.clear();
    logical_bounds_ = {};
  }

  common::TopologyRevision topology_revision() const noexcept {
    std::lock_guard lock(mutex_);
    return topology_revision_;
  }

  CGEventInputError LastError() const {
    std::lock_guard lock(mutex_);
    return last_error_;
  }

  CGEventInputStatistics Statistics() const {
    std::lock_guard lock(mutex_);
    CGEventInputStatistics result = statistics_;
    result.emitted_keys = emitted_keys_.size();
    result.emitted_buttons = emitted_buttons_.size();
    return result;
  }

private:
  bool ReadyForEmissionLocked() {
    if (!topology_bound_) {
      ++statistics_.rejected_topology_events;
      SetError(CGEventInputErrorCode::kNoActiveTopology,
               "input requires a current selected-display topology");
      return false;
    }
    if (backend_->ProbeAccessibility() != common::ReadinessState::kReady) {
      ++statistics_.rejected_permission_events;
      SetError(CGEventInputErrorCode::kPermissionDenied,
               "Accessibility trust was revoked");
      ReleaseAllLocked();
      topology_bound_ = false;
      topology_revision_ = 0;
      display_id_.clear();
      logical_bounds_ = {};
      return false;
    }
    return true;
  }

  // Releases modifiers held by nobody this adapter knows of. Its own emitted
  // keys are left to ReleaseAllLocked, which also keeps its bookkeeping
  // straight; a failure here is not fatal to the session that is starting.
  void ReleaseLatchedModifiersLocked() noexcept {
    statistics_.released_latched_modifiers += common::ReleaseLatchedModifiers(
        backend_->LatchedModifierKeys(),
        [this](const std::string &key) { return emitted_keys_.contains(key); },
        [this](const std::string &key) {
          return backend_->EmitKey(key, false);
        });
  }

  bool ReleaseAllLocked() noexcept {
    if (emitted_keys_.empty() && emitted_buttons_.empty()) {
      release_pending_ = false;
      return true;
    }
    ++statistics_.release_attempts;
    bool released = true;
    for (auto current = emitted_keys_.begin();
         current != emitted_keys_.end();) {
      if (backend_->EmitKey(*current, false)) {
        ++statistics_.emitted_key_transitions;
        current = emitted_keys_.erase(current);
      } else {
        ++statistics_.release_failures;
        released = false;
        ++current;
      }
    }
    for (auto current = emitted_buttons_.begin();
         current != emitted_buttons_.end();) {
      if (backend_->EmitButton(*current, false)) {
        ++statistics_.emitted_button_transitions;
        current = emitted_buttons_.erase(current);
      } else {
        ++statistics_.release_failures;
        released = false;
        ++current;
      }
    }
    release_pending_ = !released;
    return released;
  }

  bool EmissionFailure(std::string_view operation) {
    SetError(CGEventInputErrorCode::kEmissionFailed,
             std::string("CGEvent ") + std::string(operation) +
                 " emission failed or the token is unsupported");
    return false;
  }

  void SetError(CGEventInputErrorCode code, std::string detail) {
    last_error_ = {code, std::move(detail)};
  }

  const common::WorkerGeneration worker_generation_;
  std::unique_ptr<CGEventInputBackend> backend_;
  mutable std::mutex mutex_;
  bool topology_bound_ = false;
  common::TopologyRevision topology_revision_ = 0;
  std::string display_id_;
  common::LogicalRect logical_bounds_;
  std::set<std::string> emitted_keys_;
  std::set<std::string> emitted_buttons_;
  bool release_pending_ = false;
  CGEventInputError last_error_;
  CGEventInputStatistics statistics_;
};

CGEventInputAdapter::CGEventInputAdapter(
    common::WorkerGeneration worker_generation)
    : CGEventInputAdapter(worker_generation,
                          std::make_unique<SystemCGEventInputBackend>()) {}

CGEventInputAdapter::CGEventInputAdapter(
    common::WorkerGeneration worker_generation,
    std::unique_ptr<CGEventInputBackend> backend)
    : impl_(std::make_unique<Impl>(
          worker_generation,
          backend ? std::move(backend)
                  : std::make_unique<SystemCGEventInputBackend>())) {}

CGEventInputAdapter::~CGEventInputAdapter() {
  impl_->HandleLifecycleBoundary(CGEventInputReleaseReason::kShutdown);
}

bool CGEventInputAdapter::BindTopology(const common::DesktopTopology &topology,
                                       std::string_view display_id) {
  return impl_->BindTopology(topology, display_id);
}

common::ReadinessState CGEventInputAdapter::ProbeReadiness() {
  return impl_->ProbeReadiness();
}

bool CGEventInputAdapter::MovePointer(const common::LogicalPoint &point) {
  return impl_->MovePointer(point);
}

bool CGEventInputAdapter::EmitKey(std::string_view key, bool pressed) {
  return impl_->EmitKey(key, pressed);
}

bool CGEventInputAdapter::EmitButton(std::string_view button, bool pressed) {
  return impl_->EmitButton(button, pressed);
}

bool CGEventInputAdapter::EmitWheel(double delta_x, double delta_y) {
  return impl_->EmitWheel(delta_x, delta_y);
}

bool CGEventInputAdapter::EmitText(std::string_view text) {
  return impl_->EmitText(text);
}

bool CGEventInputAdapter::EmitClipboardShortcut(
    std::string_view key, std::uint64_t deadline_monotonic_ms) {
  return impl_->EmitClipboardShortcut(key, deadline_monotonic_ms);
}

void CGEventInputAdapter::ReleaseAllEmittedState() noexcept {
  impl_->ReleaseAllEmittedState();
}

std::size_t CGEventInputAdapter::ReleaseLatchedModifiers() noexcept {
  return impl_->ReleaseLatchedModifiers();
}

void CGEventInputAdapter::HandleLifecycleBoundary(
    CGEventInputReleaseReason reason) noexcept {
  impl_->HandleLifecycleBoundary(reason);
}

common::TopologyRevision
CGEventInputAdapter::topology_revision() const noexcept {
  return impl_->topology_revision();
}

CGEventInputError CGEventInputAdapter::LastError() const {
  return impl_->LastError();
}

CGEventInputStatistics CGEventInputAdapter::Statistics() const {
  return impl_->Statistics();
}

} // namespace imcodes::remote_desktop::macos
