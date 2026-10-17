import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT,
  clearRemoteDesktopBrowserDiagnostics,
  readRemoteDesktopBrowserDiagnostics,
  recordRemoteDesktopBrowserDiagnostic,
} from '../src/remote-desktop-browser-diagnostics.js';

describe('remote desktop browser diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearRemoteDesktopBrowserDiagnostics('server-1');
    vi.restoreAllMocks();
  });

  it('keeps one bounded epoch-millisecond ring without SDP, candidates or pixels', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_788_484_600_123);
    for (let sequence = 0; sequence < 300; sequence += 1) {
      recordRemoteDesktopBrowserDiagnostic('server-1', {
        type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.INBOUND_STATS,
        sequence,
        bytesReceived: sequence * 10,
        framesDecoded: sequence,
      });
    }

    const events = readRemoteDesktopBrowserDiagnostics('server-1');
    expect(events).toHaveLength(256);
    expect(events[0]).toMatchObject({ at: 1_788_484_600_123, sequence: 44 });
    expect(events.at(-1)).toMatchObject({ sequence: 299, framesDecoded: 299 });
    const persisted = sessionStorage.getItem('imcodes.remote-desktop.browser-diagnostics.v1:server-1');
    expect(JSON.parse(persisted ?? '[]')).toEqual(events);
    expect(persisted).not.toMatch(/candidate|capability|sdp|pixel/i);
  });

  it('clears the exact host ring without touching another active route', () => {
    recordRemoteDesktopBrowserDiagnostic('server-1', {
      type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_MUTE,
    });
    recordRemoteDesktopBrowserDiagnostic('server-2', {
      type: REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.TRACK_UNMUTE,
    });

    clearRemoteDesktopBrowserDiagnostics('server-1');

    expect(readRemoteDesktopBrowserDiagnostics('server-1')).toEqual([]);
    expect(readRemoteDesktopBrowserDiagnostics('server-2')).toHaveLength(1);
  });
});
