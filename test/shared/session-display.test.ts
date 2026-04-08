import { describe, expect, it } from 'vitest';
import { isInternalSessionDisplayValue, pickReadableSessionDisplay } from '../../shared/session-display.js';

describe('session display helpers', () => {
  it('treats internal session identifiers as unreadable display values', () => {
    expect(isInternalSessionDisplayValue('deck_cd_brain')).toBe(true);
    expect(isInternalSessionDisplayValue('deck_sub_ab12cd34')).toBe(true);
    expect(isInternalSessionDisplayValue('bootmainxowfy6', 'bootmainxowfy6')).toBe(true);
  });

  it('keeps human labels and project names readable', () => {
    expect(isInternalSessionDisplayValue('cd')).toBe(false);
    expect(isInternalSessionDisplayValue('Boot Main')).toBe(false);
    expect(isInternalSessionDisplayValue('Worker 1')).toBe(false);
  });

  it('picks the first readable display candidate', () => {
    expect(pickReadableSessionDisplay(['deck_sub_ab12cd34', 'deck_cd_brain', 'Readable Main'])).toBe('Readable Main');
    expect(pickReadableSessionDisplay(['bootmainxowfy6', 'Boot Main'], 'bootmainxowfy6')).toBe('Boot Main');
  });
});
