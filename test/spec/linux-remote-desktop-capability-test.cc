// Counterexamples for the Linux remote-desktop capability probe.
//
// The probe decides whether Linux may be advertised at all, so every case here
// is an advertisement rule. A non-zero exit names the exact rule that broke.

#include <cstdio>
#include <string_view>

#include "../../native/linux-remote-desktop/linux_capability_probe.h"
#include "../../native/linux-remote-desktop/linux_capture_selection.h"

namespace rd = imcodes::remote_desktop::linux_platform;
using rd::DisplayServer;
using rd::ReadinessState;
using rd::SessionFacts;

namespace {

/** A fully-capable Wayland session: portal ScreenCast + RemoteDesktop + PipeWire. */
SessionFacts WaylandReady() {
  SessionFacts facts;
  facts.display_server = DisplayServer::kWayland;
  facts.graphical_session_present = true;
  facts.session_bus_present = true;
  facts.portal_service_present = true;
  facts.portal_screencast_present = true;
  facts.portal_remote_desktop_present = true;
  facts.pipewire_present = true;
  return facts;
}

/** A fully-capable X11 session: XTEST + XFIXES + RANDR, no portal needed. */
SessionFacts X11Ready() {
  SessionFacts facts;
  facts.display_server = DisplayServer::kX11;
  facts.graphical_session_present = true;
  facts.session_bus_present = true;
  facts.xtest_present = true;
  facts.xfixes_present = true;
  facts.randr_present = true;
  return facts;
}

int Fail(const char* rule, int code) {
  std::fprintf(stderr, "capability rule failed: %s\n", rule);
  return code;
}

}  // namespace

int main() {
  // ── Default construction must be unusable ────────────────────────────────
  const SessionFacts empty;
  if (rd::ProbeCaptureReadiness(empty) != ReadinessState::kUnavailable) {
    return Fail("default facts must not be capturable", 10);
  }
  if (rd::ProbeInputReadiness(empty) != ReadinessState::kUnavailable) {
    return Fail("default facts must not accept input", 11);
  }
  if (rd::IsAdvertisable(rd::ProbeAll(empty))) {
    return Fail("default facts must not be advertisable", 12);
  }

  // ── Fully capable sessions are advertisable ──────────────────────────────
  if (!rd::IsAdvertisable(rd::ProbeAll(WaylandReady()))) {
    return Fail("complete Wayland session must be advertisable", 20);
  }
  if (!rd::IsAdvertisable(rd::ProbeAll(X11Ready()))) {
    return Fail("complete X11 session must be advertisable", 21);
  }

  // ── A greeter or tty is never advertisable, however capable ──────────────
  {
    SessionFacts facts = WaylandReady();
    facts.graphical_session_present = false;
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("no graphical session must not be capturable", 30);
    }
    if (rd::IsAdvertisable(rd::ProbeAll(facts))) {
      return Fail("no graphical session must not be advertisable", 31);
    }
  }
  {
    SessionFacts facts = X11Ready();
    facts.display_server = DisplayServer::kNone;
    if (rd::IsAdvertisable(rd::ProbeAll(facts))) {
      return Fail("absent display server must not be advertisable", 32);
    }
  }

  // ── Wayland requires the whole portal + PipeWire chain ───────────────────
  {
    SessionFacts facts = WaylandReady();
    facts.pipewire_present = false;
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("Wayland without PipeWire must not be capturable", 40);
    }
  }
  {
    SessionFacts facts = WaylandReady();
    facts.portal_screencast_present = false;
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("Wayland without portal ScreenCast must not be capturable", 41);
    }
  }
  {
    SessionFacts facts = WaylandReady();
    facts.portal_service_present = false;
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("Wayland without the portal service must not be capturable", 42);
    }
  }
  {
    SessionFacts facts = WaylandReady();
    facts.session_bus_present = false;
    if (rd::ProbeInputReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("Wayland without a session bus must not accept input", 43);
    }
  }
  {
    SessionFacts facts = WaylandReady();
    facts.portal_remote_desktop_present = false;
    if (rd::ProbeInputReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("Wayland without portal RemoteDesktop must not accept input", 44);
    }
    // Capture may still be ready; that must not make the host advertisable.
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kReady) {
      return Fail("Wayland capture is independent of RemoteDesktop", 45);
    }
    if (rd::IsAdvertisable(rd::ProbeAll(facts))) {
      return Fail("capture-only Wayland must not be advertisable", 46);
    }
  }

  // ── X11 falls back without a portal, but still needs its extensions ──────
  {
    SessionFacts facts = X11Ready();
    facts.portal_service_present = false;
    facts.pipewire_present = false;
    if (rd::ProbeCaptureReadiness(facts) != ReadinessState::kReady) {
      return Fail("X11 fallback must not require portal or PipeWire", 50);
    }
  }
  {
    SessionFacts facts = X11Ready();
    facts.xtest_present = false;
    if (rd::ProbeInputReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("X11 without XTEST must not accept input", 51);
    }
    if (rd::IsAdvertisable(rd::ProbeAll(facts))) {
      return Fail("X11 without XTEST must not be advertisable", 52);
    }
  }
  {
    SessionFacts facts = X11Ready();
    facts.xfixes_present = false;
    if (rd::ProbeClipboardReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("X11 without XFIXES must not offer clipboard", 53);
    }
  }
  {
    SessionFacts facts = X11Ready();
    facts.randr_present = false;
    if (rd::ProbeDisplayReadiness(facts) != ReadinessState::kUnavailable) {
      return Fail("X11 without RANDR must not offer display topology", 54);
    }
    if (rd::IsAdvertisable(rd::ProbeAll(facts))) {
      return Fail("X11 without RANDR must not be advertisable", 55);
    }
  }

  // ── Disclosure never ships in this slice ─────────────────────────────────
  if (rd::ProbeDisclosureReadiness(WaylandReady()) != ReadinessState::kUnavailable) {
    return Fail("disclosure must stay unavailable in this slice", 60);
  }
  if (rd::ProbeAll(X11Ready()).disclosure != ReadinessState::kUnavailable) {
    return Fail("aggregate must not invent a disclosure surface", 61);
  }

  // ── No capability may report kUnknown: unknown is not a settled answer ───
  {
    const auto readiness = rd::ProbeAll(empty);
    const ReadinessState states[] = {
        readiness.capture, readiness.encoder, readiness.input,
        readiness.clipboard, readiness.display, readiness.disclosure,
    };
    for (const ReadinessState state : states) {
      if (state == ReadinessState::kUnknown) {
        return Fail("probe must never leave a capability kUnknown", 70);
      }
    }
  }

  // ── The encoder can never outrank capture ────────────────────────────────
  {
    SessionFacts facts = WaylandReady();
    facts.pipewire_present = false;
    const auto readiness = rd::ProbeAll(facts);
    if (readiness.encoder != readiness.capture) {
      return Fail("encoder readiness must track capture readiness", 80);
    }
  }

  // ── Backend selection: portal preferred, X11 an explicit fallback ───────
  if (rd::SelectCaptureBackend(empty) != rd::CaptureBackend::kNone) {
    return Fail("default facts must select no backend", 110);
  }
  if (rd::SelectCaptureBackend(WaylandReady()) != rd::CaptureBackend::kPortalPipeWire) {
    return Fail("complete Wayland must select the portal", 111);
  }
  if (rd::SelectCaptureBackend(X11Ready()) != rd::CaptureBackend::kX11Shm) {
    return Fail("portal-less X11 must select the X11 fallback", 112);
  }
  {
    // A Wayland session whose portal chain is incomplete must NOT silently
    // downgrade to X11: that would capture nothing or an XWayland subset.
    SessionFacts facts = WaylandReady();
    facts.pipewire_present = false;
    if (rd::SelectCaptureBackend(facts) != rd::CaptureBackend::kNone) {
      return Fail("incomplete Wayland must not fall back to X11", 113);
    }
    if (rd::CaptureBackendUsable(facts)) {
      return Fail("incomplete Wayland backend must not be usable", 114);
    }
  }
  {
    // On X11 the portal is still preferred when genuinely complete.
    SessionFacts facts = X11Ready();
    facts.portal_service_present = true;
    facts.portal_screencast_present = true;
    facts.pipewire_present = true;
    if (rd::SelectCaptureBackend(facts) != rd::CaptureBackend::kPortalPipeWire) {
      return Fail("X11 with a complete portal must prefer the portal", 115);
    }
  }
  {
    // Selection alone is not permission: a greeter selects nothing.
    SessionFacts facts = X11Ready();
    facts.graphical_session_present = false;
    if (rd::SelectCaptureBackend(facts) != rd::CaptureBackend::kNone) {
      return Fail("no graphical session must select no backend", 116);
    }
    if (rd::CaptureBackendUsable(facts)) {
      return Fail("no graphical session must never be usable", 117);
    }
  }
  if (!rd::CaptureBackendUsable(X11Ready())) {
    return Fail("a complete X11 session must be usable", 118);
  }
  if (rd::CaptureBackendName(rd::CaptureBackend::kNone) != std::string_view("none")) {
    return Fail("backend names must stay stable for evidence", 119);
  }

  std::printf("linux capability probe: ok\n");
  return 0;
}
