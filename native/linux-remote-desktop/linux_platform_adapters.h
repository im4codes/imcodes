#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PLATFORM_ADAPTERS_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PLATFORM_ADAPTERS_H_

// Linux-only assembly of the platform adapters.
//
// Selection policy lives in linux_capture_selection; readiness rules live in
// linux_capability_probe. This file only wires concrete adapters to those
// decisions and adds no protocol, session, transport or quality logic.

#include <memory>
#include <string>

#include "../remote-desktop-common/platform_interfaces.h"
#include "linux_capability_probe.h"
#include "linux_capture_selection.h"
#include "linux_x11_backend.h"

namespace imcodes::remote_desktop::linux_platform {

/**
 * Portal/PipeWire capture.
 *
 * NOT IMPLEMENTED END TO END IN THIS SLICE. The ScreenCast session negotiation
 * and PipeWire stream consumption are absent, so `ProbeReadiness` always
 * reports `kUnavailable` no matter how complete the host's portal chain looks.
 *
 * It exists as a real type rather than a TODO so the assembly has one honest
 * place to prefer the portal from, and so a host with a working portal cannot
 * be silently treated as capturable before the stream path lands. Reporting
 * anything other than unavailable here would be exactly the over-advertisement
 * this slice is required to prevent.
 */
class PortalCaptureAdapter final : public common::CaptureAdapter {
 public:
  explicit PortalCaptureAdapter(SessionFacts facts) noexcept;
  ~PortalCaptureAdapter() override = default;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Start(const common::DisplayTopology& display,
             common::CapturedFrameSink sink) override;
  void Stop() noexcept override;

  /** Whether the host's portal chain is complete, independent of readiness. */
  [[nodiscard]] bool chain_present() const noexcept { return chain_present_; }

  /** Why the portal path is unavailable, for evidence and diagnostics. */
  [[nodiscard]] const std::string& unavailable_reason() const noexcept {
    return unavailable_reason_;
  }

 private:
  SessionFacts facts_;
  bool chain_present_ = false;
  std::string unavailable_reason_;
};

/** Disclosure has no Linux surface in this slice and stays unavailable. */
class LinuxDisclosureAdapter final : public common::DisclosureAdapter {
 public:
  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Show(std::uint32_t viewers, std::uint32_t controllers) override;
  void Hide() noexcept override;
};

/** Lifecycle readiness observed from the session bus. */
class LinuxSessionMonitor final : public common::SessionMonitor {
 public:
  explicit LinuxSessionMonitor(SessionFacts facts) noexcept;
  ~LinuxSessionMonitor() override;

  [[nodiscard]] common::ReadinessState ProbeReadiness() override;
  bool Start(Observer observer) override;
  void Stop() noexcept override;

  /** Deliver a transition to the observer; the bus watcher is not in scope. */
  void Emit(common::GraphicalSessionEvent event);

 private:
  SessionFacts facts_;
  Observer observer_;
  bool started_ = false;
};

/**
 * The concrete adapters for one Linux session, owned together.
 *
 * `capture` is chosen at runtime rather than from policy alone: the portal is
 * preferred, but if the portal adapter does not report ready the X11 fallback
 * is used when the session is genuinely X11. That keeps "prefer portal" from
 * degrading a working X11 host into no capture at all.
 */
class LinuxPlatformAdapters {
 public:
  /** Null when no X display can be opened. */
  static std::unique_ptr<LinuxPlatformAdapters> Create(
      std::shared_ptr<X11Connection> connection);

  [[nodiscard]] common::CaptureAdapter& capture() const noexcept { return *capture_; }
  [[nodiscard]] X11InputAdapter& input() const noexcept { return *input_; }
  [[nodiscard]] X11ClipboardAdapter& clipboard() const noexcept { return *clipboard_; }
  [[nodiscard]] X11DisplayAdapter& display() const noexcept { return *display_; }
  [[nodiscard]] LinuxDisclosureAdapter& disclosure() const noexcept { return *disclosure_; }
  [[nodiscard]] LinuxSessionMonitor& session_monitor() const noexcept {
    return *session_monitor_;
  }

  /** Which backend actually backs `capture()`. */
  [[nodiscard]] CaptureBackend active_capture_backend() const noexcept {
    return active_backend_;
  }
  [[nodiscard]] const SessionFacts& facts() const noexcept { return facts_; }

  /** Aggregate readiness measured from the live adapters, not from policy. */
  [[nodiscard]] common::CapabilityReadiness MeasureReadiness();

  /** Whether Linux could be advertised for this session. */
  [[nodiscard]] bool IsAdvertisableNow();

 private:
  LinuxPlatformAdapters() = default;

  std::shared_ptr<X11Connection> connection_;
  SessionFacts facts_;
  CaptureBackend active_backend_ = CaptureBackend::kNone;
  std::unique_ptr<PortalCaptureAdapter> portal_capture_;
  std::unique_ptr<X11CaptureAdapter> x11_capture_;
  common::CaptureAdapter* capture_ = nullptr;
  std::unique_ptr<X11InputAdapter> input_;
  std::unique_ptr<X11ClipboardAdapter> clipboard_;
  std::unique_ptr<X11DisplayAdapter> display_;
  std::unique_ptr<LinuxDisclosureAdapter> disclosure_;
  std::unique_ptr<LinuxSessionMonitor> session_monitor_;
};

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_PLATFORM_ADAPTERS_H_
