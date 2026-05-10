import { describe, expect, it } from 'vitest';
import {
  SUBSESSION_ACCENT_COLORS,
  getSubSessionAccentColor,
  getSubSessionAccentColorMap,
} from '../src/subsession-accent-colors.js';

describe('sub-session accent colors', () => {
  it('provides a 15-color palette and cycles by order', () => {
    expect(SUBSESSION_ACCENT_COLORS).toHaveLength(15);
    expect(getSubSessionAccentColor(0)).toBe(SUBSESSION_ACCENT_COLORS[0]);
    expect(getSubSessionAccentColor(14)).toBe(SUBSESSION_ACCENT_COLORS[14]);
    expect(getSubSessionAccentColor(15)).toBe(SUBSESSION_ACCENT_COLORS[0]);
    expect(getSubSessionAccentColor(-1)).toBe(SUBSESSION_ACCENT_COLORS[14]);
  });

  it('builds a stable id to accent color map from sub-session order', () => {
    const map = getSubSessionAccentColorMap([
      { id: 'sub-a' },
      { id: 'sub-b' },
      { id: 'sub-c' },
    ]);

    expect(map.get('sub-a')).toBe(SUBSESSION_ACCENT_COLORS[0]);
    expect(map.get('sub-b')).toBe(SUBSESSION_ACCENT_COLORS[1]);
    expect(map.get('sub-c')).toBe(SUBSESSION_ACCENT_COLORS[2]);
  });
});
