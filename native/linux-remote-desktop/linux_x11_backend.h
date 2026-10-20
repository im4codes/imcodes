#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_X11_BACKEND_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_X11_BACKEND_H_

// Linux-only. These adapters talk to a live X server and therefore only build
// on a host with the X11, XTEST, XFIXES and RANDR development headers.
//
// They implement the shared contracts in
// native/remote-desktop-common/platform_interfaces.h and add no protocol,
// session, transport, quality or input-ledger logic of their own. Ownership and
// release semantics for input stay in common::InputLedger, which wraps the
// InputAdapter below.

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "../remote-desktop-common/latched_modifiers.h"
#include "../remote-desktop-common/platform_interfaces.h"
#include "../remote-desktop-common/value_types.h"
#include "linux_capability_probe.h"

namespace imcodes::remote_desktop::linux_platform {

/**
 * Owns one X display connection shared by the X11 adapters.
 *
 * Adapters share a connection so a session presents one client to the server:
 * separate connections would fragment selection ownership and make clipboard
 * behaviour depend on which adapter happened to connect first.
 */
class X11Connection {
 public:
  /** Opens `display_name`, or `DISPLAY` when empty. Null on failure. */
  static std::shared_ptr<X11Connection> Open(std::string_view display_name = {});

  X11Connection(const X11Connection&) = delete;
  X11Connection& operator=(const X11Connection&) = delete;
  ~X11Connection();

  /** Facts measured from this live server, for the capability probe. */
  [[nodiscard]] SessionFacts MeasureFacts() const noexcept;

  [[nodiscard]] void* display() const noexcept { return display_; }
  [[nodiscard]] bool has_xtest() const noexcept { return has_xtest_; }
  [[nodiscard]] bool has_xfixes() const noexcept { return has_xfixes_; }
  [[nodiscard]] bool has_randr() const noexcept { return has_randr_; }
  [[nodiscard]] bool has_xshm() const noexcept { return has_xshm_; }

 private:
  X11Connection() = default;

  void* display_ = nullptr;
  bool has_xtest_ = false;
  bool has_xfixes_ = false;
  bool has_randr_ = false;
  bool has_xshm_ = false;
};

/** Direct X11 server capture; the explicit fallback when no portal exists. */
class X11CaptureAdapter final : public common::CaptureAdapter {
 public:
  explicit X11CaptureAdapter(std::shared_ptr<X11Connection> connection) noexcept;
  ~X11CaptureAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  // Captures the first frame synchronously (so a caller learns immediately
  // whether capture actually works), then keeps capturing on a background
  // poll thread at kPollIntervalMs until Stop() -- a single synchronous frame
  // is enough for a one-shot qualification harness, but not for a real
  // session, which needs a live video feed for as long as it runs.
  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) override;
  void Stop() noexcept override;

  /** Capture exactly one frame synchronously; used by qualification. */
  [[nodiscard]] bool CaptureOnce(const common::DisplayTopology& display,
                                 common::CapturedFrame* frame);

 private:
  void PollLoop(common::DisplayTopology display, common::CapturedFrameSink sink);

  std::shared_ptr<X11Connection> connection_;
  std::atomic<bool> running_{false};
  std::thread poll_thread_;
};

/**
 * XTEST input injection.
 *
 * Tracks only what it actually emitted so `ReleaseAllEmittedState` can undo
 * exactly that, leaving keys the local user is holding untouched. Higher-level
 * ownership and per-controller release remain common::InputLedger's job.
 */
class X11InputAdapter final : public common::InputAdapter {
 public:
  explicit X11InputAdapter(std::shared_ptr<X11Connection> connection) noexcept;
  ~X11InputAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool MovePointer(const common::LogicalPoint& point) override;
  bool EmitKey(std::string_view key, bool pressed) override;
  bool EmitButton(std::string_view button, bool pressed) override;
  bool EmitWheel(double delta_x, double delta_y) override;
  bool EmitText(std::string_view text) override;
  void ReleaseAllEmittedState() noexcept override;
  std::size_t ReleaseLatchedModifiers() noexcept override;

  /** Count of keys and buttons this adapter currently holds down. */
  [[nodiscard]] std::size_t held_count() const noexcept {
    return held_keys_.size() + held_buttons_.size();
  }

 private:
  // A keysym XKeysymToKeycode cannot find in the current layout -- every
  // CJK/non-Latin character, on a plain US/Xvfb layout -- is remapped onto
  // one scratch keycode instead. See EmitKey's own .cc comment for why and
  // EnsureScratchKeycodeFor's own comment for exactly how. Plain
  // unsigned long in and out (the real X11 KeySym/KeyCode types, respectively)
  // rather than Xlib's own typedefs, matching this header's existing
  // X11Connection::display() -- this file stays buildable by anything that
  // merely consumes the InputAdapter interface, without leaking Xlib's own
  // headers/macros into it. Resolves its own Display* from connection_
  // internally (Dpy(), .cc-only), so no X11 type needs to cross this header
  // at all.
  [[nodiscard]] unsigned long EnsureScratchKeycodeFor(unsigned long symbol);
  // Type one keysym as a character: at its own shift level (Shift for an
  // uppercase letter or "!"), honouring Caps Lock, or on the scratch keycode
  // when the layout has no key for it. A press and release; never held.
  [[nodiscard]] bool TapKeysym(unsigned long symbol);
  // The modifier keys the X server still reports as held, whoever pressed
  // them, in this adapter's own key-name vocabulary ("ControlLeft", ...).
  [[nodiscard]] std::vector<std::string> LatchedModifierKeys() const;

  std::shared_ptr<X11Connection> connection_;
  std::set<std::uint32_t> held_keys_;
  std::set<std::uint32_t> held_buttons_;
  // The keysym currently mapped onto that scratch keycode, so a run of the
  // same non-layout character does not re-remap on every keystroke. NoSymbol
  // (0) until first used; always a real X11 keysym constant, never a raw
  // codepoint.
  unsigned long scratch_mapped_keysym_ = 0;
};

/** CLIPBOARD selection ownership and retrieval over X11. */
class X11ClipboardAdapter final : public common::ClipboardAdapter {
 public:
  explicit X11ClipboardAdapter(std::shared_ptr<X11Connection> connection) noexcept;
  ~X11ClipboardAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool PasteText(std::string_view text) override;
  bool CopySelection(std::string* text) override;

  /** Serve pending selection requests; qualification drives this explicitly. */
  void PumpSelectionRequests(int max_events);

 private:
  // Read one selection ("PRIMARY" or "CLIPBOARD") as UTF-8, bounded in time.
  bool ReadSelection(const char* selection_name, std::string* text);
  bool EnsureWindow();

  std::shared_ptr<X11Connection> connection_;
  std::string owned_text_;
  bool owns_clipboard_ = false;
  unsigned long window_ = 0;
};

/** RANDR display enumeration and selection. */
class X11DisplayAdapter final : public common::DisplayAdapter {
 public:
  explicit X11DisplayAdapter(std::shared_ptr<X11Connection> connection) noexcept;
  ~X11DisplayAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  std::optional<common::DesktopTopology> EnumerateTopology() override;
  bool SelectDisplay(std::string_view display_id) override;
  bool SetMode(std::string_view display_id, common::PixelSize pixels) override;
  bool SetScale(std::string_view display_id, double scale) override;

  [[nodiscard]] std::string_view selected_display() const noexcept {
    return selected_display_;
  }

 private:
  std::shared_ptr<X11Connection> connection_;
  std::string selected_display_;
  common::TopologyRevision revision_ = 0;
  // Matches Windows' ToCommonDesktopTopology/generation_ pattern: a nonzero
  // worker-generation identity is required for DesktopTopology::IsValid()/
  // DisplayTopology::IsValid() to accept the topology at all (both check
  // generation != 0). There is no daemon-assigned worker generation plumbed
  // into this adapter yet, so this stays fixed at 1 for the process
  // lifetime -- honest for a single-worker-per-process model, and easy to
  // wire to a real value later without changing EnumerateTopology's shape.
  common::WorkerGeneration generation_ = 1;
};

/**
 * The on-screen "you are being watched/controlled" indicator: a small,
 * always-on-top, override-redirect window in the screen's top-right corner,
 * shown for as long as a session has a viewer or controller attached.
 *
 * This is a genuine consent/transparency surface, not a cosmetic one --
 * macOS and Windows both ship a real one (a signed helper process and a
 * local indicator process respectively), and CapabilityReadiness::ViewReady()
 * requires it precisely so a session cannot become viewable without it. A
 * physically-present user at a Linux desktop deserves the same visibility.
 */
class X11DisclosureAdapter final : public common::DisclosureAdapter {
 public:
  explicit X11DisclosureAdapter(std::shared_ptr<X11Connection> connection) noexcept;
  ~X11DisclosureAdapter() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override;
  void Hide() noexcept override;
  void SetAccessPaused(bool paused) noexcept;

 private:
  void DestroyWindow() noexcept;
  void RedrawLoop();
  void Draw();
  void ResizeDisclosure();

  std::shared_ptr<X11Connection> connection_;
  unsigned long window_ = 0;   // X11 Window; kept opaque so Xlib stays out of this header.
  unsigned long gc_ = 0;       // X11 GC.
  std::thread redraw_thread_;
  std::atomic<bool> running_{false};
  std::mutex text_mutex_;
  std::string text_;
  std::atomic<std::uint32_t> viewers_{0};
  std::atomic<std::uint32_t> controllers_{0};
  std::atomic<bool> access_paused_{false};
  std::atomic<bool> collapsed_{true};
  std::atomic<std::int64_t> collapse_deadline_ms_{0};
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_X11_BACKEND_H_
