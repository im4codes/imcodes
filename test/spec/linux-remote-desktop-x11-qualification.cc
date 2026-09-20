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
#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
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

namespace {

// A focused, override-redirect window that decodes every key it receives the
// way an application does (XLookupString with the event's own modifier
// state). What EmitText must be judged by is what an app would read.
struct TypingProbe {
  Display* display = nullptr;
  Window window = 0;
  bool Open() {
    display = XOpenDisplay(nullptr);
    if (display == nullptr) return false;
    XSetWindowAttributes attributes{};
    attributes.override_redirect = True;
    attributes.event_mask = KeyPressMask;
    window = XCreateWindow(display, DefaultRootWindow(display), 0, 0, 64, 64, 0,
                           CopyFromParent, InputOutput, CopyFromParent,
                           CWOverrideRedirect | CWEventMask, &attributes);
    XMapRaised(display, window);
    XSync(display, False);
    usleep(100'000);
    XSetInputFocus(display, window, RevertToParent, CurrentTime);
    XSync(display, False);
    return true;
  }
  // Characters typed since the last call; Return/Tab as \n/\t. Returns false
  // when any typed character arrived with Control held.
  bool Read(std::string* typed) {
    XSync(display, False);
    usleep(150'000);
    bool clean = true;
    XEvent event;
    while (XCheckWindowEvent(display, window, KeyPressMask, &event)) {
      char buffer[16] = {0};
      KeySym symbol = NoSymbol;
      const int length = XLookupString(&event.xkey, buffer, sizeof(buffer) - 1, &symbol, nullptr);
      if (symbol == XK_Return) {
        typed->push_back('\n');
      } else if (symbol == XK_Tab) {
        typed->push_back('\t');
      } else if (length > 0) {
        if ((event.xkey.state & ControlMask) != 0) clean = false;
        typed->append(buffer, static_cast<std::size_t>(length));
      }
    }
    return clean;
  }
  ~TypingProbe() {
    if (display != nullptr) {
      if (window != 0) XDestroyWindow(display, window);
      XCloseDisplay(display);
    }
  }
};

// Owns one selection on its own connection and answers UTF8_STRING requests
// from a thread, like any X application holding a text selection.
struct SelectionOwner {
  Display* display = nullptr;
  Window window = 0;
  std::string text;
  std::atomic<bool> stop{false};
  std::thread server;
  bool Own(const char* selection_name, std::string value) {
    text = std::move(value);
    display = XOpenDisplay(nullptr);
    if (display == nullptr) return false;
    window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
    const Atom selection = XInternAtom(display, selection_name, False);
    XSetSelectionOwner(display, selection, window, CurrentTime);
    XSync(display, False);
    if (XGetSelectionOwner(display, selection) != window) return false;
    server = std::thread([this] {
      const Atom utf8 = XInternAtom(display, "UTF8_STRING", False);
      while (!stop.load()) {
        while (XPending(display) > 0) {
          XEvent event;
          XNextEvent(display, &event);
          if (event.type != SelectionRequest) continue;
          const XSelectionRequestEvent& request = event.xselectionrequest;
          XSelectionEvent reply{};
          reply.type = SelectionNotify;
          reply.display = request.display;
          reply.requestor = request.requestor;
          reply.selection = request.selection;
          reply.target = request.target;
          reply.time = request.time;
          reply.property = None;
          if (request.target == utf8) {
            XChangeProperty(display, request.requestor, request.property, utf8, 8,
                            PropModeReplace,
                            reinterpret_cast<const unsigned char*>(text.data()),
                            static_cast<int>(text.size()));
            reply.property = request.property;
          }
          XSendEvent(display, request.requestor, False, 0, reinterpret_cast<XEvent*>(&reply));
          XFlush(display);
        }
        usleep(1'000);
      }
    });
    return true;
  }
  ~SelectionOwner() {
    stop.store(true);
    if (server.joinable()) server.join();
    if (display != nullptr) {
      XDestroyWindow(display, window);
      XCloseDisplay(display);
    }
  }
};

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
    // Through a fresh connection: `display` loaded its keymap cache in an
    // earlier section, before this remap, so it answers from whatever the
    // scratch keycode held then (left by a previous run) -- not the server.
    Display* fresh = XOpenDisplay(nullptr);
    const bool mapped = fresh != nullptr && XKeysymToKeycode(fresh, target) != 0;
    if (fresh != nullptr) XCloseDisplay(fresh);
    if (!mapped) {
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

  // -- A plain key transition (EmitKey, not EmitText) is fed
  //    message.keyboard.code -- the browser's physical KeyboardEvent.code
  //    ("Digit1", "KeyA", "Enter", ...), never a literal character or an X11
  //    keysym name. Before KeySymForName learned to translate that, EVERY
  //    plain key transition failed unconditionally: XStringToKeysym only
  //    knows X11's own keysym names, and the single-character fallback never
  //    fires for a multi-character code string like "Digit1". EmitKey
  //    returning false there is not a dropped keystroke -- SessionCore
  //    treats an adapter failure as unrecoverable and tears the whole
  //    session down (see session_core.cc's ReportAdapterFailure). This is
  //    the exact real-world report this fix was written for ("even the
  //    digit '1' kills the session instantly"), proved against the real
  //    worker binary's EmitKey and read back from the server's own keyboard
  //    state, same philosophy as every other section in this file.
  {
    auto connection = rd::X11Connection::Open();
    if (!connection) {
      std::fprintf(stderr, "X11Connection::Open failed for the EmitKey section\n");
      XCloseDisplay(display);
      return 70;
    }
    rd::X11InputAdapter input(connection);

    const auto key_down_at_server = [&](KeyCode code) {
      char keymap[32];
      XQueryKeymap(display, keymap);
      return (keymap[code / 8] & (1 << (code % 8))) != 0;
    };

    const KeyCode digit1 = XKeysymToKeycode(display, XK_1);
    if (digit1 == 0) {
      XCloseDisplay(display);
      return 71;
    }
    if (!input.EmitKey("Digit1", true)) {
      std::fprintf(stderr, "EmitKey(\"Digit1\", down) returned false\n");
      XCloseDisplay(display);
      return 72;
    }
    XSync(display, False);
    const bool digit1_seen = key_down_at_server(digit1);
    if (!input.EmitKey("Digit1", false)) {
      std::fprintf(stderr, "EmitKey(\"Digit1\", up) returned false\n");
      XCloseDisplay(display);
      return 73;
    }
    XSync(display, False);
    if (!digit1_seen) {
      std::fprintf(stderr, "Digit1 keydown not observed in server keymap\n");
      XCloseDisplay(display);
      return 74;
    }
    if (key_down_at_server(digit1)) {
      std::fprintf(stderr, "Digit1 stuck down after EmitKey(..., false)\n");
      XCloseDisplay(display);
      return 75;
    }
    std::printf("EmitKey \"Digit1\": verified pressed and released at the server\n");

    if (!input.EmitKey("KeyA", true) || !input.EmitKey("KeyA", false)) {
      std::fprintf(stderr, "EmitKey(\"KeyA\", ...) returned false\n");
      XCloseDisplay(display);
      return 77;
    }
    std::printf("EmitKey \"KeyA\": ok\n");

    // DOM code "Enter" must map to X11's "Return" -- the two are spelled
    // differently, so this fails without the named-code translation table.
    if (!input.EmitKey("Enter", true) || !input.EmitKey("Enter", false)) {
      std::fprintf(stderr, "EmitKey(\"Enter\", ...) returned false\n");
      XCloseDisplay(display);
      return 78;
    }
    std::printf("EmitKey \"Enter\": ok\n");

    if (input.held_count() != 0) {
      std::fprintf(stderr, "EmitKey left %zu key(s) held\n", input.held_count());
      XCloseDisplay(display);
      return 79;
    }
    std::printf("EmitKey: no held state leaked\n");

    // Every code the browser can send (isRemoteDesktopKeyAllowed in
    // web/src/remote-desktop-client.ts) must resolve: an unresolved key is an
    // adapter failure that ends the whole session, so a single unmapped entry
    // (ScrollLock was one) turns one keypress into a black screen.
    std::vector<std::string> allowed_codes;
    for (char letter = 'A'; letter <= 'Z'; ++letter) {
      allowed_codes.push_back(std::string("Key") + letter);
    }
    for (char digit = '0'; digit <= '9'; ++digit) {
      allowed_codes.push_back(std::string("Digit") + digit);
      allowed_codes.push_back(std::string("Numpad") + digit);
    }
    for (int function = 1; function <= 12; ++function) {
      allowed_codes.push_back("F" + std::to_string(function));
    }
    for (const char* code :
         {"NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide",
          "NumpadDecimal", "NumpadEnter", "ArrowUp", "ArrowDown", "ArrowLeft",
          "ArrowRight", "Backspace", "Tab", "Enter", "Escape", "Space",
          "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
          "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft",
          "AltRight", "MetaLeft", "MetaRight", "CapsLock", "NumLock",
          "ScrollLock", "Semicolon", "Equal", "Comma", "Minus", "Period",
          "Slash", "Backquote", "BracketLeft", "Backslash", "BracketRight",
          "Quote"}) {
      allowed_codes.emplace_back(code);
    }
    for (const std::string& code : allowed_codes) {
      // Lock keys toggle; a second tap restores the display's lock state.
      const int taps =
          code == "CapsLock" || code == "NumLock" || code == "ScrollLock" ? 2 : 1;
      for (int tap = 0; tap < taps; ++tap) {
        if (!input.EmitKey(code, true) || !input.EmitKey(code, false)) {
          std::fprintf(stderr, "EmitKey(\"%s\", ...) returned false\n",
                       code.c_str());
          XCloseDisplay(display);
          return 80;
        }
      }
    }
    if (input.held_count() != 0) {
      std::fprintf(stderr, "allowlist sweep left %zu key(s) held\n",
                   input.held_count());
      XCloseDisplay(display);
      return 81;
    }
    std::printf("EmitKey: all %zu browser-allowed codes resolved\n",
                allowed_codes.size());
  }

  // -- A session starts on a clean keyboard. A modifier whose key-up never
  //    arrived -- a worker killed mid-press, a route lost between a
  //    modifier's down and its up -- stays held at the X server itself, and
  //    an adapter that only releases what it emitted knows nothing about it.
  //    Every click and keystroke that follows is silently rewritten by it
  //    (on macOS, where the same fix landed first, a latched Control turned
  //    every click into a right-click until the machine restarted). Proved
  //    against the server's own keyboard state: a modifier pressed OUTSIDE
  //    the adapter is gone once a new session's adapter sweeps, while a key
  //    the adapter itself is holding is left to the path that tracks it.
  {
    auto connection = rd::X11Connection::Open();
    if (!connection) {
      std::fprintf(stderr, "X11Connection::Open failed for the latched-modifier section\n");
      XCloseDisplay(display);
      return 110;
    }
    const auto key_down_at_server = [&](KeyCode code) {
      char keymap[32];
      XQueryKeymap(display, keymap);
      return (keymap[code / 8] & (1 << (code % 8))) != 0;
    };
    const KeyCode control_left = XKeysymToKeycode(display, XK_Control_L);
    const KeyCode shift_right = XKeysymToKeycode(display, XK_Shift_R);
    if (control_left == 0 || shift_right == 0) {
      XCloseDisplay(display);
      return 111;
    }
    // Whatever a dead worker left behind: pressed straight through XTEST, so
    // no adapter has it in its own held state.
    XTestFakeKeyEvent(display, control_left, True, 0);
    XSync(display, False);
    if (!key_down_at_server(control_left)) {
      std::fprintf(stderr, "could not latch Control_L for the sweep\n");
      XCloseDisplay(display);
      return 112;
    }

    rd::X11InputAdapter input(connection);
    if (!input.EmitKey("ShiftRight", true)) {
      std::fprintf(stderr, "EmitKey(\"ShiftRight\", down) returned false\n");
      XTestFakeKeyEvent(display, control_left, False, 0);
      XCloseDisplay(display);
      return 113;
    }
    const std::size_t released = input.ReleaseLatchedModifiers();
    XSync(display, False);
    if (released != 1 || key_down_at_server(control_left)) {
      std::fprintf(stderr, "sweep released %zu key(s); Control_L still down: %d\n",
                   released, key_down_at_server(control_left) ? 1 : 0);
      XTestFakeKeyEvent(display, control_left, False, 0);
      input.ReleaseAllEmittedState();
      XCloseDisplay(display);
      return 114;
    }
    if (!key_down_at_server(shift_right) || input.held_count() != 1) {
      std::fprintf(stderr, "the adapter's own held ShiftRight did not survive the sweep\n");
      input.ReleaseAllEmittedState();
      XCloseDisplay(display);
      return 115;
    }
    input.ReleaseAllEmittedState();
    XSync(display, False);
    if (key_down_at_server(shift_right)) {
      std::fprintf(stderr, "ShiftRight stuck down after ReleaseAllEmittedState\n");
      XCloseDisplay(display);
      return 116;
    }
    // A clean keyboard has nothing to sweep.
    if (input.ReleaseLatchedModifiers() != 0) {
      std::fprintf(stderr, "sweep released a key on a clean keyboard\n");
      XCloseDisplay(display);
      return 117;
    }
    std::printf("ReleaseLatchedModifiers: a stray Control_L is cleared, a held key is not\n");
  }

  // -- Pasted text is typed character for character. Judged by what an
  //    application receives: an uppercase letter or "!" pressed at the wrong
  //    shift level arrived as "a" and "1", a line break arrived as Tab, and a
  //    Control still held from a Command+V turned every letter into a
  //    shortcut.
  {
    auto connection = rd::X11Connection::Open();
    TypingProbe probe;
    if (!connection || !probe.Open()) {
      std::fprintf(stderr, "could not open the typing probe\n");
      XCloseDisplay(display);
      return 82;
    }
    rd::X11InputAdapter input(connection);
    const std::string pasted = "Hello World!\r\nA-b_C:1\t@x ~Q\"";
    const std::string expected = "Hello World!\nA-b_C:1\t@x ~Q\"";
    std::string typed;
    if (!input.EmitText(pasted) || !probe.Read(&typed) || typed != expected) {
      std::fprintf(stderr, "EmitText typed [%s], expected [%s]\n", typed.c_str(), expected.c_str());
      XCloseDisplay(display);
      return 83;
    }
    std::printf("EmitText: an application received exactly the pasted text\n");

    typed.clear();
    const bool held = input.EmitKey("ControlLeft", true);
    const bool emitted = input.EmitText("Hi!");
    const bool clean = probe.Read(&typed);
    const bool released = input.EmitKey("ControlLeft", false);
    if (!held || !emitted || !released || !clean || typed != "Hi!") {
      std::fprintf(stderr, "text typed under a held Control arrived as [%s] (clean=%d)\n",
                   typed.c_str(), clean ? 1 : 0);
      XCloseDisplay(display);
      return 84;
    }
    if (input.held_count() != 0) {
      std::fprintf(stderr, "EmitText left %zu key(s) held\n", input.held_count());
      XCloseDisplay(display);
      return 85;
    }
    std::printf("EmitText: a held Control is lifted for the text and restored after\n");
  }

  // -- Copy reads the remote selection without pressing anything: PRIMARY
  //    (whatever is selected now), else CLIPBOARD (what was last copied).
  {
    auto connection = rd::X11Connection::Open();
    if (!connection) {
      XCloseDisplay(display);
      return 90;
    }
    rd::X11ClipboardAdapter clipboard(connection);
    {
      SelectionOwner primary;
      if (!primary.Own("PRIMARY", "selected \xe4\xb8\xad\xe6\x96\x87 text")) {
        std::fprintf(stderr, "could not take PRIMARY for the copy section\n");
        XCloseDisplay(display);
        return 91;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) || copied != "selected \xe4\xb8\xad\xe6\x96\x87 text") {
        std::fprintf(stderr, "CopySelection returned [%s], expected the PRIMARY selection\n", copied.c_str());
        XCloseDisplay(display);
        return 92;
      }
      std::printf("CopySelection: returned the current PRIMARY selection (UTF-8)\n");
    }
    // Nothing selected any more: the explicitly copied CLIPBOARD instead.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner copied_owner;
      if (!copied_owner.Own("CLIPBOARD", "copied earlier")) {
        XCloseDisplay(display);
        return 93;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) || copied != "copied earlier") {
        std::fprintf(stderr, "CopySelection returned [%s], expected the CLIPBOARD\n", copied.c_str());
        XCloseDisplay(display);
        return 94;
      }
      std::printf("CopySelection: falls back to CLIPBOARD when nothing is selected\n");
    }
  }

  XCloseDisplay(display);
  std::printf("linux x11 fallback qualification: ok\n");
  return 0;
}
