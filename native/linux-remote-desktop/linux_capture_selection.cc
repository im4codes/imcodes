#include "linux_capture_selection.h"

namespace imcodes::remote_desktop::linux_platform {

CaptureBackend SelectCaptureBackend(const SessionFacts& facts) noexcept {
  if (!facts.graphical_session_present) return CaptureBackend::kNone;

  const bool portal_chain_present = facts.session_bus_present
      && facts.portal_service_present
      && facts.portal_screencast_present
      && facts.pipewire_present;

  switch (facts.display_server) {
    case DisplayServer::kWayland:
      // Wayland has no sanctioned direct-scrape path. If the portal chain is
      // incomplete the answer is "none" — never a silent X11 downgrade, which
      // would either fail anyway or capture only an XWayland subset while
      // reporting success.
      return portal_chain_present ? CaptureBackend::kPortalPipeWire
                                  : CaptureBackend::kNone;
    case DisplayServer::kX11:
      // Prefer the portal on X11 too when it is fully available: it keeps
      // consent with the desktop environment. Otherwise take the explicit
      // documented fallback.
      return portal_chain_present ? CaptureBackend::kPortalPipeWire
                                  : CaptureBackend::kX11Shm;
    case DisplayServer::kNone:
      break;
  }
  return CaptureBackend::kNone;
}

std::string_view CaptureBackendName(CaptureBackend backend) noexcept {
  switch (backend) {
    case CaptureBackend::kPortalPipeWire: return "portal-pipewire";
    case CaptureBackend::kX11Shm: return "x11-shm";
    case CaptureBackend::kNone: break;
  }
  return "none";
}

bool CaptureBackendUsable(const SessionFacts& facts) noexcept {
  return SelectCaptureBackend(facts) != CaptureBackend::kNone
      && ProbeCaptureReadiness(facts) == ReadinessState::kReady;
}

}  // namespace imcodes::remote_desktop::linux_platform
