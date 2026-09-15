/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openRemoteDesktopWallWindow,
  openRemoteDesktopWindow,
} from '../src/remote-desktop-window.js';

/**
 * Asking for a window and not a tab.
 *
 * Firefox honours the modern `popup` feature. Chromium-based browsers have
 * historically decided from the legacy chrome switches instead, which is how
 * the same call lands as a separate window in one browser and a tab in
 * another. The request therefore has to satisfy both rule sets, and these
 * tests encode the rules rather than the string -- a test that only checked
 * for the substring "popup" passed on the version that opened tabs.
 */

/** Parse a window-feature string the way the HTML spec says to. */
function parseFeatures(features: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const token of features.split(',')) {
    const [name, ...rest] = token.trim().split('=');
    if (name) parsed.set(name.trim().toLowerCase(), rest.join('=').trim().toLowerCase());
  }
  return parsed;
}

/** Boolean features are true as `name`, `name=yes`, `name=true`, or a non-zero number. */
function isOn(features: Map<string, string>, name: string): boolean {
  if (!features.has(name)) return false;
  const value = features.get(name)!;
  if (value === '') return true;
  if (value === 'yes' || value === 'true') return true;
  // Anything else is only true as a non-zero number. `no` parses to NaN, which
  // is not a number that means on -- reading NaN as truthy made this helper
  // claim `location=no` was enabled.
  const asNumber = Number.parseInt(value, 10);
  return Number.isFinite(asNumber) && asNumber !== 0;
}

function captureFeatures(open: () => void): Map<string, string> {
  const spy = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
  open();
  const features = String(spy.mock.calls[0]?.[2] ?? '');
  return parseFeatures(features);
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each([
  ['a single machine', () => { openRemoteDesktopWindow('server-1'); }],
  ['the wall', () => { openRemoteDesktopWallWindow(); }],
])('opening %s in its own window', (_label, open) => {
  it('asks for a popup by the modern feature', () => {
    expect(isOn(captureFeatures(open), 'popup')).toBe(true);
  });

  it('also satisfies the legacy rule engines fall back on', () => {
    // "location and toolbar are both false or absent" is the condition a
    // browser that ignores `popup` uses to decide on a window. Both are named
    // explicitly so it holds however the engine reads them.
    const features = captureFeatures(open);
    expect(isOn(features, 'location')).toBe(false);
    expect(isOn(features, 'toolbar')).toBe(false);
    expect(isOn(features, 'menubar')).toBe(false);
    expect(isOn(features, 'status')).toBe(false);
  });

  it('stays resizable and sized, because a fixed remote desktop is worse than a tab', () => {
    const features = captureFeatures(open);
    expect(isOn(features, 'resizable')).toBe(true);
    expect(Number(features.get('width'))).toBeGreaterThan(0);
    expect(Number(features.get('height'))).toBeGreaterThan(0);
  });

  it('never asks for noopener, which would hide whether the window opened', () => {
    // With `noopener` the call returns null, and callers read null as
    // "blocked by the browser" -- they would stop a working session.
    const features = captureFeatures(open);
    expect(features.has('noopener')).toBe(false);
    expect(features.has('noreferrer')).toBe(false);
  });

  it('severs the opener so the new window cannot reach back', () => {
    const opened = { opener: window } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(opened);
    open();
    expect(opened.opener).toBeNull();
  });

  it('reports a blocked popup as null rather than pretending it opened', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(open()).toBeUndefined();
  });
});
