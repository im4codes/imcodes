// Linux-only, on-host qualification for the X11 fallback path.
//
// Unlike the pure capability counterexamples, this binary must run on a real
// Linux host against a real X server. It measures the facts the probe consumes,
// then proves the X11 fallback end to end by injecting pointer and key events
// through XTEST and reading the server's own state back.
//
// Build (Linux), all one line:
//   g++ -std=c++20 linux-remote-desktop-x11-qualification.cc
//   ../../native/linux-remote-desktop/linux_capability_probe.cc
//   ../../native/linux-remote-desktop/linux_x11_backend.cc
//   ../../native/remote-desktop-common/value_types.cc
//   $(pkg-config --cflags --libs x11 xtst xfixes xrandr) -o x11-qual
//
// Exit 0 means the X11 fallback qualified. Any other exit names the failure.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/Xrandr.h>

#include "../../native/linux-remote-desktop/linux_capability_probe.h"
#include "../../native/linux-remote-desktop/linux_x11_backend.h"

namespace rd = imcodes::remote_desktop::linux_platform;
using rd::DisplayServer;
using rd::ReadinessState;
using rd::SessionFacts;

namespace {

const char* StateName(ReadinessState state) {
  switch (state) {
    case ReadinessState::kReady: return "ready";
    case ReadinessState::kUnavailable: return "unavailable";
    case ReadinessState::kUnknown: return "unknown";
  }
  return "invalid";
}

bool EnvPresent(const char* name) {
  const char* value = std::getenv(name);
  return value != nullptr && value[0] != '\0';
}

}  // namespace

int main() {
  Display* display = XOpenDisplay(nullptr);
  if (display == nullptr) {
    std::fprintf(stderr, "cannot open X display (DISPLAY=%s)\n",
                 std::getenv("DISPLAY") ? std::getenv("DISPLAY") : "<unset>");
    return 10;
  }

  SessionFacts facts;
  facts.display_server = EnvPresent("WAYLAND_DISPLAY")
      ? DisplayServer::kWayland
      : DisplayServer::kX11;
  // An X server we can open and drive is the graphical session under test.
  facts.graphical_session_present = true;
  facts.session_bus_present = EnvPresent("DBUS_SESSION_BUS_ADDRESS");

  int event_base = 0;
  int error_base = 0;
  int major = 0;
  int minor = 0;
  facts.xtest_present =
      XTestQueryExtension(display, &event_base, &error_base, &major, &minor) == True;
  facts.xfixes_present =
      XFixesQueryExtension(display, &event_base, &error_base) == True;
  facts.randr_present =
      XRRQueryExtension(display, &event_base, &error_base) == True;

  const auto readiness = rd::ProbeAll(facts);
  std::printf("measured facts:\n");
  std::printf("  display_server=%s xtest=%d xfixes=%d randr=%d session_bus=%d\n",
              facts.display_server == DisplayServer::kX11 ? "x11" : "wayland",
              facts.xtest_present, facts.xfixes_present, facts.randr_present,
              facts.session_bus_present);
  std::printf("probe readiness:\n");
  std::printf("  capture=%s input=%s clipboard=%s display=%s disclosure=%s\n",
              StateName(readiness.capture), StateName(readiness.input),
              StateName(readiness.clipboard), StateName(readiness.display),
              StateName(readiness.disclosure));
  std::printf("  advertisable=%d\n", rd::IsAdvertisable(readiness) ? 1 : 0);

  if (readiness.input != ReadinessState::kReady) {
    std::fprintf(stderr, "X11 input not ready; cannot qualify injection\n");
    XCloseDisplay(display);
    return 11;
  }

  // ── Prove XTEST pointer injection against the server's own state ─────────
  Window root = DefaultRootWindow(display);
  const int target_x = 321;
  const int target_y = 214;
  if (XTestFakeMotionEvent(display, -1, target_x, target_y, 0) == 0) {
    XCloseDisplay(display);
    return 20;
  }
  XSync(display, False);

  Window root_return = 0;
  Window child_return = 0;
  int root_x = 0;
  int root_y = 0;
  int win_x = 0;
  int win_y = 0;
  unsigned int mask = 0;
  if (XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                    &win_x, &win_y, &mask) == False) {
    XCloseDisplay(display);
    return 21;
  }
  if (root_x != target_x || root_y != target_y) {
    std::fprintf(stderr, "pointer injection mismatch: wanted %d,%d got %d,%d\n",
                 target_x, target_y, root_x, root_y);
    XCloseDisplay(display);
    return 22;
  }
  std::printf("xtest pointer injection: verified at %d,%d\n", root_x, root_y);

  // ── Prove button state actually reaches the server, then release it ──────
  const unsigned int kButton1Mask = Button1Mask;
  if (XTestFakeButtonEvent(display, 1, True, 0) == 0) {
    XCloseDisplay(display);
    return 30;
  }
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &mask);
  const bool pressed_seen = (mask & kButton1Mask) != 0;
  XTestFakeButtonEvent(display, 1, False, 0);
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &mask);
  const bool released = (mask & kButton1Mask) == 0;
  if (!pressed_seen) {
    std::fprintf(stderr, "button press not observed in server state\n");
    XCloseDisplay(display);
    return 31;
  }
  if (!released) {
    std::fprintf(stderr, "button did not release; would leak held input\n");
    XCloseDisplay(display);
    return 32;
  }
  std::printf("xtest button press/release: verified and released\n");

  // ── Prove a key round-trips and leaves no held modifier ──────────────────
  const KeyCode shift = XKeysymToKeycode(display, XK_Shift_L);
  if (shift == 0) {
    XCloseDisplay(display);
    return 40;
  }
  XTestFakeKeyEvent(display, shift, True, 0);
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &mask);
  const bool shift_seen = (mask & ShiftMask) != 0;
  XTestFakeKeyEvent(display, shift, False, 0);
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &mask);
  const bool shift_cleared = (mask & ShiftMask) == 0;
  if (!shift_seen) {
    std::fprintf(stderr, "key press not observed in server modifier state\n");
    XCloseDisplay(display);
    return 41;
  }
  if (!shift_cleared) {
    std::fprintf(stderr, "modifier stuck after release\n");
    XCloseDisplay(display);
    return 42;
  }
  std::printf("xtest key press/release: verified and cleared\n");

  // ── Topology must be enumerable when RANDR says it is ────────────────────
  if (readiness.display == ReadinessState::kReady) {
    XRRScreenResources* resources = XRRGetScreenResources(display, root);
    if (resources == nullptr || resources->noutput <= 0) {
      if (resources != nullptr) XRRFreeScreenResources(resources);
      std::fprintf(stderr, "RANDR reported ready but enumerated no output\n");
      XCloseDisplay(display);
      return 50;
    }
    std::printf("randr outputs: %d\n", resources->noutput);
    XRRFreeScreenResources(resources);
  }

  // -- Unicode text input must actually reach the server, not silently drop
  //    after the first non-ASCII byte. EmitText used to iterate raw UTF-8
  //    BYTES (std::string_view's default char iteration), not codepoints:
  //    every CJK character is 3 UTF-8 bytes, each individual byte failed
  //    keysym lookup, and EmitText returned false on the very first byte,
  //    aborting -- silently dropping -- the rest of the burst. This exercises
  //    the REAL X11InputAdapter::EmitText the worker actually ships, not a
  //    parallel hand-rolled check, and reads the server's own keyboard
  //    mapping back afterward -- same "prove it against real server state"
  //    philosophy as the pointer/button/modifier checks above. --------------
  {
    auto connection = rd::X11Connection::Open();
    if (!connection) {
      std::fprintf(stderr, "X11Connection::Open failed for the input-adapter section\n");
      XCloseDisplay(display);
      return 60;
    }
    rd::X11InputAdapter input(connection);

    // Regression check: plain ASCII must still work exactly as before -- this
    // fast path is unchanged by the fix and must stay unchanged.
    if (!input.EmitText("Hello")) {
      std::fprintf(stderr, "EmitText regressed on plain ASCII text\n");
      XCloseDisplay(display);
      return 61;
    }
    input.ReleaseAllEmittedState();
    std::printf("EmitText ASCII burst: ok\n");

    // The actual bug: a single CJK character (U+4E2D, 3 UTF-8 bytes) used to
    // fail on its very first byte and return false.
    if (!input.EmitText("\xe4\xb8\xad")) {  // U+4E2D
      std::fprintf(stderr, "EmitText failed on a single multi-byte UTF-8 character\n");
      XCloseDisplay(display);
      return 62;
    }
    // Prove the scratch-keycode remap genuinely reached the server, not just
    // that EmitText returned true. Per keysymdef.h's own documented
    // convention (verified live against a real X server before this fix was
    // written): codepoints U+0100..U+10FFFF are keysym 0x01000000+codepoint.
    const KeySym target = static_cast<KeySym>(0x01000000u + 0x4E2Du);
    if (XKeysymToKeycode(display, target) == 0) {
      std::fprintf(stderr, "EmitText reported success but the server has no keycode for U+4E2D\n");
      XCloseDisplay(display);
      return 63;
    }
    input.ReleaseAllEmittedState();
    std::printf("EmitText single CJK character: verified mapped at the server\n");

    // The exact original failure mode: a burst mixing CJK and ASCII (four
    // CJK characters followed by plain "ok") must not silently truncate
    // after the first non-ASCII character -- that truncation is what "return
    // false immediately on byte 1" actually broke for any real sentence.
    if (!input.EmitText("\xe4\xb8\xad\xe6\x96\x87\xe6\xb5\x8b\xe8\xaf\x95ok")) {
      std::fprintf(stderr, "EmitText failed on a mixed CJK+ASCII burst\n");
      XCloseDisplay(display);
      return 64;
    }
    input.ReleaseAllEmittedState();
    std::printf("EmitText mixed CJK+ASCII burst: ok\n");

    // Malformed UTF-8 (a bare continuation byte with no lead byte) must be
    // skipped, never hang and never break the real character right after it.
    if (!input.EmitText("\x80\xe4\xb8\xad")) {
      std::fprintf(stderr, "EmitText failed to recover after a malformed leading byte\n");
      XCloseDisplay(display);
      return 65;
    }
    input.ReleaseAllEmittedState();
    std::printf("EmitText malformed-byte recovery: ok\n");

    if (input.held_count() != 0) {
      std::fprintf(stderr, "EmitText left %zu key(s) held after ReleaseAllEmittedState\n",
                   input.held_count());
      XCloseDisplay(display);
      return 66;
    }
    std::printf("EmitText: no held state leaked\n");
  }

  XCloseDisplay(display);
  std::printf("linux x11 fallback qualification: ok\n");
  return 0;
}
