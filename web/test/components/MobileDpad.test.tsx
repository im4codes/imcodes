import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileDpad, DPAD_ARROW_SEQUENCES } from '../../src/components/MobileDpad.js';

afterEach(cleanup);

const down = (el: Element, x: number, y: number) =>
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
const move = (el: Element, x: number, y: number) =>
  fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y });
const up = (el: Element) =>
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch' });

describe('MobileDpad', () => {
  it('keeps standard CSI arrow sequences (so daemon XTERM_KEY_MAP applies ncdu/TUI handling)', () => {
    // These MUST be the normal-cursor (CSI) form. The daemon maps them to tmux
    // key names (Up/Down/Left/Right); tmux then emits the app-correct sequence
    // (e.g. SS3 \x1bOA) for apps in application-cursor-keys mode like ncdu/vim.
    expect(DPAD_ARROW_SEQUENCES).toEqual({
      up: '\x1b[A',
      down: '\x1b[B',
      left: '\x1b[D',
      right: '\x1b[C',
    });
  });

  it('fires the matching arrow sequence for each drag direction', () => {
    const onDirection = vi.fn();
    render(<MobileDpad onDirection={onDirection} title="dpad" />);
    const pad = screen.getByRole('button', { name: 'dpad' });

    down(pad, 100, 100); move(pad, 100, 140); // drag down
    expect(onDirection).toHaveBeenLastCalledWith('\x1b[B');
    up(pad);

    down(pad, 100, 100); move(pad, 100, 60); // drag up
    expect(onDirection).toHaveBeenLastCalledWith('\x1b[A');
    up(pad);

    down(pad, 100, 100); move(pad, 140, 100); // drag right
    expect(onDirection).toHaveBeenLastCalledWith('\x1b[C');
    up(pad);

    down(pad, 100, 100); move(pad, 60, 100); // drag left
    expect(onDirection).toHaveBeenLastCalledWith('\x1b[D');
    up(pad);
  });

  it('treats a tap (movement within the deadzone) as nothing', () => {
    const onDirection = vi.fn();
    render(<MobileDpad onDirection={onDirection} title="dpad" />);
    const pad = screen.getByRole('button', { name: 'dpad' });
    down(pad, 100, 100); move(pad, 103, 102); up(pad);
    expect(onDirection).not.toHaveBeenCalled();
  });

  it('does not re-fire the same held direction, but re-arms after returning to center', () => {
    const onDirection = vi.fn();
    render(<MobileDpad onDirection={onDirection} title="dpad" />);
    const pad = screen.getByRole('button', { name: 'dpad' });
    down(pad, 100, 100);
    move(pad, 100, 140); // down → fire #1
    move(pad, 100, 150); // still down, same direction → no new immediate fire
    expect(onDirection).toHaveBeenCalledTimes(1);
    move(pad, 100, 100); // back to center → re-arm
    move(pad, 100, 140); // down again → fire #2
    expect(onDirection).toHaveBeenCalledTimes(2);
    up(pad);
  });

  it('switches direction without needing to recenter (diagonal cross)', () => {
    const onDirection = vi.fn();
    render(<MobileDpad onDirection={onDirection} title="dpad" />);
    const pad = screen.getByRole('button', { name: 'dpad' });
    down(pad, 100, 100);
    move(pad, 100, 140); // down
    move(pad, 140, 100); // right (dominant axis flips) → new fire
    expect(onDirection).toHaveBeenNthCalledWith(1, '\x1b[B');
    expect(onDirection).toHaveBeenNthCalledWith(2, '\x1b[C');
    up(pad);
  });

  it('does nothing when disabled', () => {
    const onDirection = vi.fn();
    render(<MobileDpad onDirection={onDirection} title="dpad" disabled />);
    const pad = screen.getByRole('button', { name: 'dpad' });
    down(pad, 100, 100); move(pad, 100, 140); up(pad);
    expect(onDirection).not.toHaveBeenCalled();
  });
});
