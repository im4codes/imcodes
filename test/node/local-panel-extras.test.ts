import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_LOCAL_DEVICE_NAME_MAX_CHARS,
  sanitizeRemoteDesktopLocalExtras,
} from '../../shared/remote-desktop-local-management.js';
import { buildLocalPanelExtras } from '../../src/node/local-panel-extras.js';

const base = { remoteDesktopEnabled: false, screenRecordingRequired: false, inputAvailable: false, hostName: 'work-mac.local' };

describe('buildLocalPanelExtras', () => {
  it('sends the host name on every platform and no permissions off macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(buildLocalPanelExtras({ ...base, platform })).toEqual({ deviceName: 'work-mac.local' });
    }
  });

  it('on macOS reports what the node already knows and says "unknown" for the rest', () => {
    // Working remote desktop: capture and input are there.
    expect(buildLocalPanelExtras({ ...base, platform: 'darwin', remoteDesktopEnabled: true, inputAvailable: true }).permissions)
      .toEqual({ screenRecording: 'granted', accessibility: 'granted', fullDiskAccess: 'unknown' });
    // The worker answers but advertises no capture: Screen Recording is what is missing.
    expect(buildLocalPanelExtras({ ...base, platform: 'darwin', screenRecordingRequired: true }).permissions)
      .toEqual({ screenRecording: 'denied', accessibility: 'unknown', fullDiskAccess: 'unknown' });
    // Nothing known yet (worker not started): nothing is claimed.
    expect(buildLocalPanelExtras({ ...base, platform: 'darwin' }).permissions)
      .toEqual({ screenRecording: 'unknown', accessibility: 'unknown', fullDiskAccess: 'unknown' });
  });

  it('never reports accessibility as denied from the absence of the input adapter, nor Full Disk Access as anything but unknown', () => {
    const states = [true, false].flatMap((remoteDesktopEnabled) => [true, false].flatMap((screenRecordingRequired) => [true, false].map((inputAvailable) => (
      buildLocalPanelExtras({ ...base, platform: 'darwin', remoteDesktopEnabled, screenRecordingRequired, inputAvailable }).permissions!
    ))));
    for (const permissions of states) {
      expect(permissions.accessibility).not.toBe('denied');
      expect(permissions.fullDiskAccess).toBe('unknown');
    }
  });

  it('survives an empty host name', () => {
    expect(buildLocalPanelExtras({ ...base, platform: 'linux', hostName: '   ' })).toEqual({});
  });
});

describe('sanitizeRemoteDesktopLocalExtras', () => {
  it('keeps well formed values', () => {
    expect(sanitizeRemoteDesktopLocalExtras({ deviceName: ' My Mac ', permissions: { screenRecording: 'granted', accessibility: 'denied', fullDiskAccess: 'unknown' } }))
      .toEqual({ deviceName: 'My Mac', permissions: { screenRecording: 'granted', accessibility: 'denied', fullDiskAccess: 'unknown' } });
  });
  it('drops anything malformed instead of passing it on', () => {
    expect(sanitizeRemoteDesktopLocalExtras(null)).toEqual({});
    expect(sanitizeRemoteDesktopLocalExtras('x')).toEqual({});
    expect(sanitizeRemoteDesktopLocalExtras([])).toEqual({});
    expect(sanitizeRemoteDesktopLocalExtras({ deviceName: 5, permissions: 'granted' })).toEqual({});
    expect(sanitizeRemoteDesktopLocalExtras({ permissions: { screenRecording: 'maybe', camera: 'granted', accessibility: 'granted' } }))
      .toEqual({ permissions: { accessibility: 'granted' } });
    expect(sanitizeRemoteDesktopLocalExtras({ permissions: {} })).toEqual({});
  });
  it('turns control characters into spaces and bounds the host name', () => {
    expect(sanitizeRemoteDesktopLocalExtras({ deviceName: 'a\nb\u0000c\u007fd' }).deviceName).toBe('a b c d');
    const long = sanitizeRemoteDesktopLocalExtras({ deviceName: 'x'.repeat(1000) }).deviceName!;
    expect(long).toHaveLength(REMOTE_DESKTOP_LOCAL_DEVICE_NAME_MAX_CHARS);
    expect(sanitizeRemoteDesktopLocalExtras({ deviceName: '\n\t ' })).toEqual({});
  });
  it('keeps markup as plain text for the page to show with textContent', () => {
    expect(sanitizeRemoteDesktopLocalExtras({ deviceName: '<img src=x onerror=alert(1)>' }).deviceName).toBe('<img src=x onerror=alert(1)>');
  });
});
