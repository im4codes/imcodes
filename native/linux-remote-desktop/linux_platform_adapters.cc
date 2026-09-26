#include "linux_platform_adapters.h"

#include <cstdlib>
#include <string>
#include <utility>

namespace imcodes::remote_desktop::linux_platform {

using common::CapabilityReadiness;
using common::GraphicalSessionEvent;
using common::ReadinessState;

namespace {

/**
 * Look for a real, already-configured VNC password in the conventional
 * places a VNC install leaves one -- $HOME/.vnc/passwd (the classic
 * vncserver/TigerVNC default) and $HOME/.vnc/x11vnc.passwd (x11vnc's own
 * default when pointed at a per-user directory rather than an explicit
 * path). Returns empty when nothing decodes, which is also the correct
 * password to try against a server that only offers security type 1
 * (None) -- VncCaptureAdapter never sends it unless the server actually
 * asks for VNC Authentication.
 */
std::string DiscoverVncPassword() {
  const char* home = std::getenv("HOME");
  if (home == nullptr || home[0] == '\0') return {};
  for (const std::string& candidate : {
      std::string(home) + "/.vnc/passwd",
      std::string(home) + "/.vnc/x11vnc.passwd",
  }) {
    std::string password = DecryptVncPasswordFile(candidate);
    if (!password.empty()) return password;
  }
  return {};
}

}  // namespace

// ── PortalCaptureAdapter ───────────────────────────────────────────────────

PortalCaptureAdapter::PortalCaptureAdapter(SessionFacts facts) noexcept
    : facts_(facts) {
  chain_present_ = facts_.session_bus_present
      && facts_.portal_service_present
      && facts_.portal_screencast_present
      && facts_.pipewire_present;
  if (!facts_.session_bus_present) {
    unavailable_reason_ = "no session bus";
  } else if (!facts_.portal_service_present) {
    unavailable_reason_ = "org.freedesktop.portal.Desktop unreachable";
  } else if (!facts_.portal_screencast_present) {
    unavailable_reason_ = "portal ScreenCast interface absent";
  } else if (!facts_.pipewire_present) {
    unavailable_reason_ = "no PipeWire daemon";
  } else {
    unavailable_reason_ = "portal stream negotiation not implemented in this slice";
  }
}

ReadinessState PortalCaptureAdapter::ProbeReadiness() {
  // Unconditionally unavailable: the stream path does not exist yet, so a
  // complete portal chain must still not read as ready.
  return ReadinessState::kUnavailable;
}

bool PortalCaptureAdapter::Start(const common::DisplayTopology&,
                                 common::CapturedFrameSink) {
  return false;
}

void PortalCaptureAdapter::Stop() noexcept {}

// ── LinuxSessionMonitor ────────────────────────────────────────────────────

LinuxSessionMonitor::LinuxSessionMonitor(SessionFacts facts) noexcept
    : facts_(facts) {}

LinuxSessionMonitor::~LinuxSessionMonitor() { Stop(); }

ReadinessState LinuxSessionMonitor::ProbeReadiness() {
  return ProbeSessionMonitorReadiness(facts_);
}

bool LinuxSessionMonitor::Start(Observer observer) {
  if (ProbeReadiness() != ReadinessState::kReady || !observer) return false;
  observer_ = std::move(observer);
  started_ = true;
  // The session is already live when the adapters are constructed, so the
  // first transition a caller must see is readiness.
  observer_(GraphicalSessionEvent::kReady);
  return true;
}

void LinuxSessionMonitor::Stop() noexcept {
  started_ = false;
  observer_ = nullptr;
}

void LinuxSessionMonitor::Emit(GraphicalSessionEvent event) {
  if (started_ && observer_) observer_(event);
}

// ── LinuxPlatformAdapters ──────────────────────────────────────────────────

std::unique_ptr<LinuxPlatformAdapters> LinuxPlatformAdapters::Create(
    std::shared_ptr<X11Connection> connection) {
  if (!connection) return nullptr;

  std::unique_ptr<LinuxPlatformAdapters> adapters(new LinuxPlatformAdapters());
  adapters->connection_ = connection;
  adapters->facts_ = connection->MeasureFacts();

  adapters->portal_capture_ = std::make_unique<PortalCaptureAdapter>(adapters->facts_);
  adapters->x11_capture_ = std::make_unique<X11CaptureAdapter>(connection);
  // Constructed unconditionally, matching portal_capture_/x11_capture_ above,
  // even though it is only ever selected as a last resort: readiness is
  // still probed live below, not assumed from construction succeeding.
  // 127.0.0.1:5900 is the RFB default and what this repo's own
  // scripts/install-linux-desktop-environment.sh --with-vnc wires up.
  adapters->vnc_capture_ = std::make_unique<VncCaptureAdapter>(
      "127.0.0.1", static_cast<std::uint16_t>(5900), DiscoverVncPassword());
  adapters->input_ = std::make_unique<X11InputAdapter>(connection);
  adapters->clipboard_ = std::make_unique<X11ClipboardAdapter>(connection);
  adapters->display_ = std::make_unique<X11DisplayAdapter>(connection);
  adapters->disclosure_ = std::make_unique<X11DisclosureAdapter>(connection);
  adapters->session_monitor_ = std::make_unique<LinuxSessionMonitor>(adapters->facts_);

  // Prefer the portal, then direct X11, then VNC as a last resort -- in
  // strictly decreasing order of performance, never the other way. Asking
  // the adapters rather than trusting policy keeps a half-available portal
  // (or a VNC server that turns out unreachable) from stranding an
  // otherwise working host; VNC in particular only gets picked when this
  // process could not otherwise capture anything, since it hands the whole
  // encode/decode round trip to a second process this session does not
  // control. See linux_vnc_backend.h's own header comment for that
  // performance reasoning and linux_platform_adapters.h's class comment for
  // this exact ordering restated at the class level.
  if (adapters->portal_capture_->ProbeReadiness() == ReadinessState::kReady) {
    adapters->capture_ = adapters->portal_capture_.get();
    adapters->active_backend_ = CaptureBackend::kPortalPipeWire;
  } else if (adapters->facts_.display_server == DisplayServer::kX11
             && adapters->x11_capture_->ProbeReadiness() == ReadinessState::kReady) {
    adapters->capture_ = adapters->x11_capture_.get();
    adapters->active_backend_ = CaptureBackend::kX11Shm;
  } else if (adapters->vnc_capture_->ProbeReadiness() == ReadinessState::kReady) {
    adapters->capture_ = adapters->vnc_capture_.get();
    adapters->active_backend_ = CaptureBackend::kVnc;
  } else {
    // Nothing qualified. Keep a non-null adapter so callers never dereference
    // null, but leave the backend as none so readiness stays unavailable.
    adapters->capture_ = adapters->portal_capture_.get();
    adapters->active_backend_ = CaptureBackend::kNone;
  }
  return adapters;
}

CapabilityReadiness LinuxPlatformAdapters::MeasureReadiness() {
  CapabilityReadiness readiness;
  readiness.capture = active_backend_ == CaptureBackend::kNone
      ? ReadinessState::kUnavailable
      : capture_->ProbeReadiness();
  // The encoder rides the capture path and can never outrank it.
  readiness.encoder = readiness.capture;
  readiness.input = input_->ProbeReadiness();
  readiness.clipboard = clipboard_->ProbeReadiness();
  readiness.display = display_->ProbeReadiness();
  readiness.disclosure = disclosure_->ProbeReadiness();
  // Measured once, at connection-open time (facts_), not re-probed live --
  // if the graphical session genuinely ended the X connection itself would
  // not have survived to be asked. CapabilityReadiness::ViewReady() checks
  // this field too; leaving it at its kUnknown default (readiness's own
  // field-initializer) silently failed that check forever, independent of
  // capture/input/disclosure all being kReady.
  readiness.graphical_session = facts_.graphical_session_present
      ? ReadinessState::kReady
      : ReadinessState::kUnavailable;
  return readiness;
}

bool LinuxPlatformAdapters::IsAdvertisableNow() {
  return IsAdvertisable(MeasureReadiness());
}

}  // namespace imcodes::remote_desktop::linux_platform
