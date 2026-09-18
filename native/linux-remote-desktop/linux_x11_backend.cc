#include "linux_x11_backend.h"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/Xrandr.h>
#include <X11/extensions/XShm.h>
#include <X11/keysym.h>

namespace imcodes::remote_desktop::linux_platform {
namespace {

using common::CapturedFrame;
using common::DesktopTopology;
using common::DisplayTopology;
using common::PixelSize;
using common::ReadinessState;

Display* Dpy(const std::shared_ptr<X11Connection>& connection) noexcept {
  return connection ? static_cast<Display*>(connection->display()) : nullptr;
}

std::int64_t NowMicroseconds() noexcept {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

/** Owns the XImage that backs a captured frame so no extra copy is needed. */
class XImageStorage final : public common::FrameStorage {
 public:
  explicit XImageStorage(XImage* image) noexcept : image_(image) {}
  ~XImageStorage() override {
    if (image_ != nullptr) XDestroyImage(image_);
  }

  XImageStorage(const XImageStorage&) = delete;
  XImageStorage& operator=(const XImageStorage&) = delete;

  [[nodiscard]] const std::byte* data() const noexcept override {
    return reinterpret_cast<const std::byte*>(image_->data);
  }
  [[nodiscard]] std::size_t size() const noexcept override {
    return static_cast<std::size_t>(image_->bytes_per_line) *
           static_cast<std::size_t>(image_->height);
  }

 private:
  XImage* image_ = nullptr;
};

/**
 * Map a protocol key name to an X keysym.
 *
 * Named keys go through XStringToKeysym; a single character falls back to its
 * literal keysym so ordinary typing works without a lookup table.
 */
KeySym KeySymForName(std::string_view key) noexcept {
  const std::string name(key);
  KeySym symbol = XStringToKeysym(name.c_str());
  if (symbol != NoSymbol) return symbol;
  if (name.size() == 1) return static_cast<KeySym>(name[0]);
  return NoSymbol;
}

/**
 * Decode ONE Unicode codepoint starting at text[index], UTF-8. Returns the
 * codepoint and advances *consumed past the bytes it used. A malformed or
 * truncated sequence (a bare continuation byte, a lead byte with no/invalid
 * continuations, an overlong encoding's lead byte) returns codepoint 0 with
 * *consumed = 1 -- always makes forward progress by at least one byte, so a
 * corrupt string can never spin the caller's loop forever, and 0 is never a
 * real character EmitText needs to type (U+0000 cannot occur in the bounded,
 * validated protocol text this is fed -- see json_protocol.h's
 * ReadBoundedString/the shared isBoundedString validator).
 */
std::uint32_t DecodeUtf8Codepoint(std::string_view text, std::size_t index,
                                  std::size_t* consumed) noexcept {
  *consumed = 1;
  const auto byte_at = [&](std::size_t offset) -> std::uint8_t {
    return static_cast<std::uint8_t>(text[index + offset]);
  };
  const std::uint8_t lead = byte_at(0);
  int extra = 0;
  std::uint32_t codepoint = 0;
  if ((lead & 0x80) == 0x00) {
    return lead;
  } else if ((lead & 0xE0) == 0xC0) {
    extra = 1;
    codepoint = lead & 0x1F;
  } else if ((lead & 0xF0) == 0xE0) {
    extra = 2;
    codepoint = lead & 0x0F;
  } else if ((lead & 0xF8) == 0xF0) {
    extra = 3;
    codepoint = lead & 0x07;
  } else {
    return 0;  // A continuation byte or invalid lead byte on its own.
  }
  if (index + static_cast<std::size_t>(extra) >= text.size()) return 0;
  for (int i = 1; i <= extra; ++i) {
    const std::uint8_t continuation = byte_at(static_cast<std::size_t>(i));
    if ((continuation & 0xC0) != 0x80) return 0;  // Not a continuation byte.
    codepoint = (codepoint << 6) | (continuation & 0x3F);
  }
  *consumed = static_cast<std::size_t>(extra) + 1;
  return codepoint;
}

/**
 * The X11 protocol key NAME for one Unicode codepoint, suitable for
 * KeySymForName above. ASCII (<= 0x7F) reuses the exact same single-byte
 * fast path EmitText already had -- zero behavior change for plain-ASCII
 * text, still resolved through XStringToKeysym first and the raw-cast
 * fallback second, exactly as before. Anything wider is the "U" + hex
 * codepoint form keysymdef.h documents as valid for EVERY Unicode character
 * from U+0100 to U+10FFFF ("every possible Unicode character has already a
 * keysym string defined algorithmically") -- confirmed live against a real
 * X server: XStringToKeysym("U4E2D") for the real 3-byte UTF-8 encoding of U+4E2D returns
 * exactly 0x1004e2d, matching the header's own 0x01000000+codepoint formula
 * bit for bit.
 */
std::string KeyNameForCodepoint(std::uint32_t codepoint) {
  if (codepoint == 0) return std::string();
  if (codepoint <= 0x7F) return std::string(1, static_cast<char>(codepoint));
  char name[16];
  std::snprintf(name, sizeof(name), "U%04X", codepoint);
  return std::string(name);
}

/** Protocol button names to X button numbers. Wheel is emitted separately. */
unsigned int ButtonNumber(std::string_view button) noexcept {
  if (button == "left") return 1;
  if (button == "middle") return 2;
  if (button == "right") return 3;
  if (button == "back") return 8;
  if (button == "forward") return 9;
  return 0;
}

}  // namespace

// ── X11Connection ──────────────────────────────────────────────────────────

std::shared_ptr<X11Connection> X11Connection::Open(std::string_view display_name) {
  // X11CaptureAdapter polls on its own background thread while input/
  // clipboard calls happen on whichever thread the caller drives the session
  // from, all against this one shared Display*. XInitThreads() makes Xlib's
  // own locking cover that, and it must run before the FIRST XOpenDisplay
  // call in the process -- calling it here, unconditionally, is safe: Xlib
  // documents repeat calls as a no-op after the first.
  XInitThreads();
  const std::string name(display_name);
  Display* display = XOpenDisplay(name.empty() ? nullptr : name.c_str());
  if (display == nullptr) return nullptr;

  std::shared_ptr<X11Connection> connection(new X11Connection());
  connection->display_ = display;

  int event_base = 0;
  int error_base = 0;
  int major = 0;
  int minor = 0;
  connection->has_xtest_ =
      XTestQueryExtension(display, &event_base, &error_base, &major, &minor) == True;
  connection->has_xfixes_ = XFixesQueryExtension(display, &event_base, &error_base) == True;
  connection->has_randr_ = XRRQueryExtension(display, &event_base, &error_base) == True;
  connection->has_xshm_ = XShmQueryExtension(display) == True;
  return connection;
}

X11Connection::~X11Connection() {
  if (display_ != nullptr) XCloseDisplay(static_cast<Display*>(display_));
}

SessionFacts X11Connection::MeasureFacts() const noexcept {
  SessionFacts facts;
  const char* wayland = std::getenv("WAYLAND_DISPLAY");
  facts.display_server = (wayland != nullptr && wayland[0] != '\0')
      ? DisplayServer::kWayland
      : DisplayServer::kX11;
  // A server we opened and can drive is the graphical session under test.
  facts.graphical_session_present = display_ != nullptr;
  const char* bus = std::getenv("DBUS_SESSION_BUS_ADDRESS");
  facts.session_bus_present = bus != nullptr && bus[0] != '\0';
  facts.xtest_present = has_xtest_;
  facts.xfixes_present = has_xfixes_;
  facts.randr_present = has_randr_;
  return facts;
}

// ── X11CaptureAdapter ──────────────────────────────────────────────────────

X11CaptureAdapter::X11CaptureAdapter(std::shared_ptr<X11Connection> connection) noexcept
    : connection_(std::move(connection)) {}

X11CaptureAdapter::~X11CaptureAdapter() { Stop(); }

ReadinessState X11CaptureAdapter::ProbeReadiness() {
  Display* display = Dpy(connection_);
  if (display == nullptr) return ReadinessState::kUnavailable;
  return ProbeCaptureReadiness(connection_->MeasureFacts());
}

bool X11CaptureAdapter::CaptureOnce(const DisplayTopology& display_topology,
                                    CapturedFrame* frame) {
  Display* display = Dpy(connection_);
  if (display == nullptr || frame == nullptr) return false;

  Window root = DefaultRootWindow(display);
  XWindowAttributes attributes;
  if (XGetWindowAttributes(display, root, &attributes) == 0) return false;

  unsigned int width = static_cast<unsigned int>(attributes.width);
  unsigned int height = static_cast<unsigned int>(attributes.height);
  if (display_topology.encoded_pixels.IsValid()) {
    width = std::min(width, display_topology.encoded_pixels.width);
    height = std::min(height, display_topology.encoded_pixels.height);
  }
  if (width == 0 || height == 0) return false;

  // XShm would avoid the server-side copy, but plain XGetImage keeps the
  // fallback dependency-light and correct on every server; the shared-memory
  // path is reported by has_xshm() for a later optimisation.
  XImage* image = XGetImage(display, root, 0, 0, width, height, AllPlanes, ZPixmap);
  if (image == nullptr) return false;
  if (image->bits_per_pixel != 32) {
    // The common frame contract is BGRA8888. Refuse rather than hand back a
    // frame in a layout the encoder would misread.
    XDestroyImage(image);
    return false;
  }

  frame->encoded_pixels = PixelSize{width, height};
  frame->pixel_format = common::PixelFormat::kBgra8888;
  frame->row_bytes = static_cast<std::uint32_t>(image->bytes_per_line);
  frame->capture_time_us = NowMicroseconds();
  frame->storage = std::make_shared<XImageStorage>(image);
  return true;
}

namespace {
// 30fps: comfortably inside what a plain (non-shared-memory) XGetImage poll
// sustains for a qualification/demo capture, and a sane default frame rate
// for a screen-share session generally. Real bitrate/frame-rate selection
// belongs to the quality ladder, once this adapter is driven by a real
// session rather than a one-shot Start() caller.
constexpr auto kPollInterval = std::chrono::milliseconds(33);
}  // namespace

bool X11CaptureAdapter::Start(const DisplayTopology& display_topology,
                              common::CapturedFrameSink sink) {
  if (ProbeReadiness() != ReadinessState::kReady || !sink) return false;
  if (running_.exchange(true)) return false;  // already started
  CapturedFrame frame;
  if (!CaptureOnce(display_topology, &frame)) {
    running_ = false;
    return false;
  }
  sink(frame);
  // The first frame is delivered synchronously so a caller (e.g. a
  // qualification harness) learns immediately whether capture actually
  // works; the poll thread then keeps the feed alive for as long as a real
  // session runs.
  poll_thread_ = std::thread(&X11CaptureAdapter::PollLoop, this,
                             display_topology, std::move(sink));
  return true;
}

void X11CaptureAdapter::PollLoop(DisplayTopology display,
                                 common::CapturedFrameSink sink) {
  while (running_.load(std::memory_order_relaxed)) {
    const auto tick_started = std::chrono::steady_clock::now();
    CapturedFrame frame;
    if (CaptureOnce(display, &frame)) sink(frame);
    const auto elapsed = std::chrono::steady_clock::now() - tick_started;
    if (elapsed < kPollInterval) {
      std::this_thread::sleep_for(kPollInterval - elapsed);
    }
  }
}

void X11CaptureAdapter::Stop() noexcept {
  running_ = false;
  if (poll_thread_.joinable()) poll_thread_.join();
}

// ── X11InputAdapter ────────────────────────────────────────────────────────

X11InputAdapter::X11InputAdapter(std::shared_ptr<X11Connection> connection) noexcept
    : connection_(std::move(connection)) {}

X11InputAdapter::~X11InputAdapter() { ReleaseAllEmittedState(); }

ReadinessState X11InputAdapter::ProbeReadiness() {
  Display* display = Dpy(connection_);
  if (display == nullptr) return ReadinessState::kUnavailable;
  return ProbeInputReadiness(connection_->MeasureFacts());
}

bool X11InputAdapter::MovePointer(const common::LogicalPoint& point) {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) return false;
  if (XTestFakeMotionEvent(display, -1, static_cast<int>(point.x),
                           static_cast<int>(point.y), 0) == 0) {
    return false;
  }
  XSync(display, False);
  return true;
}

/**
 * A keysym with no keycode in the CURRENT layout (every CJK/non-Latin
 * character, on a plain US/Xvfb layout) cannot be typed via
 * XTestFakeKeyEvent no matter how correctly it was computed -- confirmed
 * live: XKeysymToKeycode returns 0 for a verified-correct Unicode keysym on
 * an unmodified Xvfb layout. xdotool solves the identical problem the same
 * way this does: temporarily remap one scratch keycode (this display's own
 * highest keycode, from XDisplayKeycodes) to the target keysym via
 * XChangeKeyboardMapping, then explicitly drain and process the MappingNotify
 * it generates (XRefreshKeyboardMapping -- Xlib's own documented mechanism;
 * XSync alone is not enough, confirmed live: it guarantees the SERVER
 * processed the change but not that Xlib's own client-side keysym cache
 * reflects it yet) before reusing that keycode. Cached by
 * scratch_mapped_keysym_ so a run of the same character (or simple repeats)
 * does not re-remap every single keystroke; a DIFFERENT target keysym still
 * costs one remap, same as the first character ever typed.
 */
unsigned long X11InputAdapter::EnsureScratchKeycodeFor(unsigned long symbol_value) {
  Display* display = Dpy(connection_);
  if (display == nullptr) return 0;
  const KeySym symbol = static_cast<KeySym>(symbol_value);
  [[maybe_unused]] int min_keycode = 0;
  int max_keycode = 0;
  XDisplayKeycodes(display, &min_keycode, &max_keycode);
  if (max_keycode <= 0) return 0;
  const KeyCode scratch = static_cast<KeyCode>(max_keycode);
  if (scratch_mapped_keysym_ == symbol_value) {
    // Still exactly what we last mapped there; no server round trip needed.
    return scratch;
  }
  // XChangeKeyboardMapping's own return value is not a reliable success
  // signal (confirmed live: checking it for == 0 as "failure" caused this
  // function to wrongly reject a remap that, per the very next
  // XKeysymToKeycode readback below, had genuinely taken effect -- X11's own
  // convention is that a real protocol error surfaces asynchronously via the
  // error handler, not synchronously via this call's return). The
  // MappingNotify-drained XKeysymToKeycode readback a few lines down is the
  // one signal actually trusted here, matching this file's own established
  // "prove it against real server state" rule.
  KeySym new_map[1] = {symbol};
  XChangeKeyboardMapping(display, scratch, 1, new_map, 1);
  XSync(display, False);
  // MappingNotify is delivered to every client automatically (no
  // XSelectInput needed); draining and processing it via
  // XRefreshKeyboardMapping is what actually keeps Xlib's OWN client-side
  // keysym cache in sync -- XSync alone only guarantees the server has
  // processed the change, not that this process's cache reflects it yet.
  // See this function's own header comment for the live evidence this
  // mattered in practice.
  XEvent mapping_event;
  while (XCheckTypedEvent(display, MappingNotify, &mapping_event)) {
    XRefreshKeyboardMapping(&mapping_event.xmapping);
  }
  if (XKeysymToKeycode(display, symbol) != scratch) {
    // The server did not actually accept the remap (should not happen given
    // the live probe this design was verified against, but EmitKey's own
    // caller-facing contract is "false means genuinely not typeable", never
    // a silent wrong character).
    scratch_mapped_keysym_ = 0;
    return 0;
  }
  scratch_mapped_keysym_ = symbol_value;
  return scratch;
}

bool X11InputAdapter::EmitKey(std::string_view key, bool pressed) {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) return false;
  const KeySym symbol = KeySymForName(key);
  if (symbol == NoSymbol) return false;
  KeyCode code = XKeysymToKeycode(display, symbol);
  if (code == 0) {
    code = static_cast<KeyCode>(EnsureScratchKeycodeFor(static_cast<unsigned long>(symbol)));
    if (code == 0) return false;
  }
  if (XTestFakeKeyEvent(display, code, pressed ? True : False, 0) == 0) return false;
  XSync(display, False);
  if (pressed) held_keys_.insert(code);
  else held_keys_.erase(code);
  return true;
}

bool X11InputAdapter::EmitButton(std::string_view button, bool pressed) {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) return false;
  const unsigned int number = ButtonNumber(button);
  if (number == 0) return false;
  if (XTestFakeButtonEvent(display, number, pressed ? True : False, 0) == 0) return false;
  XSync(display, False);
  if (pressed) held_buttons_.insert(number);
  else held_buttons_.erase(number);
  return true;
}

bool X11InputAdapter::EmitWheel(double delta_x, double delta_y) {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) return false;
  // X11 models wheel notches as button 4/5 (vertical) and 6/7 (horizontal).
  // Each notch is a press/release pair and is never left held.
  const auto emit = [&](unsigned int number, int notches) {
    for (int i = 0; i < notches; ++i) {
      XTestFakeButtonEvent(display, number, True, 0);
      XTestFakeButtonEvent(display, number, False, 0);
    }
  };
  if (delta_y != 0.0) {
    emit(delta_y > 0 ? 4 : 5, static_cast<int>(std::abs(delta_y)));
  }
  if (delta_x != 0.0) {
    emit(delta_x > 0 ? 7 : 6, static_cast<int>(std::abs(delta_x)));
  }
  XSync(display, False);
  return true;
}

bool X11InputAdapter::EmitText(std::string_view text) {
  // Deliberately per-character through the same keysym path as EmitKey, so a
  // text burst cannot leave a key held that ReleaseAllEmittedState misses.
  // Iterated by real UTF-8 CODEPOINT, not raw byte: any multi-byte character
  // (every CJK character is 3 bytes) used to have each individual byte cast
  // through KeySymForName's single-byte fallback, almost never resolve to a
  // valid mapped keycode, and abort EmitText on the very first byte --
  // silently dropping the rest of the string. See KeyNameForCodepoint's own
  // comment for how a codepoint becomes a real, typeable X11 keysym.
  std::size_t index = 0;
  while (index < text.size()) {
    std::size_t consumed = 1;
    const std::uint32_t codepoint = DecodeUtf8Codepoint(text, index, &consumed);
    index += consumed;
    if (codepoint == 0) continue;  // Malformed byte(s) -- skip, keep going.
    const std::string name = KeyNameForCodepoint(codepoint);
    if (!EmitKey(name, true)) return false;
    if (!EmitKey(name, false)) return false;
  }
  return true;
}

void X11InputAdapter::ReleaseAllEmittedState() noexcept {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) {
    held_keys_.clear();
    held_buttons_.clear();
    return;
  }
  for (const std::uint32_t code : held_keys_) {
    XTestFakeKeyEvent(display, static_cast<KeyCode>(code), False, 0);
  }
  for (const std::uint32_t number : held_buttons_) {
    XTestFakeButtonEvent(display, number, False, 0);
  }
  XSync(display, False);
  held_keys_.clear();
  held_buttons_.clear();
}

// ── X11ClipboardAdapter ────────────────────────────────────────────────────

X11ClipboardAdapter::X11ClipboardAdapter(std::shared_ptr<X11Connection> connection) noexcept
    : connection_(std::move(connection)) {}

X11ClipboardAdapter::~X11ClipboardAdapter() {
  Display* display = Dpy(connection_);
  if (display != nullptr && window_ != 0) {
    XDestroyWindow(display, static_cast<Window>(window_));
    XFlush(display);
  }
}

ReadinessState X11ClipboardAdapter::ProbeReadiness() {
  Display* display = Dpy(connection_);
  if (display == nullptr) return ReadinessState::kUnavailable;
  return ProbeClipboardReadiness(connection_->MeasureFacts());
}

bool X11ClipboardAdapter::PasteText(std::string_view text) {
  Display* display = Dpy(connection_);
  if (display == nullptr) return false;
  if (window_ == 0) {
    window_ = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
    if (window_ == 0) return false;
  }
  owned_text_.assign(text);
  const Atom clipboard = XInternAtom(display, "CLIPBOARD", False);
  XSetSelectionOwner(display, clipboard, static_cast<Window>(window_), CurrentTime);
  XSync(display, False);
  owns_clipboard_ =
      XGetSelectionOwner(display, clipboard) == static_cast<Window>(window_);
  return owns_clipboard_;
}

void X11ClipboardAdapter::PumpSelectionRequests(int max_events) {
  Display* display = Dpy(connection_);
  if (display == nullptr || window_ == 0) return;
  const Atom utf8 = XInternAtom(display, "UTF8_STRING", False);
  const Atom targets = XInternAtom(display, "TARGETS", False);

  for (int i = 0; i < max_events && XPending(display) > 0; ++i) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type != SelectionRequest) continue;
    const XSelectionRequestEvent& request = event.xselectionrequest;

    XSelectionEvent response{};
    response.type = SelectionNotify;
    response.display = request.display;
    response.requestor = request.requestor;
    response.selection = request.selection;
    response.target = request.target;
    response.time = request.time;
    response.property = None;

    if (request.target == utf8 || request.target == XA_STRING) {
      XChangeProperty(display, request.requestor, request.property, request.target,
                      8, PropModeReplace,
                      reinterpret_cast<const unsigned char*>(owned_text_.data()),
                      static_cast<int>(owned_text_.size()));
      response.property = request.property;
    } else if (request.target == targets) {
      const Atom offered[] = {targets, utf8, XA_STRING};
      XChangeProperty(display, request.requestor, request.property, XA_ATOM, 32,
                      PropModeReplace,
                      reinterpret_cast<const unsigned char*>(offered),
                      static_cast<int>(sizeof(offered) / sizeof(offered[0])));
      response.property = request.property;
    }
    XSendEvent(display, request.requestor, False, 0,
               reinterpret_cast<XEvent*>(&response));
    XFlush(display);
  }
}

bool X11ClipboardAdapter::CopySelection(std::string* text) {
  if (text == nullptr) return false;
  Display* display = Dpy(connection_);
  if (display == nullptr) return false;

  // When this adapter owns the selection the authoritative value is local;
  // round-tripping through the server would only test the server.
  if (owns_clipboard_) {
    const Atom clipboard = XInternAtom(display, "CLIPBOARD", False);
    if (XGetSelectionOwner(display, clipboard) == static_cast<Window>(window_)) {
      text->assign(owned_text_);
      return true;
    }
    owns_clipboard_ = false;
  }

  if (window_ == 0) {
    window_ = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
    if (window_ == 0) return false;
  }
  const Atom clipboard = XInternAtom(display, "CLIPBOARD", False);
  const Atom utf8 = XInternAtom(display, "UTF8_STRING", False);
  const Atom property = XInternAtom(display, "IMCODES_CLIPBOARD", False);
  if (XGetSelectionOwner(display, clipboard) == None) return false;

  XConvertSelection(display, clipboard, utf8, property,
                    static_cast<Window>(window_), CurrentTime);
  XFlush(display);

  for (int attempt = 0; attempt < 200; ++attempt) {
    while (XPending(display) > 0) {
      XEvent event;
      XNextEvent(display, &event);
      if (event.type != SelectionNotify) continue;
      if (event.xselection.property == None) return false;
      Atom actual_type = None;
      int actual_format = 0;
      unsigned long items = 0;
      unsigned long bytes_after = 0;
      unsigned char* data = nullptr;
      if (XGetWindowProperty(display, static_cast<Window>(window_), property, 0,
                             (1 << 20), True, AnyPropertyType, &actual_type,
                             &actual_format, &items, &bytes_after, &data) != Success) {
        return false;
      }
      if (data == nullptr) return false;
      text->assign(reinterpret_cast<const char*>(data), items);
      XFree(data);
      return true;
    }
    struct timespec pause{0, 1'000'000};
    nanosleep(&pause, nullptr);
  }
  return false;
}

// ── X11DisplayAdapter ──────────────────────────────────────────────────────

X11DisplayAdapter::X11DisplayAdapter(std::shared_ptr<X11Connection> connection) noexcept
    : connection_(std::move(connection)) {}

X11DisplayAdapter::~X11DisplayAdapter() = default;

ReadinessState X11DisplayAdapter::ProbeReadiness() {
  Display* display = Dpy(connection_);
  if (display == nullptr) return ReadinessState::kUnavailable;
  return ProbeDisplayReadiness(connection_->MeasureFacts());
}

std::optional<DesktopTopology> X11DisplayAdapter::EnumerateTopology() {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_randr()) return std::nullopt;

  Window root = DefaultRootWindow(display);
  XRRScreenResources* resources = XRRGetScreenResources(display, root);
  if (resources == nullptr) return std::nullopt;

  DesktopTopology topology;
  topology.generation = generation_;
  topology.revision = ++revision_;
  for (int i = 0; i < resources->ncrtc; ++i) {
    XRRCrtcInfo* crtc = XRRGetCrtcInfo(display, resources, resources->crtcs[i]);
    if (crtc == nullptr) continue;
    if (crtc->width > 0 && crtc->height > 0) {
      DisplayTopology entry;
      entry.display_id = std::to_string(static_cast<unsigned long>(resources->crtcs[i]));
      entry.generation = generation_;
      entry.encoded_pixels = PixelSize{crtc->width, crtc->height};
      entry.logical_input_bounds = common::LogicalRect{
          static_cast<double>(crtc->x), static_cast<double>(crtc->y),
          static_cast<double>(crtc->width), static_cast<double>(crtc->height)};
      entry.scale = 1.0;
      entry.rotation = common::DisplayRotation::k0;
      // X11 mode and scale changes are not implemented in this slice, so the
      // capability is advertised false rather than accepted and ignored.
      entry.operations.selectable = true;
      entry.operations.set_mode = false;
      entry.operations.set_scale = false;
      topology.displays.push_back(std::move(entry));
    }
    XRRFreeCrtcInfo(crtc);
  }
  XRRFreeScreenResources(resources);
  if (topology.displays.empty()) return std::nullopt;
  return topology;
}

bool X11DisplayAdapter::SelectDisplay(std::string_view display_id) {
  const auto topology = EnumerateTopology();
  if (!topology.has_value()) return false;
  const std::string wanted(display_id);
  if (topology->FindDisplay(wanted) == nullptr) return false;
  selected_display_ = wanted;
  return true;
}

bool X11DisplayAdapter::SetMode(std::string_view, PixelSize) {
  // Not implemented in this slice; EnumerateTopology advertises set_mode=false.
  return false;
}

bool X11DisplayAdapter::SetScale(std::string_view, double) {
  // Not implemented in this slice; EnumerateTopology advertises set_scale=false.
  return false;
}

// ── X11DisclosureAdapter ────────────────────────────────────────────────────

namespace {
constexpr int kDisclosureWidth = 300;
constexpr int kDisclosureHeight = 34;
constexpr int kDisclosureMargin = 12;
// A strong, unmistakable color -- the same "this is being watched" register
// screen-recording indicators everywhere use, not a color that could be
// mistaken for ordinary desktop chrome.
constexpr unsigned long kDisclosureBackground = 0xC0392B;  // 0xRRGGBB
constexpr unsigned long kDisclosureForeground = 0xFFFFFF;
}  // namespace

X11DisclosureAdapter::X11DisclosureAdapter(
    std::shared_ptr<X11Connection> connection) noexcept
    : connection_(std::move(connection)) {}

X11DisclosureAdapter::~X11DisclosureAdapter() { Hide(); }

ReadinessState X11DisclosureAdapter::ProbeReadiness() {
  return Dpy(connection_) != nullptr ? ReadinessState::kReady
                                     : ReadinessState::kUnavailable;
}

void X11DisclosureAdapter::Draw() {
  Display* display = Dpy(connection_);
  if (display == nullptr || window_ == 0) return;
  std::string text;
  {
    std::lock_guard<std::mutex> lock(text_mutex_);
    text = text_;
  }
  GC gc = reinterpret_cast<GC>(gc_);
  XSetForeground(display, gc, kDisclosureBackground);
  XFillRectangle(display, window_, gc, 0, 0, kDisclosureWidth, kDisclosureHeight);
  XSetForeground(display, gc, kDisclosureForeground);
  XDrawString(display, window_, gc, 12, kDisclosureHeight / 2 + 5,
             text.c_str(), static_cast<int>(text.size()));
  XFlush(display);
}

void X11DisclosureAdapter::RedrawLoop() {
  Display* display = Dpy(connection_);
  while (running_.load(std::memory_order_relaxed)) {
    // XCheckWindowEvent, not XNextEvent/XPending: this Display connection is
    // shared with the capture/input/clipboard adapters (each running on its
    // own thread), and a plain XNextEvent here would dequeue events
    // belonging to THEM -- most dangerously the clipboard adapter's
    // SelectionRequest events, silently breaking clipboard while this
    // indicator is showing. XCheckWindowEvent only ever removes events for
    // this exact window and mask, leaving everything else in the queue for
    // its own owner to find.
    XEvent event;
    while (XCheckWindowEvent(display, window_, ExposureMask, &event)) {
      if (event.type == Expose) Draw();
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}

bool X11DisclosureAdapter::Show(std::uint32_t viewers,
                                std::uint32_t controllers) {
  Display* display = Dpy(connection_);
  if (display == nullptr) return false;

  {
    std::lock_guard<std::mutex> lock(text_mutex_);
    text_ = "\xE2\x97\x8F Remote session: " + std::to_string(viewers) +
            " viewer(s), " + std::to_string(controllers) + " controlling";
  }

  if (window_ != 0) {
    Draw();
    return true;
  }

  const int screen = DefaultScreen(display);
  const int screen_width = DisplayWidth(display, screen);
  const int x = screen_width - kDisclosureWidth - kDisclosureMargin;
  const int y = kDisclosureMargin;

  XSetWindowAttributes attributes;
  attributes.override_redirect = True;  // Bypasses the window manager
                                        // entirely: no decoration, and always
                                        // stacked above ordinary (WM-managed)
                                        // windows -- exactly what an
                                        // indicator the local user must be
                                        // able to see needs, without
                                        // depending on any particular WM's
                                        // cooperation with "always on top".
  attributes.background_pixel = kDisclosureBackground;
  attributes.event_mask = ExposureMask;
  window_ = XCreateWindow(
      display, DefaultRootWindow(display), x, y, kDisclosureWidth,
      kDisclosureHeight, 0, CopyFromParent, InputOutput, CopyFromParent,
      CWOverrideRedirect | CWBackPixel | CWEventMask, &attributes);
  if (window_ == 0) return false;
  gc_ = static_cast<unsigned long>(reinterpret_cast<uintptr_t>(
      XCreateGC(display, window_, 0, nullptr)));
  XMapRaised(display, window_);
  Draw();

  running_ = true;
  redraw_thread_ = std::thread(&X11DisclosureAdapter::RedrawLoop, this);
  return true;
}

void X11DisclosureAdapter::Hide() noexcept {
  running_ = false;
  if (redraw_thread_.joinable()) redraw_thread_.join();
  Display* display = Dpy(connection_);
  if (display != nullptr && window_ != 0) {
    if (gc_ != 0) XFreeGC(display, reinterpret_cast<GC>(gc_));
    XDestroyWindow(display, window_);
    XFlush(display);
  }
  window_ = 0;
  gc_ = 0;
}

}  // namespace imcodes::remote_desktop::linux_platform
