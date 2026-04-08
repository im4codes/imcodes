import { describe, expect, it } from 'vitest';
import { getMobileKeyboardState } from '../src/mobile-keyboard.js';

describe('getMobileKeyboardState', () => {
  it('keeps controls hidden immediately after focus before the keyboard resize lands', () => {
    expect(getMobileKeyboardState(true, 0, false)).toEqual({
      kbOpen: false,
      hideInputUi: true,
      hadKeyboardOpen: false,
    });
  });

  it('keeps controls hidden while the keyboard is open', () => {
    expect(getMobileKeyboardState(true, 220, false)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });
  });

  it('restores controls when the keyboard closes without a blur event', () => {
    expect(getMobileKeyboardState(true, 0, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: true,
    });
  });

  it('re-hides controls if the focused input opens the keyboard again', () => {
    expect(getMobileKeyboardState(true, 180, true)).toEqual({
      kbOpen: true,
      hideInputUi: true,
      hadKeyboardOpen: true,
    });
  });

  it('does not keep keyboard history once focus is gone', () => {
    expect(getMobileKeyboardState(false, 0, true)).toEqual({
      kbOpen: false,
      hideInputUi: false,
      hadKeyboardOpen: false,
    });
  });
});
