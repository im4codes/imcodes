import { describe, expect, it, vi } from 'vitest';
import {
  detectRemoteDesktopClipboardShortcut,
  focusRemoteDesktopMobileInput,
  mapRemoteDesktopKeyboardEvent,
  remoteDesktopModifierKind,
  shouldForwardRemoteDesktopCopyKeystroke,
  translateRemoteDesktopShortcut,
  REMOTE_DESKTOP_CLIPBOARD_SHORTCUT,
  REMOTE_DESKTOP_MOBILE_INPUT_ACCESSORY_SUPPRESS_MS,
  REMOTE_DESKTOP_MOBILE_SHORTCUT_IDS,
  remoteDesktopCommandBridge,
  remoteDesktopMobileDeletionKey,
  remoteDesktopMobileShortcutKeys,
  remoteDesktopShortcutLabel,
  sendRemoteDesktopChord,
  splitRemoteDesktopMobileTextEnter,
  REMOTE_DESKTOP_COMPUTER_CASE_KEY,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE3,
  isRemoteDesktopComputerLetterKey,
  remoteDesktopComputerKeyChord,
  isRemoteDesktopMobileLineBreak,
  remoteDesktopComputerCapitalChord,
  remoteDesktopComputerKeyLabel,
  remoteDesktopMobileEditingKey,
} from '../src/remote-desktop-keyboard.js';

describe('remote desktop keyboard mapping', () => {
  it('maps Apple Command transitions and chords to Control when the target is not also a Mac', () => {
    // No target platform resolved yet (null) preserves the original
    // Windows-only-target behavior, same as an explicit 'windows'/'linux' target.
    for (const targetPlatform of [null, 'windows', 'linux'] as const) {
      expect(mapRemoteDesktopKeyboardEvent({
        code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
      }, 'MacIntel', targetPlatform)).toEqual({
        code: 'ControlLeft',
        key: 'Control',
        modifiers: { control: true, alt: false },
        commandAsControl: true,
        usesCommandBridge: true,
      });
      expect(mapRemoteDesktopKeyboardEvent({
        code: 'KeyA', key: 'a', ctrlKey: false, altKey: false, metaKey: true,
      }, 'MacIntel', targetPlatform)?.modifiers).toEqual({ control: true, alt: false });
    }
  });

  it('forwards Command as itself, untranslated, when the target is also a Mac', () => {
    // This is the fix: Control is not bound to anything on macOS (and can mean
    // something else entirely, e.g. SIGINT in a terminal), so translating an
    // Apple controller's Command to Control for a macOS target used to make
    // every Command-based shortcut a silent no-op there.
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
    }, 'MacIntel', 'macos')).toEqual({
      code: 'MetaLeft',
      key: 'Meta',
      modifiers: { control: false, alt: false },
      commandAsControl: false,
      usesCommandBridge: true,
    });
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'MetaRight', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
    }, 'MacIntel', 'macos')?.code).toBe('MetaRight');
    // Held Command does not fold into "control" for a Mac target -- it is a
    // different remote modifier, not a stand-in for one.
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'KeyZ', key: 'z', ctrlKey: false, altKey: false, metaKey: true,
    }, 'MacIntel', 'macos')).toMatchObject({
      code: 'KeyZ',
      modifiers: { control: false, alt: false },
    });
  });

  it('keeps Windows Control and does not forward the local Windows key from a non-Apple controller to a PC target', () => {
    for (const targetPlatform of [null, 'windows', 'linux'] as const) {
      expect(mapRemoteDesktopKeyboardEvent({
        code: 'KeyA', key: 'a', ctrlKey: true, altKey: false, metaKey: false,
      }, 'Win32', targetPlatform)).toMatchObject({
        code: 'KeyA',
        modifiers: { control: true, alt: false },
        commandAsControl: false,
        usesCommandBridge: false,
      });
      expect(mapRemoteDesktopKeyboardEvent({
        code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
      }, 'Win32', targetPlatform)).toBeNull();
    }
  });

  it('sends a Windows/Linux operator\'s Control to a macOS target as Command', () => {
    // Control+C/V/Z/A/S... are not bound to anything on a Mac; the same
    // shortcuts are spelled with Command there.
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'ControlLeft', key: 'Control', ctrlKey: true, altKey: false, metaKey: false,
    }, 'Win32', 'macos')).toEqual({
      code: 'MetaLeft',
      key: 'Meta',
      modifiers: { control: false, alt: false },
      commandAsControl: false,
      usesCommandBridge: false,
    });
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'ControlRight', key: 'Control', ctrlKey: true, altKey: false, metaKey: false,
    }, 'Linux x86_64', 'macos')?.code).toBe('MetaRight');
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'KeyA', key: 'a', ctrlKey: true, altKey: false, metaKey: false,
    }, 'Win32', 'macos')).toMatchObject({ code: 'KeyA', modifiers: { control: false, alt: false } });
    // The local Windows key still never travels.
    expect(mapRemoteDesktopKeyboardEvent({
      code: 'MetaLeft', key: 'Meta', ctrlKey: false, altKey: false, metaKey: true,
    }, 'Win32', 'macos')).toBeNull();
  });

  it('resolves the command bridge for every controller/target pairing', () => {
    expect(remoteDesktopCommandBridge('MacIntel', 'windows')).toEqual({
      appleController: true, translateToControl: true, code: 'ControlLeft', key: 'Control',
    });
    expect(remoteDesktopCommandBridge('MacIntel', null)).toEqual({
      appleController: true, translateToControl: true, code: 'ControlLeft', key: 'Control',
    });
    expect(remoteDesktopCommandBridge('MacIntel', 'macos')).toEqual({
      appleController: true, translateToControl: false, code: 'MetaLeft', key: 'Meta',
    });
    expect(remoteDesktopCommandBridge('Win32', 'macos')).toEqual({
      appleController: false, translateToControl: false, code: 'ControlLeft', key: 'Control',
    });
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

  it('never offers a raw-keystroke copy/paste chip', () => {
    // The dedicated copy/paste buttons answer both actions through the
    // clipboard bridge instead, which works on every remote platform, so this
    // row must never grow a raw-keystroke copy/paste entry again.
    expect(REMOTE_DESKTOP_MOBILE_SHORTCUT_IDS).not.toContain('copy');
    expect(REMOTE_DESKTOP_MOBILE_SHORTCUT_IDS).not.toContain('paste');
  });

  it('sends mobile shortcut chips in the TARGET platform own terms, not the controller\'s', () => {
    // A chip click has no physical keypress behind it -- there is no
    // controller convention to reconcile, only the target host's own binding.
    // Control+A/C/V/X/Z/etc. is not bound to anything on macOS (and can mean
    // something else entirely, e.g. SIGINT in a terminal for Ctrl+C), so this
    // used to be a silent no-op on a macOS target while looking identical to
    // a working press there.
    expect(remoteDesktopMobileShortcutKeys('select_all', 'windows')).toEqual([
      { code: 'ControlLeft', key: 'Control' }, { code: 'KeyA', key: 'a' },
    ]);
    expect(remoteDesktopMobileShortcutKeys('select_all', 'macos')).toEqual([
      { code: 'MetaLeft', key: 'Meta' }, { code: 'KeyA', key: 'a' },
    ]);
    expect(remoteDesktopMobileShortcutKeys('select_all', null)).toEqual([
      { code: 'ControlLeft', key: 'Control' }, { code: 'KeyA', key: 'a' },
    ]);
    // Redo differs by more than the modifier on a Mac target.
    expect(remoteDesktopMobileShortcutKeys('redo', 'windows')).toEqual([
      { code: 'ControlLeft', key: 'Control' }, { code: 'KeyY', key: 'y' },
    ]);
    expect(remoteDesktopMobileShortcutKeys('redo', 'macos')).toEqual([
      { code: 'MetaLeft', key: 'Meta' }, { code: 'ShiftLeft', key: 'Shift' }, { code: 'KeyZ', key: 'z' },
    ]);
    // Window switching is Alt+Tab on Windows/Linux but Command+Tab on macOS.
    expect(remoteDesktopMobileShortcutKeys('switch_window', 'windows')).toEqual([
      { code: 'AltLeft', key: 'Alt' }, { code: 'Tab', key: 'Tab' },
    ]);
    expect(remoteDesktopMobileShortcutKeys('switch_window', 'macos')).toEqual([
      { code: 'MetaLeft', key: 'Meta' }, { code: 'Tab', key: 'Tab' },
    ]);
    // Modifier-free shortcuts are unaffected by target platform.
    expect(remoteDesktopMobileShortcutKeys('escape', 'macos')).toEqual([
      { code: 'Escape', key: 'Escape' },
    ]);
  });

  it('labels mobile shortcut chips for the target platform', () => {
    expect(remoteDesktopShortcutLabel('select_all', 'windows')).toBe('Ctrl+A');
    expect(remoteDesktopShortcutLabel('select_all', 'macos')).toBe('⌘+A');
    expect(remoteDesktopShortcutLabel('redo', 'windows')).toBe('Ctrl+Y');
    expect(remoteDesktopShortcutLabel('redo', 'macos')).toBe('⌘+⇧+Z');
    expect(remoteDesktopShortcutLabel('switch_window', 'windows')).toBe('Alt+Tab');
    expect(remoteDesktopShortcutLabel('switch_window', 'macos')).toBe('⌘+Tab');
    expect(remoteDesktopShortcutLabel('escape', 'macos')).toBe('Esc');
  });

  it('maps mobile beforeinput deletion commands to remote editing keys', () => {
    expect(remoteDesktopMobileDeletionKey('deleteContentBackward')).toEqual({
      code: 'Backspace', key: 'Backspace',
    });
    expect(remoteDesktopMobileDeletionKey('deleteWordBackward')).toEqual({
      code: 'Backspace', key: 'Backspace',
    });
    expect(remoteDesktopMobileDeletionKey('deleteContentForward')).toEqual({
      code: 'Delete', key: 'Delete',
    });
    expect(remoteDesktopMobileDeletionKey('insertText')).toBeNull();
    expect(remoteDesktopMobileDeletionKey('deleteByCut')).toBeNull();
  });

  it('splits a trailing mobile-IME line break off committed text as a real Enter', () => {
    // The bug this exists to fix: a mobile on-screen keyboard's Enter/Return/
    // Go key shows up as an ordinary "\n" bundled into the committed text
    // (compositionend's value, or a plain non-composing input event's value)
    // -- never as a distinguishable keydown here -- and sending that value
    // straight through the remote TEXT channel silently drops it, since that
    // channel inserts literal Unicode and does not itself synthesize a
    // keypress. Nothing reached the remote target: Enter just did nothing.
    expect(splitRemoteDesktopMobileTextEnter('hello')).toEqual({ text: 'hello', enter: false });
    expect(splitRemoteDesktopMobileTextEnter('hello\n')).toEqual({ text: 'hello', enter: true });
    // CRLF: the whole line-break sequence is stripped, not just the last
    // character -- a naive `.slice(0, -1)` would leave a stray trailing "\r"
    // riding along in the text portion.
    expect(splitRemoteDesktopMobileTextEnter('hello\r\n')).toEqual({ text: 'hello', enter: true });
    expect(splitRemoteDesktopMobileTextEnter('hello\r')).toEqual({ text: 'hello', enter: true });
    // Enter pressed with nothing composed ahead of it -- a real, common case
    // (see the acceptance criteria: "Enter pressed with no active
    // composition") -- still correctly recognized, with no text to send.
    expect(splitRemoteDesktopMobileTextEnter('\n')).toEqual({ text: '', enter: true });
    expect(splitRemoteDesktopMobileTextEnter('')).toEqual({ text: '', enter: false });
    // A line break that is not TRAILING is not this function's concern --
    // Enter is a distinct, subsequent event on this single-row field, not
    // something that arrives pre-embedded mid-string.
    expect(splitRemoteDesktopMobileTextEnter('hello\nworld')).toEqual({
      text: 'hello\nworld', enter: false,
    });
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
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyZ', ctrlKey: true }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({}), 'Win32')).toBeNull();
  });

  it('treats cut as a clipboard shortcut too, on every platform pairing', () => {
    // A cut forwarded blind lands only in the remote clipboard, so the next
    // paste would bring back whatever was copied locally before it.
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyX', ctrlKey: true }), 'Win32'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.CUT);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyX', metaKey: true }), 'MacIntel', 'linux'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.CUT);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyX', ctrlKey: true, shiftKey: true }), 'Win32', 'linux'))
      .toBeNull();
  });

  it('reads the older Control+Insert / Shift+Insert pair on PC keyboards', () => {
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'Insert', ctrlKey: true }), 'Win32'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'Insert', shiftKey: true }), 'Linux x86_64', 'linux'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'Insert' }), 'Win32')).toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'Insert', ctrlKey: true, shiftKey: true }), 'Win32'))
      .toBeNull();
  });

  it('reads a Linux terminal\'s Control+Shift+C/V only for a PC operator on a Linux target', () => {
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true, shiftKey: true }), 'Win32', 'linux'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY);
    expect(detectRemoteDesktopClipboardShortcut(key({ code: 'KeyV', ctrlKey: true, shiftKey: true }), 'Win32', 'linux'))
      .toBe(REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE);
    expect(detectRemoteDesktopClipboardShortcut(key({ ctrlKey: true, shiftKey: true }), 'Win32', 'windows'))
      .toBeNull();
    expect(detectRemoteDesktopClipboardShortcut(key({ metaKey: true, shiftKey: true }), 'MacIntel', 'linux'))
      .toBeNull();
  });

  it('still delivers only a PC operator\'s plain Control+C to a Linux target', () => {
    // The Linux worker reads the selection without pressing anything, so the
    // keystroke has to arrive for itself: it interrupts a remote terminal.
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ ctrlKey: true }), 'Win32', 'linux')).toBe(true);
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ ctrlKey: true }), 'Linux x86_64', 'linux')).toBe(true);
    // A Mac operator's Command+C would arrive as that interrupt.
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ metaKey: true }), 'MacIntel', 'linux')).toBe(false);
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ ctrlKey: true, shiftKey: true }), 'Win32', 'linux')).toBe(false);
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ code: 'Insert', ctrlKey: true }), 'Win32', 'linux')).toBe(false);
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ ctrlKey: true }), 'Win32', 'windows')).toBe(false);
    expect(shouldForwardRemoteDesktopCopyKeystroke(key({ metaKey: true }), 'MacIntel', 'macos')).toBe(false);
  });
});

describe('shortcut translation between Mac and PC keyboards', () => {
  const press = (code: string, held: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    code, key: code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...held,
  });
  const chords = (value: ReturnType<typeof translateRemoteDesktopShortcut>) => (
    value?.map((chord) => chord.map((entry) => entry.code).join('+')) ?? null
  );

  it('spells a Mac operator\'s editing shortcuts the PC way on Windows and Linux', () => {
    for (const target of ['windows', 'linux', null] as const) {
      const mac = (code: string, held: Parameters<typeof press>[1]) => (
        chords(translateRemoteDesktopShortcut(press(code, held), 'MacIntel', target))
      );
      expect(mac('ArrowLeft', { metaKey: true })).toEqual(['Home']);
      expect(mac('ArrowRight', { metaKey: true })).toEqual(['End']);
      expect(mac('ArrowUp', { metaKey: true })).toEqual(['ControlLeft+Home']);
      expect(mac('ArrowDown', { metaKey: true })).toEqual(['ControlLeft+End']);
      expect(mac('ArrowLeft', { metaKey: true, shiftKey: true })).toEqual(['ShiftLeft+Home']);
      expect(mac('ArrowRight', { altKey: true })).toEqual(['ControlLeft+ArrowRight']);
      expect(mac('ArrowUp', { altKey: true, shiftKey: true })).toEqual(['ShiftLeft+ControlLeft+ArrowUp']);
      expect(mac('Backspace', { altKey: true })).toEqual(['ControlLeft+Backspace']);
      expect(mac('Delete', { altKey: true })).toEqual(['ControlLeft+Delete']);
      expect(mac('Backspace', { metaKey: true })).toEqual(['ShiftLeft+Home', 'Backspace']);
      expect(mac('Delete', { metaKey: true })).toEqual(['ShiftLeft+End', 'Delete']);
      expect(mac('BracketLeft', { metaKey: true, shiftKey: true })).toEqual(['ControlLeft+PageUp']);
      expect(mac('BracketRight', { metaKey: true, shiftKey: true })).toEqual(['ControlLeft+PageDown']);
      expect(mac('ArrowLeft', { metaKey: true, altKey: true })).toEqual(['ControlLeft+PageUp']);
      expect(mac('ArrowRight', { metaKey: true, altKey: true })).toEqual(['ControlLeft+PageDown']);
      // Everything else is a straight Command -> Control swap.
      expect(mac('KeyA', { metaKey: true })).toBeNull();
      expect(mac('KeyZ', { metaKey: true })).toBeNull();
      // Ambiguous between apps (browser back vs. outdent): left alone.
      expect(mac('BracketLeft', { metaKey: true })).toBeNull();
      expect(mac('ArrowLeft', {})).toBeNull();
    }
    // Redo: Windows apps take Control+Y, Linux apps Control+Shift+Z.
    expect(chords(translateRemoteDesktopShortcut(press('KeyZ', { metaKey: true, shiftKey: true }), 'MacIntel', 'windows')))
      .toEqual(['ControlLeft+KeyY']);
    expect(translateRemoteDesktopShortcut(press('KeyZ', { metaKey: true, shiftKey: true }), 'MacIntel', 'linux'))
      .toBeNull();
  });

  it('spells a Windows or Linux operator\'s shortcuts the Mac way on a Mac', () => {
    for (const controller of ['Win32', 'Linux x86_64']) {
      const pc = (code: string, held: Parameters<typeof press>[1] = {}) => (
        chords(translateRemoteDesktopShortcut(press(code, held), controller, 'macos'))
      );
      expect(pc('Home')).toEqual(['MetaLeft+ArrowLeft']);
      expect(pc('End', { shiftKey: true })).toEqual(['ShiftLeft+MetaLeft+ArrowRight']);
      expect(pc('Home', { ctrlKey: true })).toEqual(['MetaLeft+ArrowUp']);
      expect(pc('End', { ctrlKey: true })).toEqual(['MetaLeft+ArrowDown']);
      expect(pc('ArrowLeft', { ctrlKey: true })).toEqual(['AltLeft+ArrowLeft']);
      expect(pc('ArrowRight', { ctrlKey: true, shiftKey: true })).toEqual(['ShiftLeft+AltLeft+ArrowRight']);
      expect(pc('Backspace', { ctrlKey: true })).toEqual(['AltLeft+Backspace']);
      expect(pc('Delete', { ctrlKey: true })).toEqual(['AltLeft+Delete']);
      expect(pc('KeyY', { ctrlKey: true })).toEqual(['MetaLeft+ShiftLeft+KeyZ']);
      expect(pc('PageUp', { ctrlKey: true })).toEqual(['MetaLeft+ShiftLeft+BracketLeft']);
      expect(pc('PageDown', { ctrlKey: true })).toEqual(['MetaLeft+ShiftLeft+BracketRight']);
      // As Command these would switch apps, open Spotlight, hide or minimize.
      expect(pc('Tab', { ctrlKey: true })).toEqual(['ControlLeft+Tab']);
      expect(pc('Tab', { ctrlKey: true, shiftKey: true })).toEqual(['ShiftLeft+ControlLeft+Tab']);
      expect(pc('Space', { ctrlKey: true })).toEqual(['ControlLeft+Space']);
      expect(pc('KeyH', { ctrlKey: true })).toEqual(['ControlLeft+KeyH']);
      expect(pc('KeyM', { ctrlKey: true })).toEqual(['ControlLeft+KeyM']);
      // Everything else is a straight Control -> Command swap.
      expect(pc('KeyC', { ctrlKey: true })).toBeNull();
      expect(pc('KeyS', { ctrlKey: true })).toBeNull();
      expect(pc('ArrowLeft', { altKey: true })).toBeNull();
      expect(pc('ArrowLeft')).toBeNull();
    }
  });

  it('translates nothing between machines of the same family', () => {
    expect(translateRemoteDesktopShortcut(press('ArrowLeft', { metaKey: true }), 'MacIntel', 'macos')).toBeNull();
    expect(translateRemoteDesktopShortcut(press('Home'), 'Win32', 'linux')).toBeNull();
    expect(translateRemoteDesktopShortcut(press('Home'), 'Linux x86_64', 'windows')).toBeNull();
    expect(translateRemoteDesktopShortcut(press('ArrowLeft', { ctrlKey: true }), 'Win32', 'windows')).toBeNull();
  });

  it('knows which physical keys are modifiers', () => {
    expect(remoteDesktopModifierKind('ControlRight')).toBe('control');
    expect(remoteDesktopModifierKind('AltLeft')).toBe('alt');
    expect(remoteDesktopModifierKind('ShiftRight')).toBe('shift');
    expect(remoteDesktopModifierKind('MetaLeft')).toBe('meta');
    expect(remoteDesktopModifierKind('KeyA')).toBeNull();
  });
});

describe('focusRemoteDesktopMobileInput', () => {
  it('does nothing for a null or undefined input', () => {
    expect(() => focusRemoteDesktopMobileInput(null)).not.toThrow();
    expect(() => focusRemoteDesktopMobileInput(undefined)).not.toThrow();
  });

  it('makes the field briefly read-only/disabled (so iOS never draws its accessory bar), then clears both and refocuses it', () => {
    vi.useFakeTimers();
    try {
      const input = document.createElement('textarea');
      document.body.appendChild(input);
      const focusSpy = vi.spyOn(input, 'focus');

      focusRemoteDesktopMobileInput(input);
      // iOS decides whether to draw its accessory bar at this exact instant --
      // the field must already look non-editable, and must not yet be refocused.
      expect(input.hasAttribute('readonly')).toBe(true);
      expect(input.hasAttribute('disabled')).toBe(true);
      expect(focusSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(REMOTE_DESKTOP_MOBILE_INPUT_ACCESSORY_SUPPRESS_MS);
      expect(input.hasAttribute('readonly')).toBe(false);
      expect(input.hasAttribute('disabled')).toBe(false);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

      document.body.removeChild(input);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('phone keyboard editing keys', () => {
  it('takes Backspace, Delete and Return reported as themselves', () => {
    expect(remoteDesktopMobileEditingKey('Backspace', 8)).toEqual({ code: 'Backspace', key: 'Backspace' });
    expect(remoteDesktopMobileEditingKey('Delete', 46)).toEqual({ code: 'Delete', key: 'Delete' });
    expect(remoteDesktopMobileEditingKey('Enter', 13)).toEqual({ code: 'Enter', key: 'Enter' });
  });

  it('leaves composition keys and ordinary characters to the text path', () => {
    expect(remoteDesktopMobileEditingKey('Enter', 229)).toBeNull();
    expect(remoteDesktopMobileEditingKey('Unidentified', 229)).toBeNull();
    expect(remoteDesktopMobileEditingKey('a', 65)).toBeNull();
  });

  it('reads Return from an input event', () => {
    expect(isRemoteDesktopMobileLineBreak('insertLineBreak')).toBe(true);
    expect(isRemoteDesktopMobileLineBreak('insertParagraph')).toBe(true);
    expect(isRemoteDesktopMobileLineBreak('insertText')).toBe(false);
  });
});

describe('computer keyboard case key', () => {
  it('sits on the letters page and switches the letter labels', () => {
    expect(REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2.flat()).toContain(REMOTE_DESKTOP_COMPUTER_CASE_KEY);
    const q = REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2.flat().find((spec) => spec.code === 'KeyQ')!;
    expect(remoteDesktopComputerKeyLabel(q, 'windows')).toBe('q');
    expect(remoteDesktopComputerKeyLabel(q, 'windows', true)).toBe('Q');
    expect(remoteDesktopComputerKeyLabel(REMOTE_DESKTOP_COMPUTER_CASE_KEY, 'windows')).toBe('⇧');
    // Only letters change case.
    const digit = REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2.flat().find((spec) => spec.code === 'Digit1')!;
    expect(remoteDesktopComputerKeyLabel(digit, 'windows', true)).toBe('1');
    expect(isRemoteDesktopComputerLetterKey(digit)).toBe(false);
  });

  it('sends a capital as Shift plus the letter', () => {
    const q = REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2.flat().find((spec) => spec.code === 'KeyQ')!;
    expect(remoteDesktopComputerCapitalChord(q)).toEqual([
      { code: 'ShiftLeft', key: 'Shift' },
      { code: 'KeyQ', key: 'Q' },
    ]);
  });
});

describe('computer keyboard special-characters page', () => {
  const symbols = REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE3.flat();

  it('is the last page and carries every shifted symbol on the number and punctuation keys', () => {
    const pages = REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES;
    expect(pages[pages.length - 1]).toBe(REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE3);
    const glyphs = symbols.map((spec) => remoteDesktopComputerKeyLabel(spec, 'windows'));
    for (const glyph of '!@#$%^&*()_+{}|:"<>?~`'.split('')) expect(glyphs).toContain(glyph);
    // Every symbol names a distinct physical key + shift state, so none can shadow another.
    expect(new Set(symbols.map((spec) => `${spec.code}:${spec.shifted ? 1 : 0}`)).size).toBe(symbols.length);
  });

  it('sends a special character as Shift plus its key, and everything else as before', () => {
    const at = symbols.find((spec) => spec.key === '@')!;
    expect(remoteDesktopComputerKeyChord(at)).toEqual([
      { code: 'ShiftLeft', key: 'Shift' },
      { code: 'Digit2', key: '@' },
    ]);
    // The capitals toggle is about letters only; it never turns a symbol into something else.
    expect(remoteDesktopComputerKeyChord(at, true)).toEqual(remoteDesktopComputerKeyChord(at));
    const backtick = symbols.find((spec) => spec.code === 'Backquote' && !spec.shifted)!;
    expect(remoteDesktopComputerKeyChord(backtick)).toEqual([{ code: 'Backquote', key: '`' }]);
    const q = REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2.flat().find((spec) => spec.code === 'KeyQ')!;
    expect(remoteDesktopComputerKeyChord(q)).toEqual([{ code: 'KeyQ', key: 'q' }]);
    expect(remoteDesktopComputerKeyChord(q, true)).toEqual([
      { code: 'ShiftLeft', key: 'Shift' },
      { code: 'KeyQ', key: 'Q' },
    ]);
  });
});
