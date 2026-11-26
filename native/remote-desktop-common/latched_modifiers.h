#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LATCHED_MODIFIERS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LATCHED_MODIFIERS_H_

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace imcodes::remote_desktop::common {

// A session begins on a clean keyboard.
//
// An input adapter releases what it emitted itself. A modifier whose key-up
// never arrived -- a worker killed mid-press, a route lost between a
// modifier's down and its up -- belongs to nobody the adapter knows of, so it
// stays held by the window server/X server/Windows itself until something
// releases it or the machine restarts. A latched Control turns every later
// click into a right-click (measured on macOS, where it is the whole of
// "clicking does a right-click and only a restart fixes it") and silently
// rewrites every keystroke on Windows and Linux too.
//
// Every platform names these keys the same way (the browser's
// KeyboardEvent.code vocabulary), so the table, the side rule and the release
// policy live here once; each platform only answers which sides it currently
// reports as held.

struct LatchableModifier {
  const char* left;
  const char* right;
};

inline constexpr LatchableModifier kLatchableModifiers[] = {
    {"ControlLeft", "ControlRight"},
    {"ShiftLeft", "ShiftRight"},
    {"AltLeft", "AltRight"},
    {"MetaLeft", "MetaRight"},
};

inline constexpr std::size_t kLatchableModifierCount =
    sizeof(kLatchableModifiers) / sizeof(kLatchableModifiers[0]);

[[nodiscard]] inline bool IsLatchableModifierKey(std::string_view key) noexcept {
  for (const LatchableModifier& modifier : kLatchableModifiers) {
    if (key == modifier.left || key == modifier.right) return true;
  }
  return false;
}

// What a platform reports about one modifier. `any` is the modifier being
// held at all, which some platforms report without naming a side (macOS
// reports a synthetic press that named neither exactly that way); `left` and
// `right` are the side-specific keys.
struct ModifierHeldSides {
  bool any = false;
  bool left = false;
  bool right = false;
};

// The modifier keys the platform still holds down, in adapter key-name form.
// `held(modifier, index)` is asked once per entry of kLatchableModifiers, in
// order, so a platform may keep its own native table parallel to that one.
// A modifier held with no side named is released on the left key.
template <typename HeldQuery>
[[nodiscard]] std::vector<std::string> CollectLatchedModifiers(
    HeldQuery held) {
  std::vector<std::string> latched;
  for (std::size_t index = 0; index < kLatchableModifierCount; ++index) {
    const LatchableModifier& modifier = kLatchableModifiers[index];
    const ModifierHeldSides sides = held(modifier, index);
    if (!sides.any && !sides.left && !sides.right) continue;
    if (sides.left || !sides.right) latched.emplace_back(modifier.left);
    if (sides.right) latched.emplace_back(modifier.right);
  }
  return latched;
}

// Releases the latched modifiers this adapter did not press itself; its own
// held keys are left to the release path that tracks them, which also keeps
// that path's bookkeeping straight. Returns how many were released. A failure
// is never fatal to the session that is starting.
template <typename EmittedPredicate, typename ReleaseKeyFn>
std::size_t ReleaseLatchedModifiers(const std::vector<std::string>& latched,
                                    EmittedPredicate already_emitted,
                                    ReleaseKeyFn release_key) {
  std::size_t released = 0;
  for (const std::string& key : latched) {
    if (already_emitted(key)) continue;
    if (release_key(key)) ++released;
  }
  return released;
}

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LATCHED_MODIFIERS_H_
