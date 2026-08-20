import { describe, expect, it, vi } from 'vitest';
import {
  detectRemoteDesktopClipboardShortcut,
  mapRemoteDesktopKeyboardEvent,
  REMOTE_DESKTOP_CLIPBOARD_SHORTCUT,
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

describe('clipboard shortcuts', () => {
  const key = (over: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    code: 'KeyC', key: 'c', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over,
  });

  it('reads copy and paste in the controller platform own terms', () => {
    // The two clipboards are separate, so these are the shortcuts the bridge
    // has to answer rather than forward.
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true }), 'Win32'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyV', metaKey: true }), 'MacIntel'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE);
    // The other platform's modifier is not the operator's shortcut.
    expect(detectRemoteDesktopClipboardShortcut(key({ metaKey: true }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true }), 'MacIntel')).toBeNull();
    // Anything else held means a different command (paste-special, column
    // copy); those keep going to the remote untouched.
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true, shiftKey: true }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true, altKey: true }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyX', ctrlKey: true }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({}), 'Win32')).toBeNull();
  });
});

