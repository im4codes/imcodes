import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ADAPTER_CAPABILITY,
} from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import { parseAdvertisedControlledNodeCapabilities } from '../../shared/controlled-node-capabilities.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from '../../shared/controlled-node-auto-unlock.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from '../../shared/remote-desktop-install.js';
import {
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_SUPPORTED_CONTROLLED_NODE_OSES,
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
  controlledNodeOsForRemoteDesktopPlatform,
  isRemoteDesktopSupportedControlledNodeOs,
  remoteDesktopSessionProfileIdentity,
  resolveRemoteDesktopSessionProfile,
} from '../../shared/remote-desktop-platform.js';
import {
  CONTROLLED_NODE_OS_LINUX,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
} from '../../shared/controlled-node-artifacts.js';

const MAC_VIEW = [
  REMOTE_DESKTOP_SESSION_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
  REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
  REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
  REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCAL_DISCLOSURE,
] as const;

describe('cross-platform remote desktop session profiles', () => {
  it('preserves the legacy Windows v2 capability without requiring v3', () => {
    expect(resolveRemoteDesktopSessionProfile([
      REMOTE_DESKTOP_CAPABILITY,
      REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
      CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
    ])).toMatchObject({
      kind: 'legacy_windows_v2',
      capability: REMOTE_DESKTOP_CAPABILITY,
      platform: 'windows',
      capture: 'windows_dxgi',
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    });
  });

  it('accepts a dual-profile Windows worker for mixed-version clients', () => {
    expect(resolveRemoteDesktopSessionProfile([
      REMOTE_DESKTOP_CAPABILITY,
      REMOTE_DESKTOP_SESSION_CAPABILITY,
      REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS,
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.WINDOWS_DXGI,
      REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.INPUT,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCAL_DISCLOSURE,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCK_SCREEN,
      REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
    ])).toMatchObject({
      kind: 'common_v3',
      platform: 'windows',
      input: true,
      capturePrivacy: true,
      lockScreen: true,
      displayControl: true,
    });
  });

  it('resolves macOS capture without Accessibility as View-only', () => {
    expect(resolveRemoteDesktopSessionProfile(MAC_VIEW)).toEqual(expect.objectContaining({
      kind: 'common_v3',
      platform: 'macos',
      capture: 'macos_screencapturekit',
      input: false,
      explicitClipboard: false,
    }));
  });

  it('resolves macOS Control only from explicit input and clipboard capabilities', () => {
    expect(resolveRemoteDesktopSessionProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.INPUT,
      REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY,
    ])).toEqual(expect.objectContaining({
      platform: 'macos',
      input: true,
      explicitClipboard: true,
    }));
  });

  it.each([
    ['missing platform', MAC_VIEW.filter((entry) => entry !== REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS)],
    ['missing capture', MAC_VIEW.filter((entry) => entry !== REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT)],
    ['missing encoder', MAC_VIEW.filter((entry) => entry !== REMOTE_DESKTOP_ENCODER_CAPABILITY.H264)],
    ['missing disclosure', MAC_VIEW.filter((entry) => entry !== REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCAL_DISCLOSURE)],
    ['contradictory platform', [...MAC_VIEW, REMOTE_DESKTOP_PLATFORM_CAPABILITY.WINDOWS]],
    ['wrong capture backend', [
      ...MAC_VIEW.filter((entry) => entry !== REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT),
      REMOTE_DESKTOP_CAPTURE_CAPABILITY.WINDOWS_DXGI,
    ]],
    ['clipboard without input', [...MAC_VIEW, REMOTE_DESKTOP_EXPLICIT_CLIPBOARD_CAPABILITY]],
    ['legacy Windows alias on macOS', [...MAC_VIEW, REMOTE_DESKTOP_CAPABILITY]],
    ['unsupported macOS signed account shell', [
      ...MAC_VIEW,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.SIGNED_ACCOUNT_SHELL,
    ]],
    ['unknown remote desktop capability', [...MAC_VIEW, 'remote.desktop.platform.plan9.v1']],
  ] as const)('fails closed for %s', (_label, capabilities) => {
    expect(resolveRemoteDesktopSessionProfile(capabilities)).toBeNull();
  });

  it.each([
    ['lock screen', REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCK_SCREEN],
    ['display control', REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY],
  ] as const)('fails closed for a macOS %s claim without input authority', (_label, action) => {
    const parsed = parseAdvertisedControlledNodeCapabilities([...MAC_VIEW, action]);
    expect(parsed).toEqual({ ok: true, value: [...MAC_VIEW, action] });
    expect(parsed.ok && resolveRemoteDesktopSessionProfile(parsed.value)).toBeNull();
  });

  it('accepts macOS capture privacy on View and Control profiles', () => {
    expect(resolveRemoteDesktopSessionProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY,
    ])).toMatchObject({ platform: 'macos', input: false, capturePrivacy: true });
    expect(resolveRemoteDesktopSessionProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.INPUT,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY,
    ])).toMatchObject({ platform: 'macos', input: true, capturePrivacy: true });
  });

  it('accepts probe-backed macOS action refinements only on an input-capable profile', () => {
    expect(resolveRemoteDesktopSessionProfile([
      ...MAC_VIEW,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.INPUT,
      REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCK_SCREEN,
      REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY,
    ])).toMatchObject({
      platform: 'macos',
      input: true,
      lockScreen: true,
      displayControl: true,
    });
  });

  it('ignores unrelated controlled-node capabilities but produces stable identity material', () => {
    const first = resolveRemoteDesktopSessionProfile([
      'machine.file.upload_fetch.v1',
      ...MAC_VIEW,
    ]);
    const second = resolveRemoteDesktopSessionProfile([...MAC_VIEW].reverse());
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(remoteDesktopSessionProfileIdentity(first!))
      .toBe(remoteDesktopSessionProfileIdentity(second!));
    expect(remoteDesktopSessionProfileIdentity(first!))
      .toMatch(/^imcodes\.remote-desktop\.profile\.v1\0/);
  });

  it('keeps unknown remote-desktop profile data fail-closed through production ingress', () => {
    const parsed = parseAdvertisedControlledNodeCapabilities([
      ...MAC_VIEW,
      'remote.desktop.platform.plan9.v1',
      'future.unrelated.feature.v1',
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: [...MAC_VIEW, REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY],
    });
    expect(parsed.ok && resolveRemoteDesktopSessionProfile(parsed.value)).toBeNull();
  });
});

/**
 * Regression coverage for a production bug: remote-desktop-router.ts's
 * accessFault() used to re-decide "which controlled-node OSes support
 * remote desktop" inline, in two separate spots, each its own hand-written
 * list. Windows and macOS were correct in both; Linux was missing from
 * both, and a Linux node's every session was refused as
 * `unsupported_platform` before its own capabilities were ever read --
 * confirmed live in production. These are now the one place that decision
 * is made.
 */
describe('controlledNodeOsForRemoteDesktopPlatform / isRemoteDesktopSupportedControlledNodeOs', () => {
  it('maps every RemoteDesktopPlatform to its controlled-node OS', () => {
    expect(controlledNodeOsForRemoteDesktopPlatform('windows')).toBe(CONTROLLED_NODE_OS_WIN);
    expect(controlledNodeOsForRemoteDesktopPlatform('macos')).toBe(CONTROLLED_NODE_OS_MAC);
    expect(controlledNodeOsForRemoteDesktopPlatform('linux')).toBe(CONTROLLED_NODE_OS_LINUX);
  });

  it('lists exactly windows, macos, and linux as supported -- no more, no fewer', () => {
    expect([...REMOTE_DESKTOP_SUPPORTED_CONTROLLED_NODE_OSES].sort()).toEqual(
      [CONTROLLED_NODE_OS_WIN, CONTROLLED_NODE_OS_MAC, CONTROLLED_NODE_OS_LINUX].sort(),
    );
  });

  it('accepts every supported OS and rejects null/unknown values', () => {
    expect(isRemoteDesktopSupportedControlledNodeOs(CONTROLLED_NODE_OS_WIN)).toBe(true);
    expect(isRemoteDesktopSupportedControlledNodeOs(CONTROLLED_NODE_OS_MAC)).toBe(true);
    expect(isRemoteDesktopSupportedControlledNodeOs(CONTROLLED_NODE_OS_LINUX)).toBe(true);
    expect(isRemoteDesktopSupportedControlledNodeOs(null)).toBe(false);
    expect(isRemoteDesktopSupportedControlledNodeOs('plan9')).toBe(false);
    expect(isRemoteDesktopSupportedControlledNodeOs('')).toBe(false);
  });
});
