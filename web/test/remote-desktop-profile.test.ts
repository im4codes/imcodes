import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
} from '@shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
} from '@shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_WEB_READINESS,
  canOpenRemoteDesktopMachine,
  resolveRemoteDesktopWebProfile,
  resolveRemoteDesktopWebReadiness,
} from '../src/remote-desktop-profile.js';

const MAC_VIEW = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const;

const WINDOWS_COMMON = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.WINDOWS_DXGI,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
] as const;

describe('remote desktop Web session profile', () => {
  it('opens complete Windows and macOS profiles only for an operable role', () => {
    for (const capabilities of [WINDOWS_COMMON, MAC_VIEW]) {
      expect(canOpenRemoteDesktopMachine({
        online: true,
        execEnabled: true,
        accessRole: 'owner',
        capabilities,
      })).toBe(true);
      expect(canOpenRemoteDesktopMachine({
        online: true,
        execEnabled: true,
        accessRole: 'participant',
        capabilities,
      })).toBe(true);
      expect(canOpenRemoteDesktopMachine({
        online: false,
        execEnabled: true,
        accessRole: 'owner',
        capabilities,
      })).toBe(false);
      expect(canOpenRemoteDesktopMachine({
        online: true,
        execEnabled: false,
        accessRole: 'owner',
        capabilities,
      })).toBe(false);
      expect(canOpenRemoteDesktopMachine({
        online: true,
        execEnabled: true,
        accessRole: 'viewer',
        capabilities,
      })).toBe(false);
    }
  });

  it.each([
    undefined,
    [],
    ['remote.desktop.future.adapter.v99'],
    [REMOTE_DESKTOP_SESSION_CAPABILITY],
    [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ],
    [...MAC_VIEW, REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY],
  ])('fails launch closed for an absent, unknown, incomplete, or unsupported profile %#', (capabilities) => {
    expect(canOpenRemoteDesktopMachine({
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities,
    })).toBe(false);
  });

  it('does not let descriptive OS metadata change launch authority', () => {
    const candidate = (os: string | undefined, capabilities: readonly unknown[]) => ({
      os,
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities,
    });
    for (const os of [undefined, 'win', 'mac', 'linux', 'future-os']) {
      expect(canOpenRemoteDesktopMachine(candidate(os, MAC_VIEW))).toBe(true);
      expect(canOpenRemoteDesktopMachine(candidate(os, [REMOTE_DESKTOP_SESSION_CAPABILITY]))).toBe(false);
    }
  });

  it('preserves the established Windows v2 controls without OS inference', () => {
    expect(resolveRemoteDesktopWebProfile([REMOTE_DESKTOP_CAPABILITY])).toMatchObject({
      profile: { kind: 'legacy_windows_v2', platform: 'windows' },
      input: true,
      explicitClipboard: true,
      lockScreen: true,
      capturePrivacy: false,
      displayControl: true,
    });
  });

  it('resolves macOS View and Control only from complete advertised profiles', () => {
    expect(resolveRemoteDesktopWebProfile(MAC_VIEW)).toMatchObject({
      profile: { kind: 'common_v3', platform: 'macos' },
      input: false,
      explicitClipboard: false,
      lockScreen: false,
      capturePrivacy: false,
      displayControl: false,
    });
    expect(resolveRemoteDesktopWebProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    ])).toMatchObject({
      profile: { kind: 'common_v3', platform: 'macos' },
      input: true,
      explicitClipboard: true,
      lockScreen: false,
      capturePrivacy: false,
      displayControl: false,
    });
  });

  it('uses the complete common profile when a new Windows worker also advertises v2', () => {
    expect(resolveRemoteDesktopWebProfile([
      REMOTE_DESKTOP_CAPABILITY,
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.WINDOWS_DXGI,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
      REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
    ])).toMatchObject({
      profile: { kind: 'common_v3', platform: 'windows' },
      input: true,
      explicitClipboard: true,
      lockScreen: true,
      capturePrivacy: true,
      displayControl: true,
    });
  });

  it('fails closed for incomplete and unsupported macOS profiles', () => {
    expect(resolveRemoteDesktopWebProfile([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
    ])).toBeNull();
    expect(resolveRemoteDesktopWebProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
    ])).toBeNull();
  });

  it.each([
    ['lock screen', REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY],
    ['display control', REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY],
  ])('fails closed for a macOS %s claim without input authority', (_label, action) => {
    expect(resolveRemoteDesktopWebProfile([...MAC_VIEW, action])).toBeNull();
    expect(canOpenRemoteDesktopMachine({
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities: [...MAC_VIEW, action],
    })).toBe(false);
  });

  it('projects probe-backed macOS actions only with input authority', () => {
    const capabilities = [
      ...MAC_VIEW,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
      REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
    ];
    expect(resolveRemoteDesktopWebProfile(capabilities)).toMatchObject({
      profile: { platform: 'macos', input: true },
      input: true,
      lockScreen: true,
      displayControl: true,
    });
    expect(canOpenRemoteDesktopMachine({
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities,
    })).toBe(true);
  });

  it('changes authority when profile capabilities mutate, but not when reordered', () => {
    const control = [
      ...MAC_VIEW,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    ];
    expect(resolveRemoteDesktopWebProfile([...control].reverse())).toMatchObject({
      input: true,
      explicitClipboard: true,
    });
    expect(resolveRemoteDesktopWebProfile(MAC_VIEW)).toMatchObject({
      input: false,
      explicitClipboard: false,
    });
    expect(resolveRemoteDesktopWebProfile([...control, 'remote.desktop.future.macos.v9'])).toBeNull();
  });

  it('reports a narrowly recognizable missing Screen Recording adapter without authorizing it', () => {
    const capabilities = [
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
    ];
    expect(resolveRemoteDesktopWebReadiness(capabilities)).toMatchObject({
      kind: REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED,
      platform: 'macos',
      profile: null,
      screenRecordingReady: false,
      accessibilityReady: null,
    });
    expect(resolveRemoteDesktopWebProfile(capabilities)).toBeNull();
  });

  it('keeps unknown macOS adapters generic and fail closed instead of misdiagnosing permissions', () => {
    expect(resolveRemoteDesktopWebReadiness([
      ...MAC_VIEW,
      'remote.desktop.capture.macos.future.v9',
    ])).toMatchObject({
      kind: REMOTE_DESKTOP_WEB_READINESS.UNSUPPORTED_PROFILE,
      platform: 'macos',
      profile: null,
      screenRecordingReady: null,
      accessibilityReady: null,
    });
    expect(resolveRemoteDesktopWebReadiness([
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY,
    ])).toMatchObject({
      kind: REMOTE_DESKTOP_WEB_READINESS.UNSUPPORTED_PROFILE,
      platform: 'macos',
      profile: null,
    });
  });
});
