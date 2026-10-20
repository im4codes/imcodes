import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  LINUX_DISPLAY_SERVER,
  LINUX_READINESS,
  isAdvertisable,
  probeAll,
  probeCaptureReadiness,
  probeClipboardReadiness,
  probeDisplayReadiness,
  probeInputReadiness,
  probeSessionMonitorReadiness,
  type LinuxSessionFacts,
} from '../../../src/node/linux-remote-desktop/readiness.js';

/**
 * These rules decide whether Linux may ever be advertised, so each case is an
 * advertisement rule rather than a unit detail. They mirror the counterexamples
 * in test/spec/linux-remote-desktop-capability-test.cc; the final test pins the
 * two implementations together so they cannot drift apart silently.
 */

const waylandReady: LinuxSessionFacts = {
  displayServer: LINUX_DISPLAY_SERVER.WAYLAND,
  graphicalSessionPresent: true,
  sessionBusPresent: true,
  portalServicePresent: true,
  portalScreenCastPresent: true,
  portalRemoteDesktopPresent: true,
  pipewirePresent: true,
};

const x11Ready: LinuxSessionFacts = {
  displayServer: LINUX_DISPLAY_SERVER.X11,
  graphicalSessionPresent: true,
  sessionBusPresent: true,
  xtestPresent: true,
  xfixesPresent: true,
  randrPresent: true,
};

describe('linux remote desktop readiness', () => {
  it('treats an empty fact set as unavailable, never unknown', () => {
    const readiness = probeAll({});
    for (const state of Object.values(readiness)) {
      expect(state).toBe(LINUX_READINESS.UNAVAILABLE);
    }
    expect(isAdvertisable(readiness)).toBe(false);
  });

  it('advertises a complete Wayland session', () => {
    expect(isAdvertisable(probeAll(waylandReady))).toBe(true);
  });

  it('advertises a complete X11 session', () => {
    expect(isAdvertisable(probeAll(x11Ready))).toBe(true);
  });

  it('never advertises a greeter or tty however capable', () => {
    const noSession = { ...waylandReady, graphicalSessionPresent: false };
    expect(probeCaptureReadiness(noSession)).toBe(LINUX_READINESS.UNAVAILABLE);
    expect(isAdvertisable(probeAll(noSession))).toBe(false);

    const noServer = { ...x11Ready, displayServer: LINUX_DISPLAY_SERVER.NONE };
    expect(isAdvertisable(probeAll(noServer))).toBe(false);
  });

  it('requires the whole portal and PipeWire chain on Wayland', () => {
    expect(probeCaptureReadiness({ ...waylandReady, pipewirePresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(probeCaptureReadiness({ ...waylandReady, portalScreenCastPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(probeCaptureReadiness({ ...waylandReady, portalServicePresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(probeInputReadiness({ ...waylandReady, sessionBusPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
  });

  it('does not let capture alone make a Wayland host advertisable', () => {
    const captureOnly = { ...waylandReady, portalRemoteDesktopPresent: false };
    expect(probeCaptureReadiness(captureOnly)).toBe(LINUX_READINESS.READY);
    expect(probeInputReadiness(captureOnly)).toBe(LINUX_READINESS.UNAVAILABLE);
    expect(isAdvertisable(probeAll(captureOnly))).toBe(false);
  });

  it('lets X11 fall back without portal or PipeWire but still needs its extensions', () => {
    expect(probeCaptureReadiness({ ...x11Ready, portalServicePresent: false, pipewirePresent: false }))
      .toBe(LINUX_READINESS.READY);
    expect(probeInputReadiness({ ...x11Ready, xtestPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(probeClipboardReadiness({ ...x11Ready, xfixesPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(probeDisplayReadiness({ ...x11Ready, randrPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
    expect(isAdvertisable(probeAll({ ...x11Ready, xtestPresent: false }))).toBe(false);
  });

  it('keeps disclosure unavailable and the encoder tracking capture', () => {
    expect(probeAll(x11Ready).disclosure).toBe(LINUX_READINESS.UNAVAILABLE);
    const degraded = probeAll({ ...waylandReady, pipewirePresent: false });
    expect(degraded.encoder).toBe(degraded.capture);
  });

  it('requires a session bus for lifecycle monitoring', () => {
    expect(probeSessionMonitorReadiness(x11Ready)).toBe(LINUX_READINESS.READY);
    expect(probeSessionMonitorReadiness({ ...x11Ready, sessionBusPresent: false }))
      .toBe(LINUX_READINESS.UNAVAILABLE);
  });

  it('reproduces the measured pron3 host: X11 ready, Wayland portal unavailable', () => {
    // Ubuntu 24.04.4, ephemeral X server: xtest/xfixes/randr all present.
    const measuredX11: LinuxSessionFacts = {
      displayServer: LINUX_DISPLAY_SERVER.X11,
      graphicalSessionPresent: true,
      sessionBusPresent: true,
      xtestPresent: true,
      xfixesPresent: true,
      randrPresent: true,
      pipewirePresent: true,
    };
    expect(isAdvertisable(probeAll(measuredX11))).toBe(true);

    // Same host asked for Wayland: PipeWire runs, but both portal interfaces
    // time out and there is no Wayland socket.
    const measuredWayland: LinuxSessionFacts = {
      displayServer: LINUX_DISPLAY_SERVER.WAYLAND,
      graphicalSessionPresent: true,
      sessionBusPresent: true,
      pipewirePresent: true,
      portalServicePresent: false,
      portalScreenCastPresent: false,
      portalRemoteDesktopPresent: false,
    };
    expect(probeCaptureReadiness(measuredWayland)).toBe(LINUX_READINESS.UNAVAILABLE);
    expect(isAdvertisable(probeAll(measuredWayland))).toBe(false);
  });

  it('stays in lockstep with the native probe rule set', () => {
    // Drift guard: both implementations must gate on the same facts. If a rule
    // is added natively without a TypeScript counterpart the names diverge.
    const native = readFileSync(
      new URL('../../../native/linux-remote-desktop/linux_capability_probe.cc', import.meta.url),
      'utf8',
    );
    const pairs: Array<[string, string]> = [
      ['portal_screencast_present', 'portalScreenCastPresent'],
      ['portal_remote_desktop_present', 'portalRemoteDesktopPresent'],
      ['pipewire_present', 'pipewirePresent'],
      ['xtest_present', 'xtestPresent'],
      ['xfixes_present', 'xfixesPresent'],
      ['randr_present', 'randrPresent'],
      ['graphical_session_present', 'graphicalSessionPresent'],
      ['session_bus_present', 'sessionBusPresent'],
    ];
    const ts = readFileSync(
      new URL('../../../src/node/linux-remote-desktop/readiness.ts', import.meta.url),
      'utf8',
    );
    for (const [nativeField, tsField] of pairs) {
      expect(native, `native must gate on ${nativeField}`).toContain(nativeField);
      expect(ts, `typescript must gate on ${tsField}`).toContain(tsField);
    }
  });
});
