#include "third_party/imcodes_remote_desktop/input_injector.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
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

}  // namespace

InputArbiter::InputArbiter(SendInputFn send_input,
                           InputAvailableFn input_available,
                           MovePointerFn move_pointer)
    : send_input_(send_input ? std::move(send_input)
                             : SendInputFn([](UINT count, LPINPUT inputs,
                                              int size) {
                                 return ::SendInput(count, inputs, size);
                               })),
      input_available_(input_available ? std::move(input_available)
                                       : InputAvailableFn([] { return true; })),
      move_pointer_(std::move(move_pointer)) {}

bool InputArbiter::Available() const { return input_available_(); }

bool InputArbiter::KeyDown(const std::string& owner,
                           const std::string& code,
                           bool repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto mapping = MapCode(code);
  if (!mapping) return false;
  const auto pending = key_owners_.find(code);
  if (pending != key_owners_.end() && pending->second.empty()) {
    if (!SendKey(code, false)) return false;
    key_owners_.erase(pending);
  }
  auto& owners = key_owners_[code];
  const bool already_owned = owners.contains(owner);
  owners.insert(owner);
  if ((already_owned && !repeat) || (!already_owned && owners.size() > 1))
    return true;
  if (SendKey(code, true)) return true;
  if (!already_owned) {
    owners.erase(owner);
    if (owners.empty()) key_owners_.erase(code);
  }
  return false;
}

bool InputArbiter::KeyUp(const std::string& owner, const std::string& code) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto found = key_owners_.find(code);
  if (found == key_owners_.end() || found->second.erase(owner) == 0)
    return true;
  if (!found->second.empty()) return true;
  if (SendKey(code, false)) {
    key_owners_.erase(found);
    return true;
  }
  // Keep ownership recorded so a later release-all/teardown can retry rather
  // than forgetting a key that Windows may still consider pressed.
  found->second.insert(owner);
  return false;
}

bool InputArbiter::ButtonDown(const std::string& owner,
                              const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto pending = button_owners_.find(button);
  if (pending != button_owners_.end() && pending->second.empty()) {
    if (!SendButton(button, false)) return false;
    button_owners_.erase(pending);
  }
  auto& owners = button_owners_[button];
  const bool inserted = owners.insert(owner).second;
  if (!inserted || owners.size() > 1) return true;
  if (SendButton(button, true)) return true;
  owners.erase(owner);
  if (owners.empty()) button_owners_.erase(button);
  return false;
}

bool InputArbiter::ButtonUp(const std::string& owner,
                            const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto found = button_owners_.find(button);
  if (found == button_owners_.end() || found->second.erase(owner) == 0)
    return true;
  if (!found->second.empty()) return true;
  if (SendButton(button, false)) {
    button_owners_.erase(found);
    return true;
  }
  found->second.insert(owner);
  return false;
}

bool InputArbiter::Click(const std::string& button) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto pending = button_owners_.find(button);
  if (pending != button_owners_.end()) {
    if (!pending->second.empty() || !SendButton(button, false)) return false;
    button_owners_.erase(pending);
  }
  return SendClick(button);
}

bool InputArbiter::Move(const DisplayInfo& display, double x, double y) {
  if (!std::isfinite(x) || !std::isfinite(y) || x < 0 || x > 1 || y < 0 ||
      y > 1) {
    return false;
  }
  const int pixel_x = display.desktop_rect.left +
                      std::min(display.width - 1,
                               static_cast<int>(x * display.width));
  const int pixel_y = display.desktop_rect.top +
                      std::min(display.height - 1,
                               static_cast<int>(y * display.height));
  // The interactive indicator owns the input desktop. Prefer an exact
  // physical-pixel cursor move on that thread: SendInput's 0..65535 virtual
  // desktop normalization introduces visible rounding/offset errors on 4K
  // and mixed-origin multi-monitor layouts. Keep the normalized fallback for
  // standalone tests and recovery callers that do not supply the UI bridge.
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

bool InputArbiter::Wheel(double delta_x, double delta_y) {
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

bool InputArbiter::Text(const std::u16string& value) {
  if (value.empty() || value.size() > 2048) return false;
  std::vector<INPUT> inputs;
  inputs.reserve(value.size() * 2);
  for (char16_t code_unit : value) {
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
  for (auto iterator = key_owners_.begin(); iterator != key_owners_.end();) {
    iterator->second.erase(owner);
    if (iterator->second.empty()) {
      if (SendKey(iterator->first, false))
        iterator = key_owners_.erase(iterator);
      else
        ++iterator;
    } else {
      ++iterator;
    }
  }
  for (auto iterator = button_owners_.begin();
       iterator != button_owners_.end();) {
    iterator->second.erase(owner);
    if (iterator->second.empty()) {
      if (SendButton(iterator->first, false))
        iterator = button_owners_.erase(iterator);
      else
        ++iterator;
    } else {
      ++iterator;
    }
  }
  return std::none_of(key_owners_.begin(), key_owners_.end(),
                      [](const auto& item) { return item.second.empty(); }) &&
         std::none_of(button_owners_.begin(), button_owners_.end(),
                      [](const auto& item) { return item.second.empty(); });
}

bool InputArbiter::RetryPendingReleases() {
  std::lock_guard<std::mutex> lock(mutex_);
  for (auto current = key_owners_.begin(); current != key_owners_.end();) {
    if (current->second.empty() && SendKey(current->first, false))
      current = key_owners_.erase(current);
    else
      ++current;
  }
  for (auto current = button_owners_.begin();
       current != button_owners_.end();) {
    if (current->second.empty() && SendButton(current->first, false))
      current = button_owners_.erase(current);
    else
      ++current;
  }
  return std::none_of(key_owners_.begin(), key_owners_.end(),
                      [](const auto& item) { return item.second.empty(); }) &&
         std::none_of(button_owners_.begin(), button_owners_.end(),
                      [](const auto& item) { return item.second.empty(); });
}

bool InputArbiter::SendKey(const std::string& code, bool down) {
  const auto mapping = MapCode(code);
  if (!mapping) return false;
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = mapping->virtual_key;
  input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(mapping->virtual_key,
                                                    MAPVK_VK_TO_VSC_EX));
  input.ki.dwFlags = KEYEVENTF_SCANCODE |
                     (mapping->extended ? KEYEVENTF_EXTENDEDKEY : 0) |
                     (down ? 0 : KEYEVENTF_KEYUP);
  input.ki.wVk = 0;
  return Dispatch(&input, 1);
}

bool InputArbiter::SendButton(const std::string& button, bool down) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  if (button == "left")
    input.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (button == "middle")
    input.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  else if (button == "right")
    input.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else if (button == "back" || button == "forward") {
    input.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
    input.mi.mouseData = button == "back" ? XBUTTON1 : XBUTTON2;
  } else {
    return false;
  }
  return Dispatch(&input, 1);
}

bool InputArbiter::SendClick(const std::string& button) {
  std::array<INPUT, 2> inputs{};
  DWORD down = 0;
  DWORD up = 0;
  DWORD mouse_data = 0;
  if (button == "left") {
    down = MOUSEEVENTF_LEFTDOWN;
    up = MOUSEEVENTF_LEFTUP;
  } else if (button == "middle") {
    down = MOUSEEVENTF_MIDDLEDOWN;
    up = MOUSEEVENTF_MIDDLEUP;
  } else if (button == "right") {
    down = MOUSEEVENTF_RIGHTDOWN;
    up = MOUSEEVENTF_RIGHTUP;
  } else if (button == "back" || button == "forward") {
    down = MOUSEEVENTF_XDOWN;
    up = MOUSEEVENTF_XUP;
    mouse_data = button == "back" ? XBUTTON1 : XBUTTON2;
  } else {
    return false;
  }
  inputs[0].type = INPUT_MOUSE;
  inputs[0].mi.dwFlags = down;
  inputs[0].mi.mouseData = mouse_data;
  inputs[1].type = INPUT_MOUSE;
  inputs[1].mi.dwFlags = up;
  inputs[1].mi.mouseData = mouse_data;
  return Dispatch(inputs.data(), static_cast<UINT>(inputs.size()));
}

bool InputArbiter::Dispatch(INPUT* inputs, UINT count) {
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
