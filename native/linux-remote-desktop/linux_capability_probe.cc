#include "linux_capability_probe.h"

namespace imcodes::remote_desktop::linux_platform {
namespace {

/**
 * Every decision funnels through this so "ready" is only ever reachable by an
 * explicit proof. A missing or unknown fact yields `kUnavailable`, never
 * `kUnknown`, because the advertisement layer treats unknown as "ask again"
 * while an unqualified Linux host must read as a settled no.
 */
constexpr ReadinessState Decide(bool proven) noexcept {
  return proven ? ReadinessState::kReady : ReadinessState::kUnavailable;
}

/** Portal interfaces are only reachable when the bus and service both exist. */
constexpr bool PortalUsable(const SessionFacts& facts) noexcept {
  return facts.session_bus_present && facts.portal_service_present;
}

/** A greeter or tty is not a session a remote viewer may be attached to. */
constexpr bool OnRealSession(const SessionFacts& facts) noexcept {
  return facts.graphical_session_present
      && facts.display_server != DisplayServer::kNone;
}

}  // namespace

ReadinessState ProbeCaptureReadiness(const SessionFacts& facts) noexcept {
  if (!OnRealSession(facts)) return ReadinessState::kUnavailable;
  if (facts.display_server == DisplayServer::kWayland) {
    return Decide(PortalUsable(facts)
                  && facts.portal_screencast_present
                  && facts.pipewire_present);
  }
  // X11 fallback: the server itself is the capture source. PipeWire is not
  // required here, which is precisely why the fallback exists.
  return Decide(facts.display_server == DisplayServer::kX11);
}

ReadinessState ProbeInputReadiness(const SessionFacts& facts) noexcept {
  if (!OnRealSession(facts)) return ReadinessState::kUnavailable;
  if (facts.display_server == DisplayServer::kWayland) {
    return Decide(PortalUsable(facts) && facts.portal_remote_desktop_present);
  }
  return Decide(facts.xtest_present);
}

ReadinessState ProbeClipboardReadiness(const SessionFacts& facts) noexcept {
  if (!OnRealSession(facts)) return ReadinessState::kUnavailable;
  if (facts.display_server == DisplayServer::kWayland) {
    return Decide(PortalUsable(facts) && facts.portal_remote_desktop_present);
  }
  return Decide(facts.xfixes_present);
}

ReadinessState ProbeDisplayReadiness(const SessionFacts& facts) noexcept {
  if (!OnRealSession(facts)) return ReadinessState::kUnavailable;
  if (facts.display_server == DisplayServer::kWayland) {
    return Decide(PortalUsable(facts) && facts.portal_screencast_present);
  }
  return Decide(facts.randr_present);
}

ReadinessState ProbeSessionMonitorReadiness(const SessionFacts& facts) noexcept {
  return Decide(OnRealSession(facts) && facts.session_bus_present);
}

ReadinessState ProbeDisclosureReadiness(const SessionFacts&) noexcept {
  // No Linux disclosure surface ships in this slice.
  return ReadinessState::kUnavailable;
}

CapabilityReadiness ProbeAll(const SessionFacts& facts) noexcept {
  CapabilityReadiness readiness;
  readiness.capture = ProbeCaptureReadiness(facts);
  // The encoder rides the capture path in this slice; it is never independently
  // ready, so it cannot make the aggregate look better than capture.
  readiness.encoder = readiness.capture;
  readiness.input = ProbeInputReadiness(facts);
  readiness.clipboard = ProbeClipboardReadiness(facts);
  readiness.display = ProbeDisplayReadiness(facts);
  readiness.disclosure = ProbeDisclosureReadiness(facts);
  return readiness;
}

bool IsAdvertisable(const CapabilityReadiness& readiness) noexcept {
  return readiness.capture == ReadinessState::kReady
      && readiness.input == ReadinessState::kReady
      && readiness.display == ReadinessState::kReady;
}

}  // namespace imcodes::remote_desktop::linux_platform
