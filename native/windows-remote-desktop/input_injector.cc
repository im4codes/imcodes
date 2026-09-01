#include "third_party/imcodes_remote_desktop/input_injector.h"

#include "third_party/imcodes_remote_desktop/windows_platform_adapters.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

namespace imcodes::rd {
namespace {

struct KeyMapping {
  WORD virtual_key;
  bool extended;
};

std::optional<KeyMapping> MapCode(const std::string& code) {
  if (code.size() == 4 && code.rfind("Key", 0) == 0 &&
      code[3] >= 'A' && code[3] <= 'Z') {
    return KeyMapping{static_cast<WORD>(code[3]), false};
  }
  if (code.size() == 6 && code.rfind("Digit", 0) == 0 &&
      code[5] >= '0' && code[5] <= '9') {
    return KeyMapping{static_cast<WORD>(code[5]), false};
  }
  const bool function_key_shape =
      (code.size() == 2 && code[0] == 'F' && code[1] >= '1' &&
       code[1] <= '9') ||
      (code.size() == 3 && code[0] == 'F' && code[1] == '1' &&
       code[2] >= '0' && code[2] <= '2');
  if (function_key_shape) {
    const int number = std::atoi(code.c_str() + 1);
    if (number >= 1 && number <= 12)
      return KeyMapping{static_cast<WORD>(VK_F1 + number - 1), false};
  }
  static const std::map<std::string, KeyMapping> mappings = {
      {"Backspace", {VK_BACK, false}},
      {"Tab", {VK_TAB, false}},
      {"Enter", {VK_RETURN, false}},
      {"Escape", {VK_ESCAPE, false}},
      {"Space", {VK_SPACE, false}},
      {"Delete", {VK_DELETE, true}},
      {"Insert", {VK_INSERT, true}},
      {"Home", {VK_HOME, true}},
      {"End", {VK_END, true}},
      {"PageUp", {VK_PRIOR, true}},
      {"PageDown", {VK_NEXT, true}},
      {"ArrowUp", {VK_UP, true}},
      {"ArrowDown", {VK_DOWN, true}},
      {"ArrowLeft", {VK_LEFT, true}},
      {"ArrowRight", {VK_RIGHT, true}},
      {"ShiftLeft", {VK_LSHIFT, false}},
      {"ShiftRight", {VK_RSHIFT, false}},
      {"ControlLeft", {VK_LCONTROL, false}},
      {"ControlRight", {VK_RCONTROL, true}},
      {"AltLeft", {VK_LMENU, false}},
      {"AltRight", {VK_RMENU, true}},
      {"CapsLock", {VK_CAPITAL, false}},
      {"NumLock", {VK_NUMLOCK, true}},
      {"ScrollLock", {VK_SCROLL, false}},
      {"Semicolon", {VK_OEM_1, false}},
      {"Equal", {VK_OEM_PLUS, false}},
      {"Comma", {VK_OEM_COMMA, false}},
      {"Minus", {VK_OEM_MINUS, false}},
      {"Period", {VK_OEM_PERIOD, false}},
      {"Slash", {VK_OEM_2, false}},
      {"Backquote", {VK_OEM_3, false}},
      {"BracketLeft", {VK_OEM_4, false}},
      {"Backslash", {VK_OEM_5, false}},
      {"BracketRight", {VK_OEM_6, false}},
      {"Quote", {VK_OEM_7, false}},
      {"NumpadAdd", {VK_ADD, false}},
      {"NumpadSubtract", {VK_SUBTRACT, false}},
      {"NumpadMultiply", {VK_MULTIPLY, false}},
      {"NumpadDivide", {VK_DIVIDE, true}},
      {"NumpadDecimal", {VK_DECIMAL, false}},
      {"NumpadEnter", {VK_RETURN, true}},
  };
  if (code.size() == 7 && code.rfind("Numpad", 0) == 0 &&
      code[6] >= '0' && code[6] <= '9') {
    return KeyMapping{static_cast<WORD>(VK_NUMPAD0 + code[6] - '0'), false};
  }
  const auto found = mappings.find(code);
  return found == mappings.end() ? std::nullopt
                                 : std::optional<KeyMapping>(found->second);
}

bool IsSupportedButton(std::string_view button) {
  return button == "left" || button == "middle" || button == "right" ||
         button == "back" || button == "forward";
}

std::optional<std::string> Utf16ToUtf8(const std::u16string& value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  if (value.empty() || value.size() > 2048 ||
      value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  const auto* wide = reinterpret_cast<const wchar_t*>(value.data());
  const int length = static_cast<int>(value.size());
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide,
                                        length, nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return std::nullopt;
  std::string utf8(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, length,
                          utf8.data(), bytes, nullptr, nullptr) != bytes) {
    return std::nullopt;
  }
  return utf8;
}

std::optional<std::u16string> Utf8ToUtf16(std::string_view value) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  if (value.empty() ||
      value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  const int bytes = static_cast<int>(value.size());
  const int units = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(), bytes, nullptr, 0);
  if (units <= 0) return std::nullopt;
  std::u16string utf16(static_cast<std::size_t>(units), u'\0');
  auto* wide = reinterpret_cast<wchar_t*>(utf16.data());
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), bytes,
                          wide, units) != units) {
    return std::nullopt;
  }
  return utf16;
}

}  // namespace

WindowsSendInputBackend::WindowsSendInputBackend(
    WindowsSendInputFn send_input, WindowsInputAvailableFn input_available,
    WindowsMovePointerFn move_pointer)
    : send_input_(send_input ? std::move(send_input)
                             : WindowsSendInputFn([](UINT count,
                                                     LPINPUT inputs, int size) {
                                 return ::SendInput(count, inputs, size);
                               })),
      input_available_(input_available
                           ? std::move(input_available)
                           : WindowsInputAvailableFn([] { return true; })),
      move_pointer_(std::move(move_pointer)) {}

WindowsSendInputBackend::~WindowsSendInputBackend() {
  ReleaseAllEmittedState();
}

common::ReadinessState WindowsSendInputBackend::ProbeReadiness() {
  return input_available_() ? common::ReadinessState::kReady
                            : common::ReadinessState::kUnavailable;
}

bool WindowsSendInputBackend::SupportsKey(std::string_view key) const {
  return MapCode(std::string(key)).has_value();
}

bool WindowsSendInputBackend::SupportsButton(std::string_view button) const {
  return IsSupportedButton(button);
}

bool WindowsSendInputBackend::Dispatch(INPUT* inputs, UINT count) {
  if (count == 0) return false;
  SetLastError(ERROR_SUCCESS);
  const UINT accepted = send_input_(count, inputs, sizeof(INPUT));
  if (accepted != count) {
    std::fprintf(stderr,
                 "imcodes-rd-input-dispatch-failed accepted=%u requested=%u "
                 "error=%lu\n",
                 accepted, count, static_cast<unsigned long>(GetLastError()));
  }
  return accepted == count;
}

bool WindowsSendInputBackend::SendKeyLocked(std::string_view key,
                                            bool pressed) {
  const auto mapping = MapCode(std::string(key));
  if (!mapping) return false;
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(
      mapping->virtual_key, MAPVK_VK_TO_VSC_EX));
  input.ki.dwFlags = KEYEVENTF_SCANCODE |
                     (mapping->extended ? KEYEVENTF_EXTENDEDKEY : 0) |
                     (pressed ? 0 : KEYEVENTF_KEYUP);
  return Dispatch(&input, 1);
}

bool WindowsSendInputBackend::SendButtonLocked(std::string_view button,
                                               bool pressed) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  if (button == "left")
    input.mi.dwFlags = pressed ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (button == "middle")
    input.mi.dwFlags = pressed ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  else if (button == "right")
    input.mi.dwFlags = pressed ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else if (button == "back" || button == "forward") {
    input.mi.dwFlags = pressed ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
    input.mi.mouseData = button == "back" ? XBUTTON1 : XBUTTON2;
  } else {
    return false;
  }
  return Dispatch(&input, 1);
}

bool WindowsSendInputBackend::ReleaseKeyLocked(
    const std::string& key) noexcept {
  if (!emitted_keys_.contains(key)) {
    pending_key_releases_.erase(key);
    return true;
  }
  if (!SendKeyLocked(key, false)) {
    pending_key_releases_.insert(key);
    return false;
  }
  emitted_keys_.erase(key);
  pending_key_releases_.erase(key);
  return true;
}

bool WindowsSendInputBackend::ReleaseButtonLocked(
    const std::string& button) noexcept {
  if (!emitted_buttons_.contains(button)) {
    pending_button_releases_.erase(button);
    return true;
  }
  if (!SendButtonLocked(button, false)) {
    pending_button_releases_.insert(button);
    return false;
  }
  emitted_buttons_.erase(button);
  pending_button_releases_.erase(button);
  return true;
}

bool WindowsSendInputBackend::PrepareKeyDown(std::string_view key) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(key);
  if (!SupportsKey(token)) return false;
  if (pending_key_releases_.contains(token) && !ReleaseKeyLocked(token))
    return false;
  if (emitted_keys_.contains(token)) return true;
  if (!SendKeyLocked(token, true)) return false;
  emitted_keys_.insert(token);
  return true;
}

bool WindowsSendInputBackend::PrepareButtonDown(std::string_view button) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(button);
  if (!SupportsButton(token)) return false;
  if (pending_button_releases_.contains(token) &&
      !ReleaseButtonLocked(token)) {
    return false;
  }
  if (emitted_buttons_.contains(token)) return true;
  if (!SendButtonLocked(token, true)) return false;
  emitted_buttons_.insert(token);
  return true;
}

bool WindowsSendInputBackend::MovePointer(
    const common::LogicalPoint& point) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!std::isfinite(point.x) || !std::isfinite(point.y) ||
      point.x < static_cast<double>(std::numeric_limits<int>::min()) ||
      point.x > static_cast<double>(std::numeric_limits<int>::max()) ||
      point.y < static_cast<double>(std::numeric_limits<int>::min()) ||
      point.y > static_cast<double>(std::numeric_limits<int>::max())) {
    return false;
  }
  const int pixel_x = static_cast<int>(std::llround(point.x));
  const int pixel_y = static_cast<int>(std::llround(point.y));
  if (move_pointer_) return move_pointer_(pixel_x, pixel_y);
  const int virtual_left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int virtual_top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int virtual_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int virtual_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (virtual_width <= 1 || virtual_height <= 1) return false;
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = static_cast<LONG>(std::llround(
      (pixel_x - virtual_left) * 65535.0 / (virtual_width - 1)));
  input.mi.dy = static_cast<LONG>(std::llround(
      (pixel_y - virtual_top) * 65535.0 / (virtual_height - 1)));
  input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE |
                     MOUSEEVENTF_VIRTUALDESK;
  return Dispatch(&input, 1);
}

bool WindowsSendInputBackend::EmitKey(std::string_view key, bool pressed) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(key);
  if (!SupportsKey(token)) return false;
  if (pressed) {
    if (pending_key_releases_.contains(token) && !ReleaseKeyLocked(token))
      return false;
    if (emitted_keys_.contains(token)) return true;
    if (!SendKeyLocked(token, true)) return false;
    emitted_keys_.insert(token);
    return true;
  }
  return ReleaseKeyLocked(token);
}

bool WindowsSendInputBackend::EmitButton(std::string_view button,
                                         bool pressed) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(button);
  if (!SupportsButton(token)) return false;
  if (pressed) {
    if (pending_button_releases_.contains(token) &&
        !ReleaseButtonLocked(token)) {
      return false;
    }
    if (emitted_buttons_.contains(token)) return true;
    if (!SendButtonLocked(token, true)) return false;
    emitted_buttons_.insert(token);
    return true;
  }
  return ReleaseButtonLocked(token);
}

bool WindowsSendInputBackend::EmitWheel(double delta_x, double delta_y) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!std::isfinite(delta_x) || !std::isfinite(delta_y)) return false;
  std::array<INPUT, 2> inputs{};
  UINT count = 0;
  if (std::abs(delta_y) >= 0.5) {
    inputs[count].type = INPUT_MOUSE;
    inputs[count].mi.dwFlags = MOUSEEVENTF_WHEEL;
    inputs[count].mi.mouseData = static_cast<DWORD>(
        static_cast<LONG>(std::clamp(-delta_y, -10'000.0, 10'000.0)));
    ++count;
  }
  if (std::abs(delta_x) >= 0.5) {
    inputs[count].type = INPUT_MOUSE;
    inputs[count].mi.dwFlags = MOUSEEVENTF_HWHEEL;
    inputs[count].mi.mouseData = static_cast<DWORD>(
        static_cast<LONG>(std::clamp(delta_x, -10'000.0, 10'000.0)));
    ++count;
  }
  return count == 0 || Dispatch(inputs.data(), count);
}

bool WindowsSendInputBackend::EmitText(std::string_view text) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto utf16 = Utf8ToUtf16(text);
  if (!utf16 || utf16->empty() || utf16->size() > 2048) return false;
  std::vector<INPUT> inputs;
  inputs.reserve(utf16->size() * 2);
  for (char16_t code_unit : *utf16) {
    INPUT down{};
    down.type = INPUT_KEYBOARD;
    down.ki.wScan = static_cast<WORD>(code_unit);
    down.ki.dwFlags = KEYEVENTF_UNICODE;
    inputs.push_back(down);
    INPUT up = down;
    up.ki.dwFlags |= KEYEVENTF_KEYUP;
    inputs.push_back(up);
  }
  return Dispatch(inputs.data(), static_cast<UINT>(inputs.size()));
}

bool WindowsSendInputBackend::EmitKeyRepeat(std::string_view key) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(key);
  return emitted_keys_.contains(token) && SendKeyLocked(token, true);
}

bool WindowsSendInputBackend::EmitClick(std::string_view button) {
  std::lock_guard<std::mutex> lock(mutex_);
  const std::string token(button);
  if (!SupportsButton(token)) return false;
  if (pending_button_releases_.contains(token) &&
      !ReleaseButtonLocked(token)) {
    return false;
  }
  if (emitted_buttons_.contains(token)) return false;

  std::array<INPUT, 2> inputs{};
  DWORD down = 0;
  DWORD up = 0;
  DWORD mouse_data = 0;
  if (token == "left") {
    down = MOUSEEVENTF_LEFTDOWN;
    up = MOUSEEVENTF_LEFTUP;
  } else if (token == "middle") {
    down = MOUSEEVENTF_MIDDLEDOWN;
    up = MOUSEEVENTF_MIDDLEUP;
  } else if (token == "right") {
    down = MOUSEEVENTF_RIGHTDOWN;
    up = MOUSEEVENTF_RIGHTUP;
  } else {
    down = MOUSEEVENTF_XDOWN;
    up = MOUSEEVENTF_XUP;
    mouse_data = token == "back" ? XBUTTON1 : XBUTTON2;
  }
  inputs[0].type = INPUT_MOUSE;
  inputs[0].mi.dwFlags = down;
  inputs[0].mi.mouseData = mouse_data;
  inputs[1].type = INPUT_MOUSE;
  inputs[1].mi.dwFlags = up;
  inputs[1].mi.mouseData = mouse_data;
  return Dispatch(inputs.data(), static_cast<UINT>(inputs.size()));
}

void WindowsSendInputBackend::ReleaseAllEmittedState() noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto current = emitted_keys_.begin(); current != emitted_keys_.end();) {
    const std::string key = *current;
    ++current;
    ReleaseKeyLocked(key);
  }
  for (auto current = emitted_buttons_.begin();
       current != emitted_buttons_.end();) {
    const std::string button = *current;
    ++current;
    ReleaseButtonLocked(button);
  }
}

bool WindowsSendInputBackend::RetryPendingReleases() noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  for (const std::string& key : std::vector<std::string>(
           pending_key_releases_.begin(), pending_key_releases_.end())) {
    ReleaseKeyLocked(key);
  }
  for (const std::string& button : std::vector<std::string>(
           pending_button_releases_.begin(),
           pending_button_releases_.end())) {
    ReleaseButtonLocked(button);
  }
  return pending_key_releases_.empty() &&
         pending_button_releases_.empty();
}

bool WindowsSendInputBackend::HasPendingReleases() const noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  return !pending_key_releases_.empty() ||
         !pending_button_releases_.empty();
}

bool WindowsSendInputBackend::IsKeyEmitted(
    std::string_view key) const noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  return emitted_keys_.contains(std::string(key));
}

bool WindowsSendInputBackend::IsButtonEmitted(
    std::string_view button) const noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  return emitted_buttons_.contains(std::string(button));
}

InputArbiter::InputArbiter(SendInputFn send_input,
                           InputAvailableFn input_available,
                           MovePointerFn move_pointer)
    : backend_(std::move(send_input), std::move(input_available),
               std::move(move_pointer)),
      ledger_(backend_) {}

InputArbiter::~InputArbiter() { ReleaseAll(); }

bool InputArbiter::Available() const {
  return const_cast<WindowsSendInputBackend&>(backend_).ProbeReadiness() ==
         common::ReadinessState::kReady;
}

common::InputStamp InputArbiter::NextLegacyStamp(const std::string& owner) {
  LegacyStampState& state = legacy_stamps_[owner];
  if (state.sequence == std::numeric_limits<common::InputSequence>::max()) {
    ++state.epoch;
    if (state.epoch == 0) state.epoch = 1;
    state.sequence = 0;
  }
  ++state.sequence;
  return common::InputStamp{owner, state.epoch, state.sequence, 1};
}

common::InputResult InputArbiter::ApplyKeyStampedLocked(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision, std::string_view code,
    bool pressed, bool repeat) {
  const bool emitted_before = backend_.IsKeyEmitted(code);
  const common::InputResult result = ledger_.ApplyKey(
      stamp, current_topology_revision, code, pressed);
  if (result != common::InputResult::kApplied) {
    if (result == common::InputResult::kAdapterFailure) {
      // A platform failure is terminal for this controller's current epoch.
      // The fixed common ledger has already consumed the transition, so drop
      // the whole controller fail-closed rather than retaining stale ownership.
      ledger_.ReleaseController(stamp.controller_id);
    }
    return result;
  }
  if (pressed && !backend_.IsKeyEmitted(code) &&
      !backend_.PrepareKeyDown(code)) {
    ledger_.ReleaseController(stamp.controller_id);
    return common::InputResult::kAdapterFailure;
  }
  if (pressed && repeat && emitted_before && !backend_.EmitKeyRepeat(code)) {
    return common::InputResult::kAdapterFailure;
  }
  return common::InputResult::kApplied;
}

common::InputResult InputArbiter::ApplyButtonStampedLocked(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    std::string_view button, bool pressed) {
  const common::InputResult result = ledger_.ApplyButton(
      stamp, current_topology_revision, button, pressed);
  if (result != common::InputResult::kApplied) {
    if (result == common::InputResult::kAdapterFailure)
      ledger_.ReleaseController(stamp.controller_id);
    return result;
  }
  if (pressed && !backend_.IsButtonEmitted(button) &&
      !backend_.PrepareButtonDown(button)) {
    ledger_.ReleaseController(stamp.controller_id);
    return common::InputResult::kAdapterFailure;
  }
  return common::InputResult::kApplied;
}

common::InputResult InputArbiter::ApplyPointerStampedLocked(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    const DisplayInfo& display, double x, double y) {
  const common::LogicalRect bounds = WindowsLogicalInputBounds(display);
  if (!std::isfinite(x) || !std::isfinite(y) || x < 0 || x > 1 || y < 0 ||
      y > 1 || !bounds.IsValid()) {
    return common::InputResult::kInvalidInput;
  }
  common::LogicalPoint point = bounds.MapNormalized(x, y);
  // Preserve the Windows v2 endpoint convention: normalized 1.0 addresses the
  // last coordinate inside the selected logical desktop rectangle.
  point.x = std::min(point.x, bounds.x + bounds.width - 1.0);
  point.y = std::min(point.y, bounds.y + bounds.height - 1.0);
  return ledger_.ApplyPointer(stamp, current_topology_revision, point);
}

common::InputResult InputArbiter::ApplyKeyStamped(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision, std::string_view code,
    bool pressed, bool repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ApplyKeyStampedLocked(stamp, current_topology_revision, code, pressed,
                               repeat);
}

common::InputResult InputArbiter::ApplyButtonStamped(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    std::string_view button, bool pressed) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ApplyButtonStampedLocked(stamp, current_topology_revision, button,
                                  pressed);
}

common::InputResult InputArbiter::ApplyPointerStamped(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    const DisplayInfo& display, double x, double y) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ApplyPointerStampedLocked(stamp, current_topology_revision, display, x,
                                   y);
}

common::InputResult InputArbiter::ApplyWheelStamped(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    double delta_x, double delta_y) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ledger_.ApplyWheel(stamp, current_topology_revision, delta_x, delta_y);
}

common::InputResult InputArbiter::ApplyTextStamped(
    const common::InputStamp& stamp,
    common::TopologyRevision current_topology_revision,
    std::string_view utf8_text) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ledger_.ApplyText(stamp, current_topology_revision, utf8_text);
}

common::InputResult InputArbiter::ReleaseControllerStamped(
    std::string_view controller_id) noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  const common::InputResult result = ledger_.ReleaseController(controller_id);
  if (result != common::InputResult::kApplied) return result;
  return !backend_.HasPendingReleases() || backend_.RetryPendingReleases()
             ? common::InputResult::kApplied
             : common::InputResult::kAdapterFailure;
}

bool InputArbiter::KeyDown(const std::string& owner,
                           const std::string& code, bool repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (owner.empty() || !backend_.SupportsKey(code)) return false;
  const bool already_emitted = backend_.IsKeyEmitted(code);
  if (!backend_.PrepareKeyDown(code)) return false;
  const common::InputResult result = ledger_.ApplyKey(
      NextLegacyStamp(owner), 1, code, true);
  if (result != common::InputResult::kApplied) {
    if (!already_emitted) backend_.EmitKey(code, false);
    return false;
  }
  return !repeat || !already_emitted || backend_.EmitKeyRepeat(code);
}

bool InputArbiter::KeyUp(const std::string& owner, const std::string& code) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (owner.empty() || !backend_.SupportsKey(code)) return false;
  return ledger_.ApplyKey(NextLegacyStamp(owner), 1, code, false) ==
         common::InputResult::kApplied;
}

bool InputArbiter::ButtonDown(const std::string& owner,
                              const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (owner.empty() || !backend_.SupportsButton(button)) return false;
  const bool already_emitted = backend_.IsButtonEmitted(button);
  if (!backend_.PrepareButtonDown(button)) return false;
  const common::InputResult result = ledger_.ApplyButton(
      NextLegacyStamp(owner), 1, button, true);
  if (result != common::InputResult::kApplied) {
    if (!already_emitted) backend_.EmitButton(button, false);
    return false;
  }
  return true;
}

bool InputArbiter::ButtonUp(const std::string& owner,
                            const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (owner.empty() || !backend_.SupportsButton(button)) return false;
  return ledger_.ApplyButton(NextLegacyStamp(owner), 1, button, false) ==
         common::InputResult::kApplied;
}

bool InputArbiter::Click(const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  return backend_.EmitClick(button);
}

bool InputArbiter::Move(const DisplayInfo& display, double x, double y) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ApplyPointerStampedLocked(NextLegacyStamp("legacy.pointer"), 1,
                                   display, x, y) ==
         common::InputResult::kApplied;
}

bool InputArbiter::Wheel(double delta_x, double delta_y) {
  std::lock_guard<std::mutex> lock(mutex_);
  return ledger_.ApplyWheel(NextLegacyStamp("legacy.wheel"), 1, delta_x,
                            delta_y) == common::InputResult::kApplied;
}

bool InputArbiter::Text(const std::u16string& value) {
  const auto utf8 = Utf16ToUtf8(value);
  if (!utf8) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  return ledger_.ApplyText(NextLegacyStamp("legacy.text"), 1, *utf8) ==
         common::InputResult::kApplied;
}

bool InputArbiter::CopyShortcut(const std::string& owner) {
  const bool control_down = KeyDown(owner, "ControlLeft", false);
  const bool copy_down = control_down && KeyDown(owner, "KeyC", false);
  const bool copy_up = !copy_down || KeyUp(owner, "KeyC");
  const bool control_up = !control_down || KeyUp(owner, "ControlLeft");
  const bool released = ReleaseOwner(owner);
  return control_down && copy_down && copy_up && control_up && released;
}

bool InputArbiter::ReleaseOwner(const std::string& owner) {
  std::lock_guard<std::mutex> lock(mutex_);
  const common::InputResult result = ledger_.ReleaseController(owner);
  legacy_stamps_.erase(owner);
  if (result != common::InputResult::kApplied) return false;
  return !backend_.HasPendingReleases() || backend_.RetryPendingReleases();
}

bool InputArbiter::RetryPendingReleases() {
  std::lock_guard<std::mutex> lock(mutex_);
  return backend_.RetryPendingReleases();
}

void InputArbiter::ReleaseAll() noexcept {
  std::lock_guard<std::mutex> lock(mutex_);
  ledger_.ReleaseAll();
  legacy_stamps_.clear();
}

bool ReleaseAllSupportedInput(InputArbiter::SendInputFn send_input) {
  if (!send_input) {
    send_input = [](UINT count, LPINPUT inputs, int size) {
      return ::SendInput(count, inputs, size);
    };
  }
  std::vector<std::string> codes;
  for (char letter = 'A'; letter <= 'Z'; ++letter)
    codes.push_back(std::string("Key") + letter);
  for (char digit = '0'; digit <= '9'; ++digit)
    codes.push_back(std::string("Digit") + digit);
  for (int number = 1; number <= 12; ++number)
    codes.push_back("F" + std::to_string(number));
  for (char digit = '0'; digit <= '9'; ++digit)
    codes.push_back(std::string("Numpad") + digit);
  static const char* const named_codes[] = {
      "Backspace", "Tab", "Enter", "Escape", "Space", "Delete",
      "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp",
      "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight",
      "ControlLeft", "ControlRight", "AltLeft", "AltRight", "CapsLock",
      "NumLock", "ScrollLock", "Semicolon", "Equal", "Comma", "Minus",
      "Period", "Slash", "Backquote", "BracketLeft", "Backslash",
      "BracketRight", "Quote", "NumpadAdd", "NumpadSubtract",
      "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
  };
  codes.insert(codes.end(), std::begin(named_codes), std::end(named_codes));

  std::set<std::pair<WORD, bool>> unique_keys;
  for (const std::string& code : codes) {
    if (const auto mapping = MapCode(code))
      unique_keys.emplace(mapping->virtual_key, mapping->extended);
  }
  std::vector<INPUT> releases;
  releases.reserve(unique_keys.size() + 5);
  for (const auto& [virtual_key, extended] : unique_keys) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wScan = static_cast<WORD>(
        MapVirtualKeyW(virtual_key, MAPVK_VK_TO_VSC_EX));
    input.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP |
                       (extended ? KEYEVENTF_EXTENDEDKEY : 0);
    releases.push_back(input);
  }
  for (const char* button : {"left", "middle", "right", "back", "forward"}) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    if (std::string_view(button) == "left")
      input.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    else if (std::string_view(button) == "middle")
      input.mi.dwFlags = MOUSEEVENTF_MIDDLEUP;
    else if (std::string_view(button) == "right")
      input.mi.dwFlags = MOUSEEVENTF_RIGHTUP;
    else {
      input.mi.dwFlags = MOUSEEVENTF_XUP;
      input.mi.mouseData = std::string_view(button) == "back" ? XBUTTON1 : XBUTTON2;
    }
    releases.push_back(input);
  }
  return !releases.empty() &&
         send_input(static_cast<UINT>(releases.size()), releases.data(),
                    sizeof(INPUT)) == releases.size();
}

}  // namespace imcodes::rd
