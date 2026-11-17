import { describe, expect, it } from 'vitest';
import {
  getMobileKeyboardState,
  isMobileKeyboardInputTarget,
  isSubSessionBarInputTarget,
  shouldSuppressSubSessionBarForKeyboard,
} from '../src/mobile-keyboard.js';

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

describe('sub-session mobile keyboard targeting & suppression', () => {
  it('identifies main, card, and window keyboard targets accurately', () => {
    document.body.innerHTML = `
      <div class="controls-input" contenteditable="true" data-testid="main-ce"></div>
      <div class="subsession-window">
        <div class="controls-input" contenteditable="true" data-testid="win-ce"></div>
      </div>
      <div class="subcard-bar">
        <div class="subcard-input-area">
          <div class="controls-input" contenteditable="true" data-testid="card-ce"></div>
          <input class="subcard-input" data-testid="card-input" />
        </div>
      </div>
      <button type="button" data-testid="plain-btn">Tap</button>
    `;

    const mainCe = document.querySelector('[data-testid="main-ce"]');
    const winCe = document.querySelector('[data-testid="win-ce"]');
    const cardCe = document.querySelector('[data-testid="card-ce"]');
    const cardInput = document.querySelector('[data-testid="card-input"]');
    const plainBtn = document.querySelector('[data-testid="plain-btn"]');

    expect(isMobileKeyboardInputTarget(mainCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(winCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(cardCe)).toBe(true);
    expect(isMobileKeyboardInputTarget(cardInput)).toBe(true);
    expect(isMobileKeyboardInputTarget(plainBtn)).toBe(false);

    expect(isSubSessionBarInputTarget(mainCe)).toBe(false);
    expect(isSubSessionBarInputTarget(winCe)).toBe(false);
    expect(isSubSessionBarInputTarget(cardCe)).toBe(true);
    expect(isSubSessionBarInputTarget(cardInput)).toBe(true);
    expect(isSubSessionBarInputTarget(plainBtn)).toBe(false);
  });

  it('suppresses .subcard-bar for external/main/window input focus, never when .subcard-bar owns focus', () => {
    document.documentElement.className = '';
    document.body.innerHTML = `
      <div class="subcard-bar">
        <input class="subcard-input" data-testid="card-input" />
      </div>
    `;

    // Positive control: main/window input focus or keyboard open hides .subcard-bar
    document.documentElement.classList.add('input-focused');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(true);
    document.documentElement.classList.add('kb-open');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(true);

    // Focusing sub-session card input sets .subcard-input-focused -> never suppress .subcard-bar
    document.documentElement.classList.add('subcard-input-focused');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(false);

    // Even if .subcard-input-focused is absent, native :focus-within inside .subcard-bar keeps it alive
    document.documentElement.classList.remove('subcard-input-focused');
    const cardInput = document.querySelector('[data-testid="card-input"]') as HTMLInputElement;
    cardInput.focus();
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(false);

    cardInput.blur();
    document.documentElement.className = '';
  });
});
