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
#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <unistd.h>

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/Xrandr.h>
#include <X11/keysym.h>

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

// Owns one selection on its own connection and answers selection requests
// from a thread, like any X application holding a text selection.
// response_delay_ms == -1 simulates an unresponsive owner; > 0 delays each
// SelectionNotify reply asynchronously while still pumping new requests.
struct SelectionOwner {
  Display* display = nullptr;
  Window window = 0;
  std::string text;
  std::atomic<bool> stop{false};
  std::thread server;
  bool Own(const char* selection_name, std::string value,
           const char* accepted_target = "UTF8_STRING",
           int response_delay_ms = 0,
           Window focus_switch_target = None) {
    text = std::move(value);
    display = XOpenDisplay(nullptr);
    if (display == nullptr) return false;
    window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
    const Atom selection = XInternAtom(display, selection_name, False);
    XSetSelectionOwner(display, selection, window, CurrentTime);
    XSync(display, False);
    if (XGetSelectionOwner(display, selection) != window) return false;
    const std::string target_name(accepted_target);
    server = std::thread([this, target_name, response_delay_ms, focus_switch_target] {
      const Atom expected_target = XInternAtom(display, target_name.c_str(), False);
      bool switched_focus = false;
      struct PendingReply {
        std::chrono::steady_clock::time_point due;
        XSelectionRequestEvent request;
      };
      std::vector<PendingReply> delayed;
      auto send_reply = [&](const XSelectionRequestEvent& request) {
        if (!switched_focus && focus_switch_target != None) {
          switched_focus = true;
          XSetInputFocus(display, focus_switch_target, RevertToParent, CurrentTime);
          XSync(display, False);
        }
        XSelectionEvent reply{};
        reply.type = SelectionNotify;
        reply.display = request.display;
        reply.requestor = request.requestor;
        reply.selection = request.selection;
        reply.target = request.target;
        reply.time = request.time;
        reply.property = None;
        if (request.target == expected_target) {
          XChangeProperty(display, request.requestor, request.property,
                          expected_target, 8, PropModeReplace,
                          reinterpret_cast<const unsigned char*>(text.data()),
                          static_cast<int>(text.size()));
          reply.property = request.property;
        }
        XSendEvent(display, request.requestor, False, 0, reinterpret_cast<XEvent*>(&reply));
        XFlush(display);
      };
      while (!stop.load()) {
        while (XPending(display) > 0) {
          XEvent event;
          XNextEvent(display, &event);
          if (event.type != SelectionRequest) continue;
          if (response_delay_ms < 0) continue;
          if (response_delay_ms == 0) {
            send_reply(event.xselectionrequest);
          } else {
            delayed.push_back(PendingReply{
                std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(response_delay_ms),
                event.xselectionrequest});
          }
        }
        const auto now = std::chrono::steady_clock::now();
        for (auto it = delayed.begin(); it != delayed.end();) {
          if (now >= it->due) {
            send_reply(it->request);
            it = delayed.erase(it);
          } else {
            ++it;
          }
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

// Interactive X11 app window that watches KeyPress on its focused window (or
// inner child window), takes CLIPBOARD ownership on Ctrl+C (non-terminal) or
// Ctrl+Shift+C (terminal), and serves UTF8_STRING (or INCR) without touching
// PRIMARY.
struct ShortcutCopyClient {
  Display* display = nullptr;
  Window top_window = 0;
  Window focus_window = 0;
  std::string payload;
  bool expect_terminal_chord = false;
  std::atomic<bool> reply_with_incr{false};
  bool switch_to_incr_on_copy = false;
  bool keep_owner_on_copy = false;
  int take_delay_ms = 0;
  int reply_delay_ms = 0;
  std::atomic<bool> stop{false};
  std::atomic<bool> saw_bare_ctrl_c{false};
  std::atomic<int> any_c_count{0};
  std::atomic<int> copy_count{0};
  std::thread loop;

  bool Open(const char* wm_class, const char* wm_name, bool use_child_focus,
            bool terminal_chord, std::string value,
            bool incr_reply = false, int delay_take_ms = 0,
            int delay_reply_ms = 0,
            bool own_clipboard_initially = false,
            bool switch_incr_on_copy = false) {
    payload = std::move(value);
    expect_terminal_chord = terminal_chord;
    reply_with_incr.store(incr_reply);
    switch_to_incr_on_copy = switch_incr_on_copy;
    keep_owner_on_copy = own_clipboard_initially;
    take_delay_ms = delay_take_ms;
    reply_delay_ms = delay_reply_ms;
    display = XOpenDisplay(nullptr);
    if (display == nullptr) return false;
    top_window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0,
                                     80, 80, 0, 0, 0);
    XClassHint hint{};
    hint.res_class = const_cast<char*>(wm_class);
    hint.res_name = const_cast<char*>(wm_name);
    XSetClassHint(display, top_window, &hint);
    XMapRaised(display, top_window);
    if (use_child_focus) {
      focus_window = XCreateSimpleWindow(display, top_window, 4, 4, 64, 64, 0, 0, 0);
      XMapRaised(display, focus_window);
    } else {
      focus_window = top_window;
    }
    XSelectInput(display, focus_window, KeyPressMask);
    const Atom clipboard = XInternAtom(display, "CLIPBOARD", False);
    if (own_clipboard_initially) {
      XSetSelectionOwner(display, clipboard, focus_window, CurrentTime);
    }
    XSync(display, False);
    usleep(50'000);
    XSetInputFocus(display, focus_window, RevertToParent, CurrentTime);
    XSync(display, False);

    const KeyCode key_c = XKeysymToKeycode(display, XK_c);
    const Atom utf8 = XInternAtom(display, "UTF8_STRING", False);
    const Atom incr = XInternAtom(display, "INCR", False);
    loop = std::thread([this, key_c, clipboard, utf8, incr] {
      std::optional<std::chrono::steady_clock::time_point> take_due;
      struct PendingReply {
        std::chrono::steady_clock::time_point due;
        XSelectionRequestEvent request;
      };
      std::vector<PendingReply> delayed;
      auto send_reply = [&](const XSelectionRequestEvent& request) {
        XSelectionEvent reply{};
        reply.type = SelectionNotify;
        reply.display = request.display;
        reply.requestor = request.requestor;
        reply.selection = request.selection;
        reply.target = request.target;
        reply.time = request.time;
        reply.property = None;
        if (request.target == utf8) {
          if (reply_with_incr.load()) {
            const unsigned long chunk_hint = 1024;
            XChangeProperty(display, request.requestor, request.property, incr,
                            32, PropModeReplace,
                            reinterpret_cast<const unsigned char*>(&chunk_hint), 1);
          } else {
            XChangeProperty(display, request.requestor, request.property, utf8,
                            8, PropModeReplace,
                            reinterpret_cast<const unsigned char*>(payload.data()),
                            static_cast<int>(payload.size()));
          }
          reply.property = request.property;
        }
        XSendEvent(display, request.requestor, False, 0,
                   reinterpret_cast<XEvent*>(&reply));
        XFlush(display);
      };
      while (!stop.load()) {
        while (XPending(display) > 0) {
          XEvent event;
          XNextEvent(display, &event);
          if (event.type == KeyPress && event.xkey.keycode == key_c) {
            any_c_count.fetch_add(1);
            const unsigned int mods = event.xkey.state & (ControlMask | ShiftMask);
            if (mods == ControlMask) {
              saw_bare_ctrl_c.store(true);
            }
            const unsigned int wanted =
                expect_terminal_chord ? (ControlMask | ShiftMask) : ControlMask;
            if (mods == wanted) {
              if (switch_to_incr_on_copy) {
                reply_with_incr.store(true);
              }
              if (keep_owner_on_copy) {
                copy_count.fetch_add(1);
              } else if (take_delay_ms <= 0) {
                XSetSelectionOwner(display, clipboard, focus_window, CurrentTime);
                XFlush(display);
                copy_count.fetch_add(1);
              } else {
                take_due = std::chrono::steady_clock::now() +
                           std::chrono::milliseconds(take_delay_ms);
              }
            }
          } else if (event.type == SelectionRequest) {
            if (reply_delay_ms <= 0) {
              send_reply(event.xselectionrequest);
            } else {
              delayed.push_back(PendingReply{
                  std::chrono::steady_clock::now() +
                      std::chrono::milliseconds(reply_delay_ms),
                  event.xselectionrequest});
            }
          }
        }
        const auto now = std::chrono::steady_clock::now();
        if (take_due.has_value() && now >= *take_due) {
          take_due.reset();
          XSetSelectionOwner(display, clipboard, focus_window, CurrentTime);
          XFlush(display);
          copy_count.fetch_add(1);
        }
        for (auto it = delayed.begin(); it != delayed.end();) {
          if (now >= it->due) {
            send_reply(it->request);
            it = delayed.erase(it);
          } else {
            ++it;
          }
        }
        usleep(1'000);
      }
    });
    return true;
  }

  ~ShortcutCopyClient() {
    stop.store(true);
    if (loop.joinable()) loop.join();
    if (display != nullptr) {
      if (focus_window != 0 && focus_window != top_window) {
        XDestroyWindow(display, focus_window);
      }
      if (top_window != 0) XDestroyWindow(display, top_window);
      XCloseDisplay(display);
    }
  }
};

}  // namespace

int main(int argc, char** argv) {
  const std::string_view mode = argc > 1 ? std::string_view(argv[1]) : "";
  if (mode == "--no-xfixes-clipboard") {
    auto connection = rd::X11Connection::Open();
    if (!connection || connection->has_xfixes()) {
      std::fprintf(stderr, "--no-xfixes-clipboard requires an X server without XFIXES\n");
      return 200;
    }
    rd::X11ClipboardAdapter clipboard(connection);
    SelectionOwner stale_primary;
    if (!stale_primary.Own("PRIMARY", "stale primary")) return 201;
    ShortcutCopyClient same_owner_incr;
    if (!same_owner_incr.Open("EditorApp", "editor", false, false,
                              "before copy short", false, 0, 0, true, true)) {
      return 202;
    }
    std::string copied = "should clear";
    if (clipboard.CopySelection(&copied) || !copied.empty() ||
        same_owner_incr.copy_count.load() != 1) {
      std::fprintf(stderr,
                   "No-XFixes same-owner INCR returned [%s] (shortcuts=%d), expected refusal\n",
                   copied.c_str(), same_owner_incr.copy_count.load());
      return 203;
    }
    std::printf("CopySelection (--no-xfixes-clipboard): same-owner UTF-8 -> INCR failed closed cleanly\n");
    return 0;
  }
  if (mode == "--no-xtest-clipboard") {
    auto connection = rd::X11Connection::Open();
    if (!connection || connection->has_xtest()) {
      std::fprintf(stderr, "--no-xtest-clipboard requires an X server without XTEST\n");
      return 210;
    }
    rd::X11ClipboardAdapter clipboard(connection);
    SelectionOwner silent_primary;
    if (!silent_primary.Own("PRIMARY", "ignored", "UTF8_STRING", -1)) return 211;
    SelectionOwner healthy_clipboard;
    if (!healthy_clipboard.Own("CLIPBOARD", "healthy clipboard without xtest")) return 212;
    const auto started = std::chrono::steady_clock::now();
    std::string copied;
    if (!clipboard.CopySelection(&copied) ||
        copied != "healthy clipboard without xtest") {
      std::fprintf(stderr,
                   "No-XTest silent PRIMARY fallback returned [%s]\n",
                   copied.c_str());
      return 213;
    }
    const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started)
            .count();
    if (elapsed_ms > 500) {
      std::fprintf(stderr, "No-XTest fallback took %lldms (>500ms)\n",
                   static_cast<long long>(elapsed_ms));
      return 214;
    }
    std::printf("CopySelection (--no-xtest-clipboard): unresponsive PRIMARY fell back to CLIPBOARD in %lldms\n",
                static_cast<long long>(elapsed_ms));
    return 0;
  }

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
  unsigned int pointer_state_mask = 0;
  if (XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                    &win_x, &win_y, &pointer_state_mask) == False) {
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
                &win_x, &win_y, &pointer_state_mask);
  const bool pressed_seen = (pointer_state_mask & kButton1Mask) != 0;
  XTestFakeButtonEvent(display, 1, False, 0);
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &pointer_state_mask);
  const bool button_released = (pointer_state_mask & kButton1Mask) == 0;
  if (!pressed_seen) {
    std::fprintf(stderr, "button press not observed in server state\n");
    XCloseDisplay(display);
    return 31;
  }
  if (!button_released) {
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
                &win_x, &win_y, &pointer_state_mask);
  const bool shift_seen = (pointer_state_mask & ShiftMask) != 0;
  XTestFakeKeyEvent(display, shift, False, 0);
  XSync(display, False);
  XQueryPointer(display, root, &root_return, &child_return, &root_x, &root_y,
                &win_x, &win_y, &pointer_state_mask);
  const bool shift_cleared = (pointer_state_mask & ShiftMask) == 0;
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

    // Exercise real XTest chord sequencing on the server, not only the
    // common ledger's fake adapter: every held Control/Shift/Alt/Super
    // subset must remain down while every representative key-class key is
    // injected, and every side must be up after its matching release. This
    // catches a keysym/keycode vocabulary mismatch in the Linux modifier
    // heal path (which would otherwise release a modifier between the two
    // XTest transitions).
    struct ModifierCode {
      const char* code;
      KeySym symbol;
    };
    constexpr ModifierCode modifiers[] = {
        {"ControlLeft", XK_Control_L}, {"ShiftLeft", XK_Shift_L},
        {"AltLeft", XK_Alt_L}, {"MetaLeft", XK_Super_L}};
    struct KeyClassCode {
      const char* code;
      KeySym symbol;
    };
    constexpr KeyClassCode key_classes[] = {
        {"KeyA", XK_a}, {"Digit1", XK_1}, {"Semicolon", XK_semicolon},
        {"F1", XK_F1}, {"ArrowLeft", XK_Left}, {"Tab", XK_Tab},
        {"Enter", XK_Return}, {"Escape", XK_Escape},
        {"Backspace", XK_BackSpace}, {"Delete", XK_Delete},
        {"Home", XK_Home}, {"End", XK_End}, {"PageUp", XK_Prior},
        {"PageDown", XK_Next}};
    for (unsigned int modifier_mask = 1; modifier_mask < (1u << 4);
         ++modifier_mask) {
      std::vector<std::size_t> held_modifier_indices;
      for (std::size_t index = 0; index < 4; ++index) {
        if ((modifier_mask & (1u << index)) == 0) continue;
        held_modifier_indices.push_back(index);
      }
      for (const KeyClassCode& target : key_classes) {
        if (std::string_view(target.code) == "Delete" &&
            (modifier_mask & ((1u << 0) | (1u << 2))) ==
                ((1u << 0) | (1u << 2))) {
          continue;  // Secure-attention is deliberately not synthesized.
        }
        bool emitted = true;
        for (const std::size_t index : held_modifier_indices) {
          emitted = emitted && input.EmitKey(modifiers[index].code, true);
        }
        const KeyCode target_keycode = XKeysymToKeycode(display, target.symbol);
        if (!emitted || target_keycode == 0 || !input.EmitKey(target.code, true)) {
          std::fprintf(stderr, "failed to press modifier matrix key %s (mask %u)\n",
                       target.code, modifier_mask);
          input.ReleaseAllEmittedState();
          XCloseDisplay(display);
          return 82;
        }
        XSync(display, False);
        bool all_modifiers_held = true;
        for (const std::size_t index : held_modifier_indices) {
          const KeyCode modifier_keycode =
              XKeysymToKeycode(display, modifiers[index].symbol);
          all_modifiers_held = all_modifiers_held && modifier_keycode != 0 &&
                               key_down_at_server(modifier_keycode);
        }
        if (!key_down_at_server(target_keycode) || !all_modifiers_held) {
          std::fprintf(stderr,
                       "server did not observe %s held with modifier mask %u\n",
                       target.code, modifier_mask);
          input.ReleaseAllEmittedState();
          XCloseDisplay(display);
          return 83;
        }
        if (!input.EmitKey(target.code, false)) {
          std::fprintf(stderr, "failed to release matrix key %s\n", target.code);
          input.ReleaseAllEmittedState();
          XCloseDisplay(display);
          return 84;
        }
        for (auto index = held_modifier_indices.rbegin();
             index != held_modifier_indices.rend(); ++index) {
          if (!input.EmitKey(modifiers[*index].code, false)) {
            std::fprintf(stderr, "failed to release modifier %s\n",
                         modifiers[*index].code);
            input.ReleaseAllEmittedState();
            XCloseDisplay(display);
            return 85;
          }
        }
        XSync(display, False);
        bool modifiers_released = true;
        for (const std::size_t index : held_modifier_indices) {
          const KeyCode modifier_keycode =
              XKeysymToKeycode(display, modifiers[index].symbol);
          modifiers_released = modifiers_released && modifier_keycode != 0 &&
                               !key_down_at_server(modifier_keycode);
        }
        if (key_down_at_server(target_keycode) || !modifiers_released) {
          std::fprintf(stderr,
                       "server observed a latched key after %s / mask %u\n",
                       target.code, modifier_mask);
          input.ReleaseAllEmittedState();
          XCloseDisplay(display);
          return 86;
        }
      }
    }
    if (input.held_count() != 0) {
      std::fprintf(stderr, "modifier matrix left %zu key(s) held\n",
                   input.held_count());
      XCloseDisplay(display);
      return 87;
    }
    std::printf("XTest modifier matrix: all supported combinations held through key and released\n");
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

    // PasteText is asynchronous from the target application's point of view:
    // after Ctrl+V it sends SelectionRequest back to the worker's owner
    // window.  The worker must pump that request on its shared X11 sequence;
    // merely becoming the CLIPBOARD owner is not enough.
    Display* requestor_display = XOpenDisplay(nullptr);
    if (requestor_display == nullptr) {
      XCloseDisplay(display);
      return 95;
    }
    const Window requestor = XCreateSimpleWindow(
        requestor_display, DefaultRootWindow(requestor_display), 0, 0, 1, 1,
        0, 0, 0);
    XMapRaised(requestor_display, requestor);
    XSetInputFocus(requestor_display, requestor, RevertToParent, CurrentTime);
    XSync(requestor_display, False);

    const std::string payload = "paste request ";
    const std::string payload_utf8 = payload + "\xE6\xB5\x8B\xE8\xAF\x95";
    if (!clipboard.PasteText(payload_utf8)) {
      XDestroyWindow(requestor_display, requestor);
      XCloseDisplay(requestor_display);
      XCloseDisplay(display);
      return 96;
    }
    const Atom clipboard_atom = XInternAtom(requestor_display, "CLIPBOARD", False);
    const Atom utf8_atom = XInternAtom(requestor_display, "UTF8_STRING", False);
    const Atom property = XInternAtom(requestor_display, "IMCODES_PASTE_TEST", False);
    for (const Atom target : {utf8_atom, static_cast<Atom>(XA_STRING)}) {
      XConvertSelection(requestor_display, clipboard_atom, target, property,
                        requestor, CurrentTime);
      XFlush(requestor_display);
      bool answered = false;
      for (int attempt = 0; attempt < 1000 && !answered; ++attempt) {
        clipboard.PumpSelectionRequests(8);
        XSync(requestor_display, False);
        XEvent event;
        while (XCheckTypedWindowEvent(requestor_display, requestor,
                                      SelectionNotify, &event)) {
          if (event.xselection.property != property) continue;
          Atom actual_type = None;
          int actual_format = 0;
          unsigned long item_count = 0;
          unsigned long bytes_after = 0;
          unsigned char* value = nullptr;
          if (XGetWindowProperty(requestor_display, requestor, property, 0,
                                 64 * 1024, True, target, &actual_type,
                                 &actual_format, &item_count, &bytes_after,
                                 &value) != Success || actual_format != 8 ||
              item_count != payload_utf8.size() ||
              std::string(reinterpret_cast<char*>(value), item_count) !=
                  payload_utf8) {
            if (value != nullptr) XFree(value);
            XDestroyWindow(requestor_display, requestor);
            XCloseDisplay(requestor_display);
            XCloseDisplay(display);
            return target == utf8_atom ? 97 : 98;
          }
          if (value != nullptr) XFree(value);
          answered = true;
          break;
        }
        if (!answered) usleep(1'000);
      }
      if (!answered) {
        XDestroyWindow(requestor_display, requestor);
        XCloseDisplay(requestor_display);
        XCloseDisplay(display);
        return target == utf8_atom ? 99 : 100;
      }
    }
    std::printf("PasteText: worker pump served UTF8_STRING and STRING requests\n");
    XDestroyWindow(requestor_display, requestor);
    XCloseDisplay(requestor_display);

    // Clear PRIMARY/CLIPBOARD and verify CopySelection injects Ctrl+C for an
    // app that does NOT populate PRIMARY -- even when owns_clipboard_ was true
    // from PasteText() above and a stale PRIMARY exists, AND when WM_CLASS
    // contains the substring "st" (must NOT be misclassified as suckless st).
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale primary")) {
        XCloseDisplay(display);
        return 101;
      }
      if (!clipboard.PasteText("old pasted text")) {
        XCloseDisplay(display);
        return 102;
      }
      ShortcutCopyClient studio_app;
      if (!studio_app.Open("StudioApp", "studio", false, false,
                           "fresh \xe9\x80\x89\xe4\xb8\xad text")) {
        XCloseDisplay(display);
        return 103;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "fresh \xe9\x80\x89\xe4\xb8\xad text") {
        std::fprintf(stderr,
                     "CopySelection after PasteText returned [%s], expected fresh Ctrl+C selection\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 104;
      }
      // Repeat copy of the identical text in the same focused app must resolve
      // promptly via XFixesSetSelectionOwnerNotify rather than timing out.
      const auto repeat_start = std::chrono::steady_clock::now();
      std::string repeated;
      if (!clipboard.CopySelection(&repeated) ||
          repeated != "fresh \xe9\x80\x89\xe4\xb8\xad text") {
        std::fprintf(stderr, "Repeat CopySelection returned [%s]\n", repeated.c_str());
        XCloseDisplay(display);
        return 105;
      }
      const auto repeat_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::steady_clock::now() - repeat_start)
                                 .count();
      if (repeat_ms > 180) {
        std::fprintf(stderr, "Repeat CopySelection took %lldms (expected XFixes fast path)\n",
                     static_cast<long long>(repeat_ms));
        XCloseDisplay(display);
        return 106;
      }
      std::printf("CopySelection: Ctrl+C overrides stale PasteText/PRIMARY and repeats fast (%lldms)\n",
                  static_cast<long long>(repeat_ms));
    }

    // Terminal with input focus on an unnamed child window whose WM_CLASS is on
    // the top-level ancestor: CopySelection must inject Ctrl+Shift+C and NEVER
    // bare Ctrl+C (SIGINT), including when XGetInputFocus reports PointerRoot
    // or DefaultRootWindow with pointer over the terminal's child window.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      ShortcutCopyClient terminal_app;
      if (!terminal_app.Open("Gnome-terminal", "gnome-terminal-server", true,
                             true, "terminal \xe5\xa4\x8d\xe5\x88\xb6 output")) {
        XCloseDisplay(display);
        return 107;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "terminal \xe5\xa4\x8d\xe5\x88\xb6 output") {
        std::fprintf(stderr, "Terminal CopySelection returned [%s]\n", copied.c_str());
        XCloseDisplay(display);
        return 108;
      }
      if (terminal_app.saw_bare_ctrl_c.load()) {
        std::fprintf(stderr, "Terminal CopySelection sent bare Ctrl+C (SIGINT hazard)\n");
        XCloseDisplay(display);
        return 109;
      }

      // Now move focus to PointerRoot with pointer over the terminal child:
      // CopySelection must resolve the pointer window ancestor as terminal,
      // send Ctrl+Shift+C (zero bare Ctrl+C), and read the copied output.
      XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
      XWarpPointer(display, None, terminal_app.top_window, 0, 0, 0, 0, 20, 20);
      XSetInputFocus(display, PointerRoot, RevertToParent, CurrentTime);
      XSync(display, False);
      copied.clear();
      if (!clipboard.CopySelection(&copied) ||
          copied != "terminal \xe5\xa4\x8d\xe5\x88\xb6 output") {
        std::fprintf(stderr, "PointerRoot terminal CopySelection returned [%s]\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 112;
      }
      if (terminal_app.saw_bare_ctrl_c.load()) {
        std::fprintf(stderr, "PointerRoot terminal CopySelection sent bare Ctrl+C\n");
        XCloseDisplay(display);
        return 113;
      }

      // Focus on root with pointer over bare root background: focus target is
      // unconfirmed -> CopySelection must NOT inject Ctrl+C and instead fall
      // back to PRIMARY.
      XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
      SelectionOwner root_primary;
      if (!root_primary.Own("PRIMARY", "root fallback text")) {
        XCloseDisplay(display);
        return 114;
      }
      XWarpPointer(display, None, DefaultRootWindow(display), 0, 0, 0, 0, 400, 400);
      XSetInputFocus(display, DefaultRootWindow(display), RevertToParent, CurrentTime);
      XSync(display, False);
      const int c_before = terminal_app.any_c_count.load();
      copied.clear();
      if (!clipboard.CopySelection(&copied) || copied != "root fallback text" ||
          terminal_app.any_c_count.load() != c_before ||
          terminal_app.saw_bare_ctrl_c.load()) {
        std::fprintf(stderr, "Root focus fallback failed: copied=[%s]\n", copied.c_str());
        XCloseDisplay(display);
        return 115;
      }
      std::printf("CopySelection: ancestor-WM_CLASS and PointerRoot terminal received Ctrl+Shift+C with no SIGINT; unconfirmed root skipped injection\n");
    }

    // MIME fallback: owner rejects UTF8_STRING and answers only text/plain;charset=utf-8.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner mime_owner;
      if (!mime_owner.Own("CLIPBOARD", "mime utf8 \xe4\xb8\xad\xe6\x96\x87",
                          "text/plain;charset=utf-8")) {
        XCloseDisplay(display);
        return 110;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "mime utf8 \xe4\xb8\xad\xe6\x96\x87") {
        std::fprintf(stderr, "MIME UTF-8 CopySelection returned [%s]\n", copied.c_str());
        XCloseDisplay(display);
        return 111;
      }
      std::printf("CopySelection: ReadSelection fell back to text/plain;charset=utf-8\n");
    }

    // Unresponsive CLIPBOARD owner + available PRIMARY must fall back within <= 500ms.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner silent_clipboard;
      if (!silent_clipboard.Own("CLIPBOARD", "ignored", "UTF8_STRING", -1)) {
        XCloseDisplay(display);
        return 116;
      }
      SelectionOwner fallback_primary;
      if (!fallback_primary.Own("PRIMARY", "primary under silent clipboard")) {
        XCloseDisplay(display);
        return 117;
      }
      ShortcutCopyClient idle_app;
      if (!idle_app.Open("IdleEditor", "idle-editor", false, true, "unused")) {
        XCloseDisplay(display);
        return 118;
      }
      const auto started = std::chrono::steady_clock::now();
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "primary under silent clipboard") {
        std::fprintf(stderr,
                     "Unresponsive CLIPBOARD fallback returned [%s], expected PRIMARY\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 119;
      }
      const auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - started)
              .count();
      if (elapsed_ms > 500) {
        std::fprintf(stderr, "Unresponsive CLIPBOARD fallback took %lldms (>500ms budget)\n",
                     static_cast<long long>(elapsed_ms));
        XCloseDisplay(display);
        return 120;
      }
      std::printf("CopySelection: unresponsive CLIPBOARD fell back to PRIMARY in %lldms (<=500ms)\n",
                  static_cast<long long>(elapsed_ms));
    }

    // Late SelectionNotify isolation: delayed baseline CLIPBOARD reply arrives
    // AFTER CopySelection()'s baseline timeout retired request_window_ and
    // started Request #2 for the newly copied app. Must return Request #2's
    // value, NEVER the late baseline reply.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner delayed_baseline;
      if (!delayed_baseline.Own("CLIPBOARD", "stale delayed baseline",
                                "UTF8_STRING", 110)) {
        XCloseDisplay(display);
        return 121;
      }
      ShortcutCopyClient delayed_fresh;
      if (!delayed_fresh.Open("FreshApp", "fresh-app", false, false,
                              "fresh request 2 value", false, 20, 45)) {
        XCloseDisplay(display);
        return 122;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) || copied != "fresh request 2 value") {
        std::fprintf(stderr,
                     "Late SelectionNotify polluted Request #2: got [%s]\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 123;
      }
      std::printf("CopySelection: retired timed-out requestor rejected late SelectionNotify\n");
    }

    // Explicit INCR rejection on a newly updated CLIPBOARD must return false
    // rather than falling back to stale PRIMARY.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale short primary")) {
        XCloseDisplay(display);
        return 124;
      }
      ShortcutCopyClient incr_app;
      if (!incr_app.Open("LargeDocApp", "large-doc-app", false, false, "", true)) {
        XCloseDisplay(display);
        return 125;
      }
      std::string copied = "should clear";
      if (clipboard.CopySelection(&copied) || !copied.empty()) {
        std::fprintf(stderr,
                     "INCR CLIPBOARD update fell back to [%s], expected refusal\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 126;
      }
      std::printf("CopySelection: INCR rejection stopped copy cleanly without stale PRIMARY fallback\n");
    }

    // Oversized (>12KB) UTF-8 reply must also be rejected cleanly without
    // falling back to stale PRIMARY.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale short primary")) {
        XCloseDisplay(display);
        return 127;
      }
      ShortcutCopyClient huge_app;
      if (!huge_app.Open("HugeDocApp", "huge-doc-app", false, false,
                         std::string(13 * 1024, 'x'))) {
        XCloseDisplay(display);
        return 128;
      }
      std::string copied;
      if (clipboard.CopySelection(&copied) || !copied.empty()) {
        std::fprintf(stderr,
                     "Oversized (>12KB) CLIPBOARD update returned [%zu bytes], expected refusal\n",
                     copied.size());
        XCloseDisplay(display);
        return 129;
      }
      std::printf("CopySelection: >12KB rejection stopped copy cleanly without stale PRIMARY fallback\n");
    }

    // Same-owner INCR transition (owner already held CLIPBOARD with short
    // UTF-8 before Ctrl+C, then switched buffer to INCR without calling
    // XSetSelectionOwner): must still fail closed instead of returning stale
    // PRIMARY.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale primary")) {
        XCloseDisplay(display);
        return 141;
      }
      ShortcutCopyClient same_owner_incr;
      if (!same_owner_incr.Open("EditorApp", "editor", false, false,
                                "before copy short", false, 0, 0, true, true)) {
        XCloseDisplay(display);
        return 142;
      }
      std::string copied = "should clear";
      if (clipboard.CopySelection(&copied) || !copied.empty() ||
          same_owner_incr.copy_count.load() != 1) {
        std::fprintf(stderr,
                     "Same-owner INCR transition returned [%s] (shortcuts=%d), expected refusal\n",
                     copied.c_str(), same_owner_incr.copy_count.load());
        XCloseDisplay(display);
        return 143;
      }
      std::printf("CopySelection: same-owner UTF-8 -> INCR failed closed without stale PRIMARY\n");
    }

    // Focus switch during baseline read: copy starts with non-terminal Editor
    // focused, and during the baseline CLIPBOARD request the owner switches
    // input focus to a child window whose ancestor WM_CLASS is a terminal.
    // CopySelection must re-classify AFTER baseline and send Ctrl+Shift+C (0
    // bare Ctrl+C).
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      ShortcutCopyClient terminal_app;
      if (!terminal_app.Open("Gnome-terminal", "gnome-terminal-server", true,
                             true, "terminal after focus switch")) {
        XCloseDisplay(display);
        return 130;
      }
      ShortcutCopyClient normal_app;
      if (!normal_app.Open("EditorApp", "editor", false, false, "editor unused")) {
        XCloseDisplay(display);
        return 131;
      }
      SelectionOwner switching_baseline;
      if (!switching_baseline.Own("CLIPBOARD", "old baseline", "UTF8_STRING", 0,
                                  terminal_app.focus_window)) {
        XCloseDisplay(display);
        return 132;
      }
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "terminal after focus switch" ||
          terminal_app.saw_bare_ctrl_c.load()) {
        std::fprintf(stderr,
                     "Focus-switch baseline test failed: copied=[%s] bare_ctrl_c=%d\n",
                     copied.c_str(), terminal_app.saw_bare_ctrl_c.load() ? 1 : 0);
        XCloseDisplay(display);
        return 133;
      }
      std::printf("CopySelection: re-classified focus after baseline switch (zero bare Ctrl+C)\n");
    }

    // Unresponsive PRIMARY + healthy CLIPBOARD (both focus=None and retry after
    // timed-out 80ms post-shortcut probe) must still return CLIPBOARD within <= 500ms.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner silent_primary;
      if (!silent_primary.Own("PRIMARY", "ignored", "UTF8_STRING", -1)) {
        XCloseDisplay(display);
        return 134;
      }
      SelectionOwner healthy_clipboard;
      if (!healthy_clipboard.Own("CLIPBOARD", "healthy clipboard under dead primary")) {
        XCloseDisplay(display);
        return 135;
      }
      XSetInputFocus(display, None, RevertToParent, CurrentTime);
      XSync(display, False);
      const auto started = std::chrono::steady_clock::now();
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "healthy clipboard under dead primary") {
        std::fprintf(stderr,
                     "Dead-PRIMARY healthy-CLIPBOARD focus=None returned [%s]\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 136;
      }
      const auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - started)
              .count();
      if (elapsed_ms > 500) {
        std::fprintf(stderr, "Dead-PRIMARY focus=None took %lldms (>500ms)\n",
                     static_cast<long long>(elapsed_ms));
        XCloseDisplay(display);
        return 137;
      }
      std::printf("CopySelection: unresponsive PRIMARY reserved time for healthy CLIPBOARD (%lldms <= 500ms)\n",
                  static_cast<long long>(elapsed_ms));
    }

    // Post-shortcut 80ms timeout probe must remain retryable within remaining
    // budget instead of failing closed.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      ShortcutCopyClient slow_same_owner;
      if (!slow_same_owner.Open("EditorApp", "editor", false, true,
                                "slow post probe value", false, 0, 105, true, false)) {
        XCloseDisplay(display);
        return 138;
      }
      const auto started = std::chrono::steady_clock::now();
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "slow post probe value") {
        std::fprintf(stderr, "Timed-out 80ms probe retry failed: got [%s]\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 139;
      }
      const auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - started)
              .count();
      if (elapsed_ms > 500) {
        std::fprintf(stderr, "Timed-out 80ms probe retry took %lldms (>500ms)\n",
                     static_cast<long long>(elapsed_ms));
        XCloseDisplay(display);
        return 140;
      }
      std::printf("CopySelection: timed-out post probe retried within budget (%lldms <= 500ms)\n",
                  static_cast<long long>(elapsed_ms));
    }

    // Confirmed CLIPBOARD update whose INCR reply arrives after 155ms (>140ms)
    // must still fail closed rather than falling back to stale PRIMARY, and
    // must settle within <= 500ms.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale primary")) {
        XCloseDisplay(display);
        return 144;
      }
      ShortcutCopyClient delayed_incr;
      if (!delayed_incr.Open("EditorApp", "editor", false, false, "",
                             true, 0, 155)) {
        XCloseDisplay(display);
        return 145;
      }
      const auto started = std::chrono::steady_clock::now();
      std::string copied = "should clear";
      if (clipboard.CopySelection(&copied) || !copied.empty() ||
          delayed_incr.copy_count.load() != 1) {
        std::fprintf(stderr,
                     "Delayed 155ms INCR fell back to [%s] (shortcuts=%d), expected refusal\n",
                     copied.c_str(), delayed_incr.copy_count.load());
        XCloseDisplay(display);
        return 146;
      }
      const auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - started)
              .count();
      if (elapsed_ms > 500) {
        std::fprintf(stderr, "Delayed 155ms INCR took %lldms (>500ms)\n",
                     static_cast<long long>(elapsed_ms));
        XCloseDisplay(display);
        return 147;
      }
      std::printf("CopySelection: delayed 155ms INCR after confirmed update failed closed (%lldms <= 500ms)\n",
                  static_cast<long long>(elapsed_ms));
    }

    // Confirmed CLIPBOARD update whose valid short text arrives after 155ms
    // (>140ms) must return that text rather than falling back to stale PRIMARY.
    XSetSelectionOwner(display, XA_PRIMARY, None, CurrentTime);
    XSetSelectionOwner(display, clipboard_atom, None, CurrentTime);
    XSync(display, False);
    {
      SelectionOwner stale_primary;
      if (!stale_primary.Own("PRIMARY", "stale primary")) {
        XCloseDisplay(display);
        return 148;
      }
      ShortcutCopyClient delayed_short;
      if (!delayed_short.Open("EditorApp", "editor", false, false,
                              "delayed short text", false, 0, 155)) {
        XCloseDisplay(display);
        return 149;
      }
      const auto started = std::chrono::steady_clock::now();
      std::string copied;
      if (!clipboard.CopySelection(&copied) ||
          copied != "delayed short text") {
        std::fprintf(stderr,
                     "Delayed 155ms short copy returned [%s], expected delayed short text\n",
                     copied.c_str());
        XCloseDisplay(display);
        return 150;
      }
      const auto elapsed_ms =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now() - started)
              .count();
      if (elapsed_ms > 500) {
        std::fprintf(stderr, "Delayed 155ms short copy took %lldms (>500ms)\n",
                     static_cast<long long>(elapsed_ms));
        XCloseDisplay(display);
        return 151;
      }
      std::printf("CopySelection: delayed 155ms short reply after confirmed update returned text (%lldms <= 500ms)\n",
                  static_cast<long long>(elapsed_ms));
    }

    // Passive clipboard observer: ResetRemoteClipboardObserver drops stale
    // baseline, external CLIPBOARD owner triggers PollRemoteClipboardChange
    // once without duplicates, and PasteText suppresses echo.
    {
      SelectionOwner baseline_owner;
      if (!baseline_owner.Own("CLIPBOARD", "preexisting baseline")) {
        XCloseDisplay(display);
        return 152;
      }
      clipboard.ResetRemoteClipboardObserver();
      std::string polled;
      if (clipboard.PollRemoteClipboardChange(&polled)) {
        std::fprintf(stderr, "PollRemoteClipboardChange emitted stale baseline [%s]\n", polled.c_str());
        XCloseDisplay(display);
        return 153;
      }
      SelectionOwner external_owner;
      if (!external_owner.Own("CLIPBOARD", "external passive \xE5\xA4\x8D\xE5\x88\xB6")) {
        XCloseDisplay(display);
        return 154;
      }
      if (!clipboard.PollRemoteClipboardChange(&polled) ||
          polled != "external passive \xE5\xA4\x8D\xE5\x88\xB6") {
        std::fprintf(stderr, "PollRemoteClipboardChange missed external copy: [%s]\n", polled.c_str());
        XCloseDisplay(display);
        return 155;
      }
      if (clipboard.PollRemoteClipboardChange(&polled)) {
        std::fprintf(stderr, "PollRemoteClipboardChange duplicated [%s]\n", polled.c_str());
        XCloseDisplay(display);
        return 156;
      }
      if (!clipboard.PasteText("from browser local paste")) {
        XCloseDisplay(display);
        return 157;
      }
      if (clipboard.PollRemoteClipboardChange(&polled)) {
        std::fprintf(stderr, "PollRemoteClipboardChange echoed PasteText [%s]\n", polled.c_str());
        XCloseDisplay(display);
        return 158;
      }
      // Same-text external re-copy after PasteText must still push to browser.
      SelectionOwner same_text_owner;
      if (!same_text_owner.Own("CLIPBOARD", "from browser local paste")) {
        XCloseDisplay(display);
        return 159;
      }
      if (!clipboard.PollRemoteClipboardChange(&polled) ||
          polled != "from browser local paste") {
        std::fprintf(stderr, "PollRemoteClipboardChange swallowed same-text re-copy: [%s]\n", polled.c_str());
        XCloseDisplay(display);
        return 160;
      }
      std::printf("PollRemoteClipboardChange: pushes external copies once, suppresses PasteText echo, and pushes same-text re-copy\n");
    }
  }

  XCloseDisplay(display);
  std::printf("linux x11 fallback qualification: ok\n");
  return 0;
}
