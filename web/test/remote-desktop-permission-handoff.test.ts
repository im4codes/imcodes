import { describe, expect, it } from 'vitest';

import {
  REMOTE_DESKTOP_WEB_READINESS,
  canOpenRemoteDesktopMachine,
  resolveRemoteDesktopWebReadiness,
} from '../src/remote-desktop-profile.js';
import {
  MACOS_REMOTE_DESKTOP_READINESS_MODE,
  resolveMacosRemoteDesktopRuntimeProfile,
} from '../../src/node/macos-remote-desktop-readiness.js';

/**
 * The node half and the browser half of one decision, checked against each
 * other rather than each against its own idea of the format.
 *
 * The browser could already say "screen recording required", and the node
 * could already tell that screen recording was missing -- but the node
 * advertised NOTHING in that case, so the branch was unreachable from a real
 * machine. A Mac one dialog away from working was indistinguishable from a Mac
 * that would never work.
 */
function advertised(input: Parameters<typeof resolveMacosRemoteDesktopRuntimeProfile>[0]) {
  const profile = resolveMacosRemoteDesktopRuntimeProfile(input);
  return { profile, capabilities: [...profile.sessionCapabilities, ...profile.adapterCapabilities] };
}

const READY = {
  artifactVerified: true,
  activeUserQualified: true,
  screenRecording: true,
  encoder: true,
  accessibility: true,
  clipboard: true,
  disclosure: true,
} as const;

describe('macOS remote-desktop permission handoff', () => {
  it('advertises a set the browser reads as "screen recording required"', () => {
    const { profile, capabilities } = advertised({ ...READY, screenRecording: false });
    expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.PERMISSION_REQUIRED);

    const readiness = resolveRemoteDesktopWebReadiness(capabilities);
    expect(readiness.kind).toBe(REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED);
    expect(readiness.platform).toBe('macos');
    expect(readiness.screenRecordingReady).toBe(false);
  });

  it('still refuses to open a session on that machine', () => {
    // The point is to ask for one grant, not to soften the launch gate. A
    // machine without capture must not be openable however it is described.
    const { capabilities } = advertised({ ...READY, screenRecording: false });
    expect(canOpenRemoteDesktopMachine({
      online: true, execEnabled: true, accessRole: 'owner', capabilities,
    })).toBe(false);
  });

  it('opens normally once the grant exists', () => {
    const { profile, capabilities } = advertised(READY);
    expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.CONTROL);
    expect(canOpenRemoteDesktopMachine({
      online: true, execEnabled: true, accessRole: 'owner', capabilities,
    })).toBe(true);
  });

  it('says nothing when the components themselves are missing', () => {
    // Absent components are not a permission problem, and offering "grant
    // access" for them would send the operator to a dialog that cannot help.
    for (const missing of [
      { artifactVerified: false },
      { activeUserQualified: false },
      { encoder: false },
      { disclosure: false },
    ]) {
      const { profile, capabilities } = advertised({ ...READY, screenRecording: false, ...missing });
      expect(profile.mode).toBe(MACOS_REMOTE_DESKTOP_READINESS_MODE.UNAVAILABLE);
      expect(capabilities).toEqual([]);
      expect(resolveRemoteDesktopWebReadiness(capabilities).kind)
        .not.toBe(REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED);
    }
  });
});
