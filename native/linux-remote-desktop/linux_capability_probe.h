#ifndef IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPABILITY_PROBE_H_
#define IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPABILITY_PROBE_H_

#include <cstdint>

#include "../remote-desktop-common/value_types.h"

namespace imcodes::remote_desktop::linux_platform {

using common::CapabilityReadiness;
using common::ReadinessState;

/** Which display server actually owns the session under qualification. */
enum class DisplayServer : std::uint8_t {
  kNone,
  kX11,
  kWayland,
};

/**
 * Measured facts about one Linux graphical session.
 *
 * Every field defaults to the unprovable state, so a partially populated
 * struct can only ever produce `kUnavailable`. Callers fill this in from the
 * live host; the decision functions below stay pure so the advertisement rules
 * are testable on any platform and cannot drift from the runtime probe.
 */
struct SessionFacts {
  DisplayServer display_server = DisplayServer::kNone;
  /** A real seat-attached graphical session, not a bare tty or greeter. */
  bool graphical_session_present = false;
  /** A user session bus exists (required for every portal interface). */
  bool session_bus_present = false;
  /** `org.freedesktop.portal.Desktop` is reachable on the session bus. */
  bool portal_service_present = false;
  /** The portal exposes `org.freedesktop.portal.ScreenCast`. */
  bool portal_screencast_present = false;
  /** The portal exposes `org.freedesktop.portal.RemoteDesktop`. */
  bool portal_remote_desktop_present = false;
  /** A PipeWire daemon is reachable for the negotiated stream. */
  bool pipewire_present = false;
  /** The X server advertises the XTEST extension (X11 input injection). */
  bool xtest_present = false;
  /** The X server advertises XFIXES (X11 clipboard/selection ownership). */
  bool xfixes_present = false;
  /** The X server advertises RANDR (X11 display topology and modes). */
  bool randr_present = false;
};

/**
 * Capture readiness.
 *
 * Wayland has no legacy screen-scrape path, so it requires the full portal
 * ScreenCast plus PipeWire chain. X11 may fall back to direct server capture.
 * Either way a real graphical session must exist first: a greeter or tty can
 * never be advertised as capturable.
 */
[[nodiscard]] ReadinessState ProbeCaptureReadiness(const SessionFacts& facts) noexcept;

/**
 * Input readiness. Wayland requires the portal RemoteDesktop interface;
 * X11 requires XTEST. Capture readiness is not sufficient for either.
 */
[[nodiscard]] ReadinessState ProbeInputReadiness(const SessionFacts& facts) noexcept;

/** Clipboard readiness. X11 needs XFIXES; Wayland needs the portal. */
[[nodiscard]] ReadinessState ProbeClipboardReadiness(const SessionFacts& facts) noexcept;

/** Display topology readiness. X11 needs RANDR; Wayland needs the portal. */
[[nodiscard]] ReadinessState ProbeDisplayReadiness(const SessionFacts& facts) noexcept;

/**
 * Lifecycle readiness. Session state transitions are observed over the session
 * bus, so the bus and a real graphical session are both required.
 */
[[nodiscard]] ReadinessState ProbeSessionMonitorReadiness(const SessionFacts& facts) noexcept;

/**
 * Disclosure readiness.
 *
 * No Linux disclosure surface ships in this slice, so this is always
 * `kUnavailable`. It exists so the aggregate cannot silently omit the
 * capability and read as ready.
 */
[[nodiscard]] ReadinessState ProbeDisclosureReadiness(const SessionFacts& facts) noexcept;

/** Aggregate every capability from one set of measured facts. */
[[nodiscard]] CapabilityReadiness ProbeAll(const SessionFacts& facts) noexcept;

/**
 * Whether Linux remote desktop may be advertised as usable at all.
 *
 * Deliberately conjunctive over the capabilities a session actually needs:
 * capture, input and display must all be ready. A host that can only capture
 * is not a remote desktop and must keep reporting unsupported.
 */
[[nodiscard]] bool IsAdvertisable(const CapabilityReadiness& readiness) noexcept;

}  // namespace imcodes::remote_desktop::linux_platform

#endif  // IMCODES_REMOTE_DESKTOP_LINUX_LINUX_CAPABILITY_PROBE_H_
