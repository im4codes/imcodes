#include "linux_platform_adapters.h"

#include <utility>

namespace imcodes::remote_desktop::linux_platform {

using common::CapabilityReadiness;
using common::GraphicalSessionEvent;
using common::ReadinessState;

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

// ── LinuxDisclosureAdapter ─────────────────────────────────────────────────

ReadinessState LinuxDisclosureAdapter::ProbeReadiness() {
  return ReadinessState::kUnavailable;
}

bool LinuxDisclosureAdapter::Show(std::uint32_t, std::uint32_t) { return false; }

void LinuxDisclosureAdapter::Hide() noexcept {}

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
  adapters->input_ = std::make_unique<X11InputAdapter>(connection);
  adapters->clipboard_ = std::make_unique<X11ClipboardAdapter>(connection);
  adapters->display_ = std::make_unique<X11DisplayAdapter>(connection);
  adapters->disclosure_ = std::make_unique<LinuxDisclosureAdapter>();
  adapters->session_monitor_ = std::make_unique<LinuxSessionMonitor>(adapters->facts_);

  // Prefer the portal, then fall back — but only to a backend that is really
  // ready. Asking the adapters rather than trusting the policy keeps a
  // half-available portal from stranding an otherwise working X11 host.
  if (adapters->portal_capture_->ProbeReadiness() == ReadinessState::kReady) {
    adapters->capture_ = adapters->portal_capture_.get();
    adapters->active_backend_ = CaptureBackend::kPortalPipeWire;
  } else if (adapters->facts_.display_server == DisplayServer::kX11
             && adapters->x11_capture_->ProbeReadiness() == ReadinessState::kReady) {
    adapters->capture_ = adapters->x11_capture_.get();
    adapters->active_backend_ = CaptureBackend::kX11Shm;
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
  return readiness;
}

bool LinuxPlatformAdapters::IsAdvertisableNow() {
  return IsAdvertisable(MeasureReadiness());
}

}  // namespace imcodes::remote_desktop::linux_platform
