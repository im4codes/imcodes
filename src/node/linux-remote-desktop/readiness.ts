/**
 * Linux remote-desktop readiness, mirroring
 * `native/linux-remote-desktop/linux_capability_probe.{h,cc}`.
 *
 * DELIBERATELY NOT WIRED INTO CAPABILITY ADVERTISEMENT. Linux still reports
 * unsupported through the existing capability surface, and nothing here
 * changes that. This module exists so the daemon can describe what a Linux
 * host actually offers without the advertisement layer having to guess, and so
 * the native rules have one TypeScript counterpart instead of being restated
 * ad hoc at each call site.
 *
 * Qualified on Ubuntu 24.04.4 (kernel 6.8.0-138, x86_64): the X11 fallback
 * qualifies end to end under an ephemeral X server, while the Wayland/Portal
 * path does not, because `org.freedesktop.portal.ScreenCast` and
 * `org.freedesktop.portal.RemoteDesktop` both time out on a host with no
 * logged-in graphical session even though PipeWire is running.
 */

/** Mirrors `common::ReadinessState`. */
export const LINUX_READINESS = {
  UNKNOWN: 'unknown',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
} as const;

export type LinuxReadiness = typeof LINUX_READINESS[keyof typeof LINUX_READINESS];

/** Mirrors `linux_platform::DisplayServer`. */
export const LINUX_DISPLAY_SERVER = {
  NONE: 'none',
  X11: 'x11',
  WAYLAND: 'wayland',
} as const;

export type LinuxDisplayServer =
  typeof LINUX_DISPLAY_SERVER[keyof typeof LINUX_DISPLAY_SERVER];

/** Mirrors `linux_platform::SessionFacts`; every field defaults to unprovable. */
export interface LinuxSessionFacts {
  displayServer?: LinuxDisplayServer;
  graphicalSessionPresent?: boolean;
  sessionBusPresent?: boolean;
  portalServicePresent?: boolean;
  portalScreenCastPresent?: boolean;
  portalRemoteDesktopPresent?: boolean;
  pipewirePresent?: boolean;
  xtestPresent?: boolean;
  xfixesPresent?: boolean;
  randrPresent?: boolean;
}

export interface LinuxCapabilityReadiness {
  capture: LinuxReadiness;
  encoder: LinuxReadiness;
  input: LinuxReadiness;
  clipboard: LinuxReadiness;
  display: LinuxReadiness;
  disclosure: LinuxReadiness;
}

/** Ready is only ever reachable by explicit proof; anything else is settled no. */
function decide(proven: boolean): LinuxReadiness {
  return proven ? LINUX_READINESS.READY : LINUX_READINESS.UNAVAILABLE;
}

function portalUsable(facts: LinuxSessionFacts): boolean {
  return facts.sessionBusPresent === true && facts.portalServicePresent === true;
}

/** A greeter or bare tty is not a session a viewer may attach to. */
function onRealSession(facts: LinuxSessionFacts): boolean {
  return facts.graphicalSessionPresent === true
    && facts.displayServer !== undefined
    && facts.displayServer !== LINUX_DISPLAY_SERVER.NONE;
}

function isWayland(facts: LinuxSessionFacts): boolean {
  return facts.displayServer === LINUX_DISPLAY_SERVER.WAYLAND;
}

export function probeCaptureReadiness(facts: LinuxSessionFacts): LinuxReadiness {
  if (!onRealSession(facts)) return LINUX_READINESS.UNAVAILABLE;
  if (isWayland(facts)) {
    return decide(portalUsable(facts)
      && facts.portalScreenCastPresent === true
      && facts.pipewirePresent === true);
  }
  return decide(facts.displayServer === LINUX_DISPLAY_SERVER.X11);
}

export function probeInputReadiness(facts: LinuxSessionFacts): LinuxReadiness {
  if (!onRealSession(facts)) return LINUX_READINESS.UNAVAILABLE;
  if (isWayland(facts)) {
    return decide(portalUsable(facts) && facts.portalRemoteDesktopPresent === true);
  }
  return decide(facts.xtestPresent === true);
}

export function probeClipboardReadiness(facts: LinuxSessionFacts): LinuxReadiness {
  if (!onRealSession(facts)) return LINUX_READINESS.UNAVAILABLE;
  if (isWayland(facts)) {
    return decide(portalUsable(facts) && facts.portalRemoteDesktopPresent === true);
  }
  return decide(facts.xfixesPresent === true);
}

export function probeDisplayReadiness(facts: LinuxSessionFacts): LinuxReadiness {
  if (!onRealSession(facts)) return LINUX_READINESS.UNAVAILABLE;
  if (isWayland(facts)) {
    return decide(portalUsable(facts) && facts.portalScreenCastPresent === true);
  }
  return decide(facts.randrPresent === true);
}

export function probeSessionMonitorReadiness(facts: LinuxSessionFacts): LinuxReadiness {
  return decide(onRealSession(facts) && facts.sessionBusPresent === true);
}

/** No Linux disclosure surface ships in this slice. */
export function probeDisclosureReadiness(): LinuxReadiness {
  return LINUX_READINESS.UNAVAILABLE;
}

export function probeAll(facts: LinuxSessionFacts): LinuxCapabilityReadiness {
  const capture = probeCaptureReadiness(facts);
  return {
    capture,
    // The encoder rides the capture path, so it can never outrank capture.
    encoder: capture,
    input: probeInputReadiness(facts),
    clipboard: probeClipboardReadiness(facts),
    display: probeDisplayReadiness(facts),
    disclosure: probeDisclosureReadiness(),
  };
}

/**
 * Whether Linux could be advertised at all. Conjunctive on purpose: a host
 * that can only capture is not a remote desktop.
 *
 * Note this is a description, not a switch — the capability surface still
 * reports Linux unsupported regardless of what this returns.
 */
export function isAdvertisable(readiness: LinuxCapabilityReadiness): boolean {
  return readiness.capture === LINUX_READINESS.READY
    && readiness.input === LINUX_READINESS.READY
    && readiness.display === LINUX_READINESS.READY;
}
