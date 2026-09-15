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

#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>

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
  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) override;
  void Stop() noexcept override;

  /** Capture exactly one frame synchronously; used by qualification. */
  [[nodiscard]] bool CaptureOnce(const common::DisplayTopology& display,
                                 common::CapturedFrame* frame);

 private:
  std::shared_ptr<X11Connection> connection_;
  bool running_ = false;
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

  /** Count of keys and buttons this adapter currently holds down. */
  [[nodiscard]] std::size_t held_count() const noexcept {
    return held_keys_.size() + held_buttons_.size();
  }

 private:
  std::shared_ptr<X11Connection> connection_;
  std::set<std::uint32_t> held_keys_;
  std::set<std::uint32_t> held_buttons_;
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
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_X11_BACKEND_H_
