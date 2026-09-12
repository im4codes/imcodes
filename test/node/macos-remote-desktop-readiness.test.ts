import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  resolveRemoteDesktopSessionProfile,
} from '../../shared/remote-desktop-platform.js';
import {
  MACOS_REMOTE_DESKTOP_READINESS_MODE,
  resolveMacosRemoteDesktopRuntimeProfile,
  type MacosRemoteDesktopReadinessInput,
} from '../../src/node/macos-remote-desktop-readiness.js';

const READY: MacosRemoteDesktopReadinessInput = {
  artifactVerified: true,
  activeUserQualified: true,
  screenRecording: true,
  encoder: true,
  accessibility: true,
  clipboard: true,
  disclosure: true,
};

describe('macOS remote-desktop runtime readiness', () => {
  it.each([
    'artifactVerified',
    'activeUserQualified',
    'encoder',
    'disclosure',
  ] as const)('advertises nothing when %s is unavailable', (field) => {
    const profile = resolveMacosRemoteDesktopRuntimeProfile({
      ...READY,
      [field]: false,
    });
    expect(profile).toEqual({
      mode: MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE,
      sessionCapabilities: [],
      adapterCapabilities: [],
    });
  });

  it('says screen recording is missing instead of saying nothing', () => {
    // Screen recording is the one input a machine cannot grant itself, and it
    // is reported so the operator can be told to go click allow. Advertising
    // nothing made a Mac one dialog away from working indistinguishable from
    // one that will never work.
    //
    // The set carries no capture capability, which is what keeps it
    // unlaunchable -- and is exactly the shape the browser reads as "screen
    // recording required".
    const profile = resolveMacosRemoteDesktopRuntimeProfile({ ...READY, screenRecording: false });
    expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.PERMISSION_REQUIRED);
    expect([...profile.sessionCapabilities, ...profile.adapterCapabilities])
      .not.toContain(REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT);
    expect(resolveRemoteDesktopSessionProfile([
      ...profile.sessionCapabilities,
      ...profile.adapterCapabilities,
    ])).toBeNull();
  });

  it('does not offer to ask when the components are not even there', () => {
    // Absent components are not a permission problem. Offering "grant access"
    // for them sends the operator to a dialog that cannot help.
    for (const field of ['artifactVerified', 'activeUserQualified', 'encoder', 'disclosure'] as const) {
      expect(resolveMacosRemoteDesktopRuntimeProfile({
        ...READY, screenRecording: false, [field]: false,
      }).mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);
    }
  });

  it('advertises a valid View-only profile without Accessibility', () => {
    const profile = resolveMacosRemoteDesktopRuntimeProfile({
      ...READY,
      accessibility: false,
    });
    expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.VIEW);
    expect(profile.sessionCapabilities).toEqual([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
    ]);
    expect(profile.adapterCapabilities).toEqual([
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
    ]);
    expect(resolveRemoteDesktopSessionProfile([
      ...profile.sessionCapabilities,
      ...profile.adapterCapabilities,
    ])).toMatchObject({ platform: 'macos', input: false, explicitClipboard: false });
  });

  it('advertises Control and explicit clipboard only when their local seams are ready', () => {
    const control = resolveMacosRemoteDesktopRuntimeProfile(READY);
    expect(control.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.CONTROL);
    expect(control.adapterCapabilities).toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    expect(control.sessionCapabilities).toContain(REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY);

    const noClipboard = resolveMacosRemoteDesktopRuntimeProfile({
      ...READY,
      clipboard: false,
    });
    expect(noClipboard.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.CONTROL);
    expect(noClipboard.adapterCapabilities).toContain(REMOTE_DESKTOP_INPUT_CAPABILITY);
    expect(noClipboard.sessionCapabilities).not.toContain(
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    );
  });

  it('never synthesizes unsupported first-release capabilities', () => {
    const profile = resolveMacosRemoteDesktopRuntimeProfile(READY);
    const advertised = [...profile.sessionCapabilities, ...profile.adapterCapabilities];
    expect(advertised).not.toContain(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS);
    expect(advertised).not.toContain(REMOTE_DESKTOP_PLATFORM_CAPABILITY.LINUX);
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_X11);
    expect(advertised).not.toContain(REMOTE_DESKTOP_CAPTURE_CAPABILITY.LINUX_PORTAL_PIPEWIRE);
  });

  it('does not widen authority from partial virtual-display or LoginWindow probe evidence', () => {
    const partialLocalEvidence = resolveMacosRemoteDesktopRuntimeProfile({
      ...READY,
      virtualDisplay: true,
      loginWindow: true,
    });
    const advertised = [
      ...partialLocalEvidence.sessionCapabilities,
      ...partialLocalEvidence.adapterCapabilities,
    ];
    expect(advertised).not.toContain(REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY);
    expect(advertised).not.toContain(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
    expect(resolveRemoteDesktopSessionProfile(advertised)).toMatchObject({
      platform: 'macos',
      displayControl: false,
      lockScreen: false,
    });

    const viewOnly = resolveMacosRemoteDesktopRuntimeProfile({
      ...READY,
      accessibility: false,
      virtualDisplay: true,
      loginWindow: true,
    });
    expect([...viewOnly.sessionCapabilities, ...viewOnly.adapterCapabilities])
      .not.toContain(REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY);
    expect(viewOnly.adapterCapabilities).not.toContain(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY);
  });
});
