import { render, screen, cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { MobileDpad, DPAD_ARROW_SEQUENCES, resolveDpadDirection } from '../../src/components/MobileDpad.js';

afterEach(cleanup);

describe('DPAD_ARROW_SEQUENCES', () => {
  it('uses standard CSI arrow sequences so the daemon XTERM_KEY_MAP applies ncdu/TUI handling', () => {
    // These MUST be the normal-cursor (CSI) form. The daemon maps each one to a
    // tmux key name (Up/Down/Left/Right) via XTERM_KEY_MAP; tmux then emits the
    // app-correct sequence (e.g. SS3 \x1bOA) for apps in application-cursor-keys
    // mode like ncdu / vim / less / fzf / htop. Sending raw SS3 here would break
    // that, so this invariant is locked.
    expect(DPAD_ARROW_SEQUENCES).toEqual({
      up: '\x1b[A',
      down: '\x1b[B',
      left: '\x1b[D',
      right: '\x1b[C',
    });
  });
});

describe('resolveDpadDirection', () => {
  it('maps the dominant axis to the matching direction once past the deadzone', () => {
    expect(resolveDpadDirection(0, 40)).toBe('down');
    expect(resolveDpadDirection(0, -40)).toBe('up');
    expect(resolveDpadDirection(40, 0)).toBe('right');
    expect(resolveDpadDirection(-40, 0)).toBe('left');
  });

  it('picks the larger axis on a diagonal drag (horizontal wins ties)', () => {
    expect(resolveDpadDirection(30, 10)).toBe('right');
    expect(resolveDpadDirection(-10, 30)).toBe('down');
    expect(resolveDpadDirection(20, 20)).toBe('right'); // |dx| >= |dy| → horizontal
    expect(resolveDpadDirection(-20, -20)).toBe('left');
  });

  it('returns null inside the deadzone (a tap sends nothing)', () => {
    expect(resolveDpadDirection(0, 0)).toBeNull();
    expect(resolveDpadDirection(3, 2)).toBeNull(); // hypot ≈ 3.6 < 8
    expect(resolveDpadDirection(-5, 5)).toBeNull(); // hypot ≈ 7.07 < 8
  });

  it('honors a custom deadzone', () => {
    expect(resolveDpadDirection(0, 12, 20)).toBeNull();
    expect(resolveDpadDirection(0, 25, 20)).toBe('down');
  });

  it('returns null for non-finite deltas (defensive — never fire on a bad event)', () => {
    expect(resolveDpadDirection(Number.NaN, 40)).toBeNull();
    expect(resolveDpadDirection(40, Number.NaN)).toBeNull();
    expect(resolveDpadDirection(Infinity, 0)).toBeNull();
  });
});

describe('MobileDpad render', () => {
  it('renders an accessible button exposing the four direction glyphs', () => {
    render(<MobileDpad onDirection={() => {}} title="Arrow keys" />);
    const pad = screen.getByRole('button', { name: 'Arrow keys' });
    expect(pad).toBeTruthy();
    expect(pad.className).toContain('shortcut-dpad');
    // Four directional arrows present for visual affordance.
    expect(pad.querySelectorAll('.dpad-arrow').length).toBe(4);
    expect(pad.getAttribute('data-disabled')).toBeNull();
  });

  it('marks itself disabled so pointer interaction is suppressed', () => {
    render(<MobileDpad onDirection={() => {}} title="Arrow keys" disabled />);
    const pad = screen.getByRole('button', { name: 'Arrow keys' });
    expect(pad.getAttribute('data-disabled')).toBe('true');
    expect(pad.getAttribute('aria-disabled')).toBe('true');
  });
});
