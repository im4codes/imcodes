#include "cg_event_input_adapter.h"

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <optional>
#include <set>
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

std::optional<CGKeyCode> MapKey(std::string_view code) {
  // These are the stable virtual key codes published by HIToolbox Events.h.
  // Keeping the table here avoids exposing Carbon/CGEvent types through the
  // adapter header and mirrors the browser's physical KeyboardEvent.code.
  static const std::map<std::string_view, CGKeyCode> kNamedKeys = {
      {"Backspace", 51},      {"Tab", 48},
      {"Enter", 36},          {"Escape", 53},
      {"Space", 49},          {"Delete", 117},
      {"Insert", 114},        {"Home", 115},
      {"End", 119},           {"PageUp", 116},
      {"PageDown", 121},      {"ArrowUp", 126},
      {"ArrowDown", 125},     {"ArrowLeft", 123},
      {"ArrowRight", 124},    {"ShiftLeft", 56},
      {"ShiftRight", 60},     {"ControlLeft", 59},
      {"ControlRight", 62},   {"AltLeft", 58},
      {"AltRight", 61},       {"MetaLeft", 55},
      {"MetaRight", 54},      {"CapsLock", 57},
      {"NumLock", 71},        {"Semicolon", 41},
      {"Equal", 24},          {"Comma", 43},
      {"Minus", 27},          {"Period", 47},
      {"Slash", 44},          {"Backquote", 50},
      {"BracketLeft", 33},    {"Backslash", 42},
      {"BracketRight", 30},   {"Quote", 39},
      {"NumpadAdd", 69},      {"NumpadSubtract", 78},
      {"NumpadMultiply", 67}, {"NumpadDivide", 75},
      {"NumpadDecimal", 65},  {"NumpadEnter", 76},
  };
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
  if (code.size() >= 2 && code.size() <= 3 && code[0] == 'F') {
    int number = 0;
    for (std::size_t index = 1; index < code.size(); ++index) {
      if (code[index] < '0' || code[index] > '9')
        return std::nullopt;
      number = number * 10 + (code[index] - '0');
    }
    if (number >= 1 && number <= 12)
      return kFunctionCodes[number - 1];
  }

  const auto found = kNamedKeys.find(code);
  return found == kNamedKeys.end() ? std::nullopt
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

  bool MovePointer(const common::LogicalPoint &point) override {
    if (!AXIsProcessTrusted())
      return false;
    CGEventRef event = CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved,
                                               CGPointMake(point.x, point.y),
                                               kCGMouseButtonLeft);
    return Post(event);
  }

  bool EmitKey(std::string_view key, bool pressed) override {
    if (!AXIsProcessTrusted())
      return false;
    const auto key_code = MapKey(key);
    if (!key_code)
      return false;
    CGEventRef event = CGEventCreateKeyboardEvent(nullptr, *key_code, pressed);
    return Post(event);
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
    CGEventRef event =
        CGEventCreateMouseEvent(nullptr, pressed ? mapping->down : mapping->up,
                                *location, mapping->button);
    return Post(event);
  }

  bool EmitWheel(double delta_x, double delta_y) override {
    if (!AXIsProcessTrusted())
      return false;
    const auto vertical = static_cast<std::int32_t>(std::llround(delta_y));
    const auto horizontal = static_cast<std::int32_t>(std::llround(delta_x));
    if (vertical == 0 && horizontal == 0)
      return true;
    CGEventRef event = CGEventCreateScrollWheelEvent(
        nullptr, kCGScrollEventUnitPixel, 2, vertical, horizontal);
    return Post(event);
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
      CGEventPost(kCGHIDEventTap, down);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(down);
      CFRelease(up);
      return true;
    }
  }

private:
  static bool Post(CGEventRef event) {
    if (event == nullptr)
      return false;
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return true;
  }
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

void CGEventInputAdapter::ReleaseAllEmittedState() noexcept {
  impl_->ReleaseAllEmittedState();
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
