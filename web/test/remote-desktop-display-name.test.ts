import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { remoteDesktopDisplayName } from '../src/remote-desktop-display-name.js';

const t = ((key: string, values?: { number?: number }) => (
  key === 'remote_desktop.display_name_main'
    ? `Display ${values?.number} · Main`
    : `Display ${values?.number}`
)) as unknown as TFunction;

describe('remoteDesktopDisplayName', () => {
  it('numbers displays in the node\'s order and marks the main one', () => {
    // What node m3 reports for two identical 5K monitors.
    const displays = [
      { id: 'macos-display:5:3', primary: true },
      { id: 'macos-display:5:5', primary: false },
    ];
    expect(displays.map((display) => remoteDesktopDisplayName(t, displays, display)))
      .toEqual(['Display 1 · Main', 'Display 2']);
  });

  it('keeps a display\'s number when a caller lists only some of them', () => {
    const displays = [
      { id: 'one', primary: true },
      { id: 'two', primary: false },
      { id: 'three', primary: false },
    ];
    expect(remoteDesktopDisplayName(t, displays, displays[2]!)).toBe('Display 3');
  });
});
