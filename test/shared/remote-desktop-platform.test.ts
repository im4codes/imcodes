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
  REMOTE_DESKTOP_UNSUPPORTED_PROFILE_CAPABILITY,
  remoteDesktopSessionProfileIdentity,
  resolveRemoteDesktopSessionProfile,
} from '../../shared/remote-desktop-platform.js';

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
    ['unsupported macOS lock screen', [...MAC_VIEW, REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCK_SCREEN]],
    ['unsupported macOS capture privacy', [...MAC_VIEW, REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY]],
    ['unsupported macOS display control', [...MAC_VIEW, REMOTE_DESKTOP_DISPLAY_CONTROL_CAPABILITY]],
    ['unknown remote desktop capability', [...MAC_VIEW, 'remote.desktop.platform.plan9.v1']],
  ] as const)('fails closed for %s', (_label, capabilities) => {
    expect(resolveRemoteDesktopSessionProfile(capabilities)).toBeNull();
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
