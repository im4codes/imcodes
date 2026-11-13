/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  canHandleGlobalNavigationShortcut,
  chordFromKeyboardEvent,
  cycleOrderedId,
  findShortcutConflicts,
  focusComposerElement,
  formatShortcutKeycaps,
  getDefaultShortcuts,
  isMacPlatform,
  matchesShortcutChord,
  matchNavigationShortcutAction,
  normalizeShortcutChordString,
  parseShortcutChord,
  resolveKeyboardShortcuts,
  sanitizeShortcutOverrides,
  serializeShortcutChord,
  sortSessionsByTabOrder,
} from '../src/keyboard-shortcuts.js';

describe('keyboard-shortcuts core helpers', () => {
  it('detects macOS vs Windows/Linux platforms and provides matching defaults', () => {
    expect(isMacPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '', userAgent: '' })).toBe(true);
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' })).toBe(false);

    expect(getDefaultShortcuts(true)).toEqual({
      serverPrev: 'Meta+ArrowUp',
      serverNext: 'Meta+ArrowDown',
      tabPrev: 'Meta+ArrowLeft',
      tabNext: 'Meta+ArrowRight',
    });

    expect(getDefaultShortcuts(false)).toEqual({
      serverPrev: 'Ctrl+ArrowUp',
      serverNext: 'Ctrl+ArrowDown',
      tabPrev: 'Ctrl+ArrowLeft',
      tabNext: 'Ctrl+ArrowRight',
    });
  });

  it('parses, serializes, normalizes, and formats keycaps accurately', () => {
    expect(parseShortcutChord('cmd+shift+left')).toEqual({
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: 'ArrowLeft',
    });
    expect(serializeShortcutChord({
      meta: true,
      ctrl: false,
      alt: true,
      shift: false,
      key: 'ArrowUp',
    })).toBe('Meta+Alt+ArrowUp');
    expect(normalizeShortcutChordString('control+alt+K')).toBe('Ctrl+Alt+k');
    expect(normalizeShortcutChordString('Escape')).toBeNull();
    expect(normalizeShortcutChordString('')).toBeNull();

    expect(formatShortcutKeycaps('Meta+ArrowUp', true)).toEqual(['⌘', '↑']);
    expect(formatShortcutKeycaps('Ctrl+ArrowLeft', false)).toEqual(['Ctrl', '←']);
    expect(formatShortcutKeycaps('Ctrl+Alt+Shift+k', false)).toEqual(['Ctrl', 'Alt', 'Shift', 'K']);
  });

  it('merges user overrides and preserves null cleared bindings across platform defaults', () => {
    const clean = sanitizeShortcutOverrides({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'invalid+escape',
      unknownAction: 'Ctrl+k',
    } as unknown);
    expect(clean).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
    });

    expect(resolveKeyboardShortcuts(clean, true)).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'Meta+ArrowLeft',
      tabNext: 'Meta+ArrowRight',
    });
    expect(resolveKeyboardShortcuts(clean, false)).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'Ctrl+ArrowLeft',
      tabNext: 'Ctrl+ArrowRight',
    });
  });

  it('captures valid chords and rejects bare modifiers, Escape, IME, and bare typing keys', () => {
    expect(chordFromKeyboardEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Control', code: 'ControlLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Escape', code: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'a', code: 'KeyA', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'A', code: 'KeyA', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'ArrowUp', code: 'ArrowUp', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, isComposing: true })).toBeNull();

    expect(chordFromKeyboardEvent({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('Meta+ArrowUp');
    expect(chordFromKeyboardEvent({ key: 'ArrowRight', code: 'ArrowRight', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe('Ctrl+Shift+ArrowRight');
    expect(chordFromKeyboardEvent({ key: '˚', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Alt+k');
    expect(chordFromKeyboardEvent({ key: 'F6', code: 'F6', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('F6');
  });

  it('matches exact modifier combinations and detects conflicts', () => {
    const macShortcuts = getDefaultShortcuts(true);
    expect(matchNavigationShortcutAction(
      { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBe('serverPrev');
    expect(matchNavigationShortcutAction(
      { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      macShortcuts,
    )).toBeNull();
    expect(matchesShortcutChord(
      { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      'Ctrl+ArrowLeft',
    )).toBe(true);

    expect(findShortcutConflicts({
      serverPrev: 'Ctrl+ArrowUp',
      serverNext: 'Ctrl+ArrowDown',
      tabPrev: 'Ctrl+ArrowUp',
      tabNext: null,
    })).toEqual({
      serverPrev: ['tabPrev'],
      tabPrev: ['serverPrev'],
    });
  });

  it('sorts tabs matching SessionTabs visual order (pinned first, then tabOrder) and cycles with wrap-around', () => {
    const sessions = [
      { name: 's1' },
      { name: 's2' },
      { name: 's3' },
      { name: 's4' },
    ];
    const sorted = sortSessionsByTabOrder(sessions, ['s3', 's1', 's4', 's2'], new Set(['s4']));
    expect(sorted.map((s) => s.name)).toEqual(['s4', 's3', 's1', 's2']);

    const ids = sorted.map((s) => s.name);
    expect(cycleOrderedId(ids, 's4', 1)).toBe('s3');
    expect(cycleOrderedId(ids, 's4', -1)).toBe('s2');
    expect(cycleOrderedId(ids, 's2', 1)).toBe('s4');
    expect(cycleOrderedId(ids, 'missing', 1)).toBe('s4');
    expect(cycleOrderedId(ids, 'missing', -1)).toBe('s2');
    expect(cycleOrderedId([], 's1', 1)).toBeNull();
  });

  it('allows global navigation in composer .controls-input but blocks recorder, modals, terminals, remote desktop, and mobile', () => {
    const composer = document.createElement('div');
    composer.className = 'controls-input';
    composer.contentEditable = 'true';
    composer.tabIndex = -1;
    document.body.appendChild(composer);
    composer.focus();

    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(true);

    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: true,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);

    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: true,
      viewMode: 'chat',
    })).toBe(false);

    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'terminal',
    })).toBe(false);

    const recorder = document.createElement('button');
    recorder.setAttribute('data-shortcut-recording', 'true');
    document.body.appendChild(recorder);
    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);
    recorder.remove();

    const announcement = document.createElement('aside');
    announcement.className = 'feature-announcement';
    announcement.setAttribute('role', 'dialog');
    document.body.appendChild(announcement);
    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(true);
    announcement.remove();

    const nonModalDialog = document.createElement('div');
    nonModalDialog.setAttribute('role', 'dialog');
    nonModalDialog.setAttribute('aria-modal', 'false');
    document.body.appendChild(nonModalDialog);
    expect(canHandleGlobalNavigationShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(true);
    nonModalDialog.remove();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogInput = document.createElement('input');
    dialog.appendChild(dialogInput);
    document.body.appendChild(dialog);
    expect(canHandleGlobalNavigationShortcut(dialogInput, dialogInput, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);
    dialog.remove();

    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const xtermTa = document.createElement('textarea');
    xtermTa.className = 'xterm-helper-textarea';
    xterm.appendChild(xtermTa);
    document.body.appendChild(xterm);
    expect(canHandleGlobalNavigationShortcut(xtermTa, xtermTa, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);
    xterm.remove();

    const remoteCanvas = document.createElement('canvas');
    remoteCanvas.setAttribute('data-remote-desktop-surface', 'true');
    document.body.appendChild(remoteCanvas);
    expect(canHandleGlobalNavigationShortcut(remoteCanvas, remoteCanvas, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);
    remoteCanvas.remove();

    const standaloneInput = document.createElement('input');
    document.body.appendChild(standaloneInput);
    expect(canHandleGlobalNavigationShortcut(standaloneInput, standaloneInput, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);
    standaloneInput.remove();

    expect(focusComposerElement(composer, { moveCaretToEnd: true })).toBe(true);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });
});
