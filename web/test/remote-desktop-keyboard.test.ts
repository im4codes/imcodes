import { describe, expect, it, vi } from 'vitest';
import {
  mapRemoteDesktopKeyboardEvent,
  sendRemoteDesktopChord,
} from '../src/remote-desktop-keyboard.js';

describe('remote desktop keyboard mapping', () => {
  it('maps Apple Command transitions and chords to Windows Control', () => {
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
    }, 'MacIntel')).toEqual({
      code: 'ControlLeft',
      key: 'Control',
      modifiers: { control: true, alt: false },
      commandAsControl: true,
    });
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'KeyA', key: 'a', ctrlKey: false, altKey: false, metaKey: true,
    }, 'MacIntel')?.modifiers).toEqual({ control: true, alt: false });
  });

  it('keeps Windows Control and does not forward the local Windows key', () => {
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'KeyA', key: 'a', ctrlKey: true, altKey: false, metaKey: false,
    }, 'Win32')).toMatchObject({
      code: 'KeyA',
      modifiers: { control: true, alt: false },
      commandAsControl: false,
    });
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
    }, 'Win32')).toBeNull();
  });

  it('presses a shortcut in order and releases it in reverse order', () => {
    const send = vi.fn(() => true);
    const releaseAll = vi.fn();
    expect(sendRemoteDesktopChord([
      { code: 'ControlLeft', key: 'Control' },
      { code: 'KeyA', key: 'a' },
    ], send, releaseAll)).toBe(true);
    expect(send.mock.calls).toEqual([
      ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
      ['KeyA', 'a', true, false, { control: true, alt: false }],
      ['KeyA', 'a', false, false, { control: true, alt: false }],
      ['ControlLeft', 'Control', false, false, { control: true, alt: false }],
    ]);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('fails closed by releasing all input after a partial chord failure', () => {
    const send = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const releaseAll = vi.fn();
    expect(sendRemoteDesktopChord([
      { code: 'ControlLeft', key: 'Control' },
      { code: 'KeyA', key: 'a' },
    ], send, releaseAll)).toBe(false);
    expect(releaseAll).toHaveBeenCalledTimes(1);
  });
});
