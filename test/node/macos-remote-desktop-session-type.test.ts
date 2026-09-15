import { describe, expect, it } from 'vitest';

import {
  MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM,
  MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND,
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES,
  MACOS_REMOTE_DESKTOP_SESSION_TYPE,
  isMacosRemoteDesktopSessionAuthority,
  macosRemoteDesktopAuthorityMayMigrate,
  macosRemoteDesktopCaptureBackend,
  macosRemoteDesktopSessionCapabilities,
  type MacosRemoteDesktopSessionAuthority,
} from '../../src/node/macos-remote-desktop-session-type.js';
import {
  MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT,
} from '../../src/node/macos-remote-desktop-launch-agent.js';

const CHALLENGE = 'A'.repeat(43);

function authority(
  overrides: Partial<MacosRemoteDesktopSessionAuthority> = {},
): MacosRemoteDesktopSessionAuthority {
  return {
    sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
    auditSessionId: 100_001,
    launchChallenge: CHALLENGE,
    workerGeneration: 3,
    ...overrides,
  };
}

describe('macOS remote-desktop session type authority', () => {
  it('grants the login window capture and input only', () => {
    const login = macosRemoteDesktopSessionCapabilities(
      MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
    );
    // Nobody is logged in, so every surface below would act as a principal the
    // operator never authenticated as.
    expect(login).toEqual({
      capture: true,
      pointer: true,
      keyboard: true,
      clipboard: false,
      fileTransfer: false,
      keychain: false,
      shell: false,
      computerUse: false,
    });
  });

  it('does not let the login window inherit any Aqua surface', () => {
    const login = macosRemoteDesktopSessionCapabilities(
      MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW,
    );
    const aqua = macosRemoteDesktopSessionCapabilities(
      MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA,
    );
    for (const surface of ['clipboard', 'fileTransfer', 'keychain', 'shell', 'computerUse'] as const) {
      expect(aqua[surface], `Aqua ${surface}`).toBe(true);
      expect(login[surface], `LoginWindow ${surface}`).toBe(false);
    }
  });

  it('refuses to carry authority across a login or logout', () => {
    const before = authority();
    // Logging in replaces the principal. A lease authorized against the login
    // window must not become a lease against the user who just signed in.
    expect(macosRemoteDesktopAuthorityMayMigrate(
      before,
      authority({ sessionType: MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA }),
    )).toBe(false);
    // A second login window is a different audit session even though the
    // session type matches.
    expect(macosRemoteDesktopAuthorityMayMigrate(
      before,
      authority({ auditSessionId: 100_002 }),
    )).toBe(false);
    expect(macosRemoteDesktopAuthorityMayMigrate(
      before,
      authority({ workerGeneration: 4 }),
    )).toBe(false);
    expect(macosRemoteDesktopAuthorityMayMigrate(
      before,
      authority({ launchChallenge: 'B'.repeat(43) }),
    )).toBe(false);
    expect(macosRemoteDesktopAuthorityMayMigrate(before, authority())).toBe(true);
  });

  it('validates authority with exact keys and positive identities', () => {
    expect(isMacosRemoteDesktopSessionAuthority(authority())).toBe(true);
    expect(isMacosRemoteDesktopSessionAuthority({
      ...authority(),
      extra: true,
    })).toBe(false);
    expect(isMacosRemoteDesktopSessionAuthority(
      authority({ auditSessionId: 0 }),
    )).toBe(false);
    expect(isMacosRemoteDesktopSessionAuthority(
      authority({ workerGeneration: 0 }),
    )).toBe(false);
    expect(isMacosRemoteDesktopSessionAuthority(
      authority({ launchChallenge: 'short' }),
    )).toBe(false);
    expect(isMacosRemoteDesktopSessionAuthority(
      { ...authority(), sessionType: 'Background' },
    )).toBe(false);
  });

  it('selects the capture backend the running release can actually use', () => {
    const login = MACOS_REMOTE_DESKTOP_SESSION_TYPE.LOGIN_WINDOW;
    // ScreenCaptureKit only serves the login window from 14.4.
    expect(macosRemoteDesktopCaptureBackend(login, '14.3.1'))
      .toBe(MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.CG_DISPLAY_STREAM);
    expect(macosRemoteDesktopCaptureBackend(login, '13.6'))
      .toBe(MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.CG_DISPLAY_STREAM);
    expect(macosRemoteDesktopCaptureBackend(login, '14.4'))
      .toBe(MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.SCREEN_CAPTURE_KIT);
    expect(macosRemoteDesktopCaptureBackend(login, '15.1.2'))
      .toBe(MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.SCREEN_CAPTURE_KIT);
    // Aqua has had a working path since the artifact's own minimum.
    expect(macosRemoteDesktopCaptureBackend(MACOS_REMOTE_DESKTOP_SESSION_TYPE.AQUA, '13.0'))
      .toBe(MACOS_REMOTE_DESKTOP_CAPTURE_BACKEND.SCREEN_CAPTURE_KIT);
    // An unreadable version is not silently treated as new enough.
    expect(macosRemoteDesktopCaptureBackend(login, 'sonoma')).toBeNull();
    expect(macosRemoteDesktopCaptureBackend(login, '')).toBeNull();
    expect(MACOS_LOGIN_WINDOW_SCREEN_CAPTURE_KIT_MINIMUM).toEqual({ major: 14, minor: 4 });
  });

  it('exposes the session type and audit identity to the agent', () => {
    expect(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.sessionType)
      .toBe('IMCODES_REMOTE_DESKTOP_SESSION_TYPE');
    expect(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT.auditSessionId)
      .toBe('IMCODES_REMOTE_DESKTOP_AUDIT_SESSION_ID');
    expect(MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_SESSION_TYPES).toEqual(['Aqua', 'LoginWindow']);
  });
});
