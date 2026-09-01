#include "linux_x11_backend.h"

#include <chrono>
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

bool X11CaptureAdapter::Start(const DisplayTopology& display_topology,
                              common::CapturedFrameSink sink) {
  if (ProbeReadiness() != ReadinessState::kReady || !sink) return false;
  CapturedFrame frame;
  if (!CaptureOnce(display_topology, &frame)) return false;
  running_ = true;
  sink(std::move(frame));
  return true;
}

void X11CaptureAdapter::Stop() noexcept { running_ = false; }

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

bool X11InputAdapter::EmitKey(std::string_view key, bool pressed) {
  Display* display = Dpy(connection_);
  if (display == nullptr || !connection_->has_xtest()) return false;
  const KeySym symbol = KeySymForName(key);
  if (symbol == NoSymbol) return false;
  const KeyCode code = XKeysymToKeycode(display, symbol);
  if (code == 0) return false;
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
  for (const char character : text) {
    const std::string single(1, character);
    if (!EmitKey(single, true)) return false;
    if (!EmitKey(single, false)) return false;
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
  topology.revision = ++revision_;
  for (int i = 0; i < resources->ncrtc; ++i) {
    XRRCrtcInfo* crtc = XRRGetCrtcInfo(display, resources, resources->crtcs[i]);
    if (crtc == nullptr) continue;
    if (crtc->width > 0 && crtc->height > 0) {
      DisplayTopology entry;
      entry.display_id = std::to_string(static_cast<unsigned long>(resources->crtcs[i]));
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

}  // namespace imcodes::remote_desktop::linux_platform
