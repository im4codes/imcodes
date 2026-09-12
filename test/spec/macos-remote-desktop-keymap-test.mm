// The named-key table, exercised for real.
//
// `MapKey` sits in the adapter's anonymous namespace, and the fake-backend
// tests replace the backend ABOVE it -- they pass key NAMES straight through,
// so every one of them could pass with the table empty. The only named key any
// test mentioned was "KeyA", which is resolved by the letter branch and never
// reaches the table at all.
//
// That mattered the moment the table stopped being a `std::map`: it became a
// sorted array searched by binary search, and an out-of-order or mistyped
// entry there returns the WRONG key code rather than failing. So the
// translation unit is included directly, which puts its anonymous namespace in
// scope, and the mapping is checked against the virtual key codes published in
// HIToolbox's Events.h.

#include "native/macos-remote-desktop/cg_event_input_adapter.mm"

#include <cstdio>
#include <string_view>
#include <utility>
#include <vector>

namespace imcodes::remote_desktop::macos {
namespace {

int failures = 0;

void Expect(std::string_view code, int expected) {
  const std::optional<CGKeyCode> actual = MapKey(code);
  if (!actual.has_value()) {
    std::fprintf(stderr, "FAIL: %.*s did not map\n",
                 static_cast<int>(code.size()), code.data());
    ++failures;
    return;
  }
  if (static_cast<int>(*actual) != expected) {
    std::fprintf(stderr, "FAIL: %.*s mapped to %d, expected %d\n",
                 static_cast<int>(code.size()), code.data(),
                 static_cast<int>(*actual), expected);
    ++failures;
  }
}

void ExpectUnmapped(std::string_view code) {
  if (MapKey(code).has_value()) {
    std::fprintf(stderr, "FAIL: %.*s mapped but should not have\n",
                 static_cast<int>(code.size()), code.data());
    ++failures;
  }
}

}  // namespace
}  // namespace imcodes::remote_desktop::macos

using namespace imcodes::remote_desktop::macos;

int main() {
  // Every entry in the table, so a transcription slip cannot hide behind a
  // spot check. These are HIToolbox Events.h virtual key codes.
  const std::vector<std::pair<std::string_view, int>> expected = {
      {"AltLeft", 58},        {"AltRight", 61},      {"ArrowDown", 125},
      {"ArrowLeft", 123},     {"ArrowRight", 124},   {"ArrowUp", 126},
      {"Backquote", 50},      {"Backslash", 42},     {"Backspace", 51},
      {"BracketLeft", 33},    {"BracketRight", 30},  {"CapsLock", 57},
      {"Comma", 43},          {"ControlLeft", 59},   {"ControlRight", 62},
      {"Delete", 117},        {"End", 119},          {"Enter", 36},
      {"Equal", 24},          {"Escape", 53},        {"Home", 115},
      {"Insert", 114},        {"MetaLeft", 55},      {"MetaRight", 54},
      {"Minus", 27},          {"NumLock", 71},       {"NumpadAdd", 69},
      {"NumpadDecimal", 65},  {"NumpadDivide", 75},  {"NumpadEnter", 76},
      {"NumpadMultiply", 67}, {"NumpadSubtract", 78},{"PageDown", 121},
      {"PageUp", 116},        {"Period", 47},        {"Quote", 39},
      {"Semicolon", 41},      {"ShiftLeft", 56},     {"ShiftRight", 60},
      {"Slash", 44},          {"Space", 49},         {"Tab", 48},
  };
  for (const auto& [code, key] : expected) Expect(code, key);

  // The branches that never touch the table, so a change to the search cannot
  // quietly take them over.
  Expect("KeyA", 0);
  Expect("KeyZ", 6);
  Expect("Digit0", 29);
  Expect("Digit9", 25);
  Expect("Numpad0", 82);
  Expect("Numpad9", 92);
  Expect("F1", 122);
  Expect("F12", 111);

  // A name that sorts INSIDE the table but is absent. `lower_bound` returns a
  // valid iterator for it, so only the equality check afterwards rejects it --
  // exactly the mistake a binary search invites.
  ExpectUnmapped("Backspac");
  ExpectUnmapped("Backspacee");
  ExpectUnmapped("Escapd");
  ExpectUnmapped("Escapf");
  ExpectUnmapped("");
  // Sorts before and after every entry.
  ExpectUnmapped("A");
  ExpectUnmapped("zzzz");

  if (failures != 0) {
    std::fprintf(stderr, "%d key mapping failures\n", failures);
    return 1;
  }
  std::printf("macos key map ok\n");
  return 0;
}
