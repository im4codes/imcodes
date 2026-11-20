/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAC_VOICE_INLINE_MODIFIER,
  DEFAULT_TASK_PAIR_SPLIT_MODIFIERS,
  applyMacVoiceInlineModifier,
  applyShortcutSlotOverride,
  applySubSessionQuickModifiers,
  applyTaskPairSplitModifiers,
  areSubSessionQuickModifiersEqual,
  canHandleGlobalNavigationShortcut,
  canHandleOpenSettingsShortcut,
  canHandleReturnToMainWindowShortcut,
  canHandleToggleTaskModeShortcut,
  chordFromKeyboardEvent,
  cycleOrderedId,
  findShortcutConflicts,
  findShortcutSlotConflicts,
  focusComposerElement,
  formatShortcutKeycaps,
  formatShortcutModifierKeycaps,
  formatSubSessionQuickModifierKeycaps,
  getDefaultSecondaryShortcuts,
  getDefaultShortcuts,
  getDefaultSubSessionQuickModifiers,
  getDefaultTaskPairSplitModifiers,
  isMacPlatform,
  matchesOpenSettingsShortcut,
  matchesShortcutChord,
  matchNavigationShortcutAction,
  matchNavigationShortcutBinding,
  matchSubSessionQuickShortcut,
  matchTaskPairSplitQuickShortcut,
  normalizeShortcutChordString,
  parseShortcutChord,
  resolveFocusedKeyboardViewMode,
  resolveKeyboardShortcuts,
  resolveKeyboardShortcutSlots,
  resolveMacVoiceInlineModifier,
  resolveSubSessionQuickModifiers,
  resolveTaskPairSplitModifiers,
  sanitizeMacVoiceInlineModifier,
  sanitizeShortcutOverrides,
  sanitizeSubSessionQuickModifiers,
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
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    });

    expect(getDefaultShortcuts(false)).toEqual({
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    });

    expect(getDefaultSecondaryShortcuts(true)).toEqual({
      serverPrev: 'Ctrl+w',
      serverNext: 'Ctrl+s',
      tabPrev: 'Ctrl+a',
      tabNext: 'Ctrl+d',
      subSessionCloseAll: null,
      toggleTaskMode: null,
    });

    expect(getDefaultSecondaryShortcuts(false)).toEqual({
      serverPrev: null,
      serverNext: null,
      tabPrev: null,
      tabNext: null,
      subSessionCloseAll: null,
      toggleTaskMode: null,
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
    expect(normalizeShortcutChordString('ctrl+shift++')).toBe('Ctrl+Shift+Plus');
    expect(normalizeShortcutChordString('Ctrl+Shift+Plus')).toBe('Ctrl+Shift+Plus');
    expect(normalizeShortcutChordString('Shift+ArrowDown')).toBe('Shift+ArrowDown');
    expect(normalizeShortcutChordString('ArrowUp')).toBe('ArrowUp');
    expect(normalizeShortcutChordString('Shift+a')).toBeNull();
    expect(normalizeShortcutChordString('Ctrl+')).toBeNull();
    expect(normalizeShortcutChordString('Ctrl+++')).toBeNull();
    expect(normalizeShortcutChordString('Escape')).toBeNull();
    expect(normalizeShortcutChordString('')).toBeNull();

    expect(formatShortcutKeycaps('Ctrl+w', true)).toEqual(['⌃', 'W']);
    expect(formatShortcutKeycaps('Ctrl+s', true)).toEqual(['⌃', 'S']);
    expect(formatShortcutKeycaps('Ctrl+a', true)).toEqual(['⌃', 'A']);
    expect(formatShortcutKeycaps('Ctrl+d', true)).toEqual(['⌃', 'D']);
    expect(formatShortcutKeycaps('Ctrl+w', false)).toEqual(['Ctrl', 'W']);
    expect(formatShortcutKeycaps('Ctrl+s', false)).toEqual(['Ctrl', 'S']);
    expect(formatShortcutKeycaps('Ctrl+a', false)).toEqual(['Ctrl', 'A']);
    expect(formatShortcutKeycaps('Ctrl+d', false)).toEqual(['Ctrl', 'D']);
    expect(formatShortcutKeycaps('Alt+i', false)).toEqual(['Alt', 'I']);
    expect(formatShortcutKeycaps('Alt+k', false)).toEqual(['Alt', 'K']);
    expect(formatShortcutKeycaps('Alt+j', false)).toEqual(['Alt', 'J']);
    expect(formatShortcutKeycaps('Alt+l', false)).toEqual(['Alt', 'L']);
    expect(formatShortcutKeycaps('Alt+i', true)).toEqual(['⌥', 'I']);
    expect(formatShortcutKeycaps('Meta+ArrowUp', true)).toEqual(['⌘', '↑']);
    expect(formatShortcutKeycaps('Meta+Shift+ArrowLeft', true)).toEqual(['⇧', '⌘', '←']);
    expect(formatShortcutKeycaps('Meta+Shift+ArrowRight', true)).toEqual(['⇧', '⌘', '→']);
    expect(formatShortcutKeycaps('Ctrl+ArrowLeft', false)).toEqual(['Ctrl', '←']);
    expect(formatShortcutKeycaps('Ctrl+Alt+Shift+k', false)).toEqual(['Ctrl', 'Alt', 'Shift', 'K']);
    expect(formatShortcutKeycaps('Ctrl+Shift+Plus', false)).toEqual(['Ctrl', 'Shift', '+']);
    expect(formatShortcutKeycaps('Meta+Shift+Plus', true)).toEqual(['⇧', '⌘', '+']);
    expect(formatShortcutKeycaps('Shift+Home', false)).toEqual(['Shift', 'Home']);
  });

  it('merges user overrides and preserves null cleared bindings across platform defaults', () => {
    const clean = sanitizeShortcutOverrides({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'invalid+escape',
      tabNext: 'Shift+a',
      unknownAction: 'Ctrl+k',
    } as unknown);
    expect(clean).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
    });

    expect(resolveKeyboardShortcuts(clean, true)).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    });
    expect(resolveKeyboardShortcuts({ tabPrev: 'Meta+ArrowLeft', tabNext: 'Meta+ArrowRight' }, true)).toEqual({
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Meta+ArrowLeft',
      tabNext: 'Meta+ArrowRight',
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    });
    expect(resolveKeyboardShortcuts(clean, false)).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    });

    // Dual-slot sanitization, legacy backward compatibility, and non-resurrecting clear semantics
    expect(resolveKeyboardShortcutSlots({ tabPrev: 'Meta+ArrowLeft' }, true)).toEqual({
      serverPrev: { primary: 'Alt+i', secondary: 'Ctrl+w' },
      serverNext: { primary: 'Alt+k', secondary: 'Ctrl+s' },
      tabPrev: { primary: 'Meta+ArrowLeft', secondary: 'Ctrl+a' },
      tabNext: { primary: 'Alt+l', secondary: 'Ctrl+d' },
      subSessionCloseAll: { primary: 'Ctrl+0', secondary: null },
      toggleTaskMode: { primary: 'Ctrl+Shift+t', secondary: null },
    });

    const dirtyDual = sanitizeShortcutOverrides({
      tabPrev: 'Meta+ArrowLeft',
      secondary: {
        tabPrev: null,
        tabNext: 'control+arrowright',
        serverPrev: 'Shift+a',
        unknownAction: 'Ctrl+k',
      },
    } as unknown);
    expect(dirtyDual).toEqual({
      tabPrev: 'Meta+ArrowLeft',
      secondary: {
        tabPrev: null,
        tabNext: 'Ctrl+ArrowRight',
      },
    });
    expect(resolveKeyboardShortcutSlots(dirtyDual, true)).toEqual({
      serverPrev: { primary: 'Alt+i', secondary: 'Ctrl+w' },
      serverNext: { primary: 'Alt+k', secondary: 'Ctrl+s' },
      tabPrev: { primary: 'Meta+ArrowLeft', secondary: null },
      tabNext: { primary: 'Alt+l', secondary: 'Ctrl+ArrowRight' },
      subSessionCloseAll: { primary: 'Ctrl+0', secondary: null },
      toggleTaskMode: { primary: 'Ctrl+Shift+t', secondary: null },
    });
    expect(resolveKeyboardShortcutSlots({}, false)).toEqual({
      serverPrev: { primary: 'Alt+i', secondary: null },
      serverNext: { primary: 'Alt+k', secondary: null },
      tabPrev: { primary: 'Alt+j', secondary: null },
      tabNext: { primary: 'Alt+l', secondary: null },
      subSessionCloseAll: { primary: 'Ctrl+0', secondary: null },
      toggleTaskMode: { primary: 'Ctrl+Shift+t', secondary: null },
    });

    // applyShortcutSlotOverride persists explicit null for cleared non-null defaults and prunes redundant defaults
    const clearedMacSecondary = applyShortcutSlotOverride({}, 'tabPrev', 'secondary', null, true);
    expect(clearedMacSecondary).toEqual({ secondary: { tabPrev: null } });
    expect(resolveKeyboardShortcutSlots(clearedMacSecondary, true).tabPrev).toEqual({
      primary: 'Alt+j',
      secondary: null,
    });
    const restoredMacSecondary = applyShortcutSlotOverride(clearedMacSecondary, 'tabPrev', 'secondary', 'Ctrl+a', true);
    expect(restoredMacSecondary).toEqual({});

    const customWinSecondary = applyShortcutSlotOverride({}, 'tabPrev', 'secondary', 'Ctrl+ArrowLeft', false);
    expect(customWinSecondary).toEqual({ secondary: { tabPrev: 'Ctrl+ArrowLeft' } });
    expect(applyShortcutSlotOverride(customWinSecondary, 'tabPrev', 'secondary', null, false)).toEqual({});
  });

  it('captures valid chords (modifiers or non-typing nav/function keys) and rejects bare typing, Shift+letter, modifiers, Escape, and IME', () => {
    expect(chordFromKeyboardEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Control', code: 'ControlLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Escape', code: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Escape', code: 'Escape', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'a', code: 'KeyA', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'A', code: 'KeyA', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(chordFromKeyboardEvent({ key: '+', code: 'Equal', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(chordFromKeyboardEvent({ key: ' ', code: 'Space', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Enter', code: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'Tab', code: 'Tab', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(chordFromKeyboardEvent({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, isComposing: true })).toBeNull();

    // Non-typing navigation & function keys (with or without Shift) are allowed
    expect(chordFromKeyboardEvent({ key: 'ArrowUp', code: 'ArrowUp', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('ArrowUp');
    expect(chordFromKeyboardEvent({ key: 'Home', code: 'Home', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('Home');
    expect(chordFromKeyboardEvent({ key: 'PageDown', code: 'PageDown', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Shift+PageDown');
    expect(chordFromKeyboardEvent({ key: 'F6', code: 'F6', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe('F6');

    expect(chordFromKeyboardEvent({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe('Meta+ArrowUp');
    expect(chordFromKeyboardEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Meta+Shift+ArrowLeft');
    expect(chordFromKeyboardEvent({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe('Meta+Shift+ArrowRight');
    expect(chordFromKeyboardEvent({ key: 'ArrowRight', code: 'ArrowRight', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe('Ctrl+Shift+ArrowRight');
    expect(chordFromKeyboardEvent({ key: '˚', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Alt+k');
    // Dead-key Option/Alt+letter (e.g. macOS Option+i -> Dead with code KeyI) still recovers physical letter
    expect(chordFromKeyboardEvent({ key: 'Dead', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Alt+i');
    // Bare dead key without Alt stays ignored
    expect(chordFromKeyboardEvent({ key: 'Dead', code: 'BracketLeft', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
    // Uppercase/IME glyph under Alt+key on non-Mac still normalizes cleanly via physical code
    expect(chordFromKeyboardEvent({ key: 'I', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Alt+i');
    expect(chordFromKeyboardEvent({ key: 'ш', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })).toBe('Alt+i');

    // Plus separator key round-trips cleanly across capture -> sanitize -> JSON storage -> match
    const plusEvt = { key: '+', code: 'Equal', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true };
    const capturedPlus = chordFromKeyboardEvent(plusEvt);
    expect(capturedPlus).toBe('Ctrl+Shift+Plus');
    const persisted = JSON.parse(JSON.stringify(sanitizeShortcutOverrides({ tabNext: capturedPlus })));
    expect(persisted.tabNext).toBe('Ctrl+Shift+Plus');
    expect(matchesShortcutChord(plusEvt, persisted.tabNext)).toBe(true);
    expect(matchesShortcutChord({ key: '=', code: 'Equal', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, persisted.tabNext)).toBe(false);

    const metaPlusEvt = { key: '+', code: 'NumpadAdd', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    const capturedMetaPlus = chordFromKeyboardEvent(metaPlusEvt);
    expect(capturedMetaPlus).toBe('Meta+Plus');
    expect(sanitizeShortcutOverrides({ tabPrev: capturedMetaPlus }).tabPrev).toBe('Meta+Plus');
    expect(matchesShortcutChord(metaPlusEvt, 'Meta+Plus')).toBe(true);
  });

  it('matches exact modifier combinations and detects conflicts', () => {
    const macShortcuts = getDefaultShortcuts(true);
    const nonMacShortcuts = getDefaultShortcuts(false);
    expect(macShortcuts).toEqual(nonMacShortcuts);
    // macOS unified defaults match Alt+i/k/j/l (including Option dead-key/glyph events) and do NOT intercept Ctrl+w/s/a/d
    expect(matchNavigationShortcutAction(
      { key: 'Dead', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macShortcuts,
    )).toBe('serverPrev');
    expect(matchNavigationShortcutAction(
      { key: '˚', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macShortcuts,
    )).toBe('serverNext');
    expect(matchNavigationShortcutAction(
      { key: '∆', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macShortcuts,
    )).toBe('tabPrev');
    expect(matchNavigationShortcutAction(
      { key: '¬', code: 'KeyL', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macShortcuts,
    )).toBe('tabNext');
    expect(matchNavigationShortcutAction(
      { key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 's', code: 'KeyS', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'd', code: 'KeyD', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBeNull();

    // Non-macOS (Windows/Linux) defaults match Alt+i/k/j/l and do NOT intercept Ctrl+w/s/a/d
    expect(matchNavigationShortcutAction(
      { key: 'i', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      nonMacShortcuts,
    )).toBe('serverPrev');
    expect(matchNavigationShortcutAction(
      { key: 'k', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      nonMacShortcuts,
    )).toBe('serverNext');
    expect(matchNavigationShortcutAction(
      { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      nonMacShortcuts,
    )).toBe('tabPrev');
    expect(matchNavigationShortcutAction(
      { key: 'l', code: 'KeyL', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      nonMacShortcuts,
    )).toBe('tabNext');
    expect(matchNavigationShortcutAction(
      { key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      nonMacShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 's', code: 'KeyS', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      nonMacShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      nonMacShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'd', code: 'KeyD', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      nonMacShortcuts,
    )).toBeNull();

    // Explicit user overrides to Ctrl+w/Ctrl+a still match when configured on macOS or non-Mac
    const macWithCtrlA = resolveKeyboardShortcuts({ tabPrev: 'Ctrl+a' }, true);
    expect(matchNavigationShortcutAction(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macWithCtrlA,
    )).toBe('tabPrev');
    const nonMacWithCtrlW = resolveKeyboardShortcuts({ serverPrev: 'Ctrl+w' }, false);
    expect(matchNavigationShortcutAction(
      { key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      nonMacWithCtrlW,
    )).toBe('serverPrev');

    expect(matchNavigationShortcutAction(
      { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      macShortcuts,
    )).toBeNull();
    expect(matchNavigationShortcutAction(
      { key: 'i', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
      nonMacShortcuts,
    )).toBeNull();
    expect(matchesShortcutChord(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      'Ctrl+a',
    )).toBe(true);
    expect(matchesShortcutChord(
      { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      'Ctrl+ArrowLeft',
    )).toBe(true);

    expect(findShortcutConflicts({
      serverPrev: 'Ctrl+ArrowUp',
      serverNext: 'Ctrl+ArrowDown',
      tabPrev: 'Ctrl+ArrowUp',
      tabNext: null,
      subSessionCloseAll: 'Ctrl+0',
      toggleTaskMode: 'Ctrl+Shift+t',
    })).toEqual({
      serverPrev: ['tabPrev'],
      tabPrev: ['serverPrev'],
    });

    // Dual-slot matching & 8-slot conflict detection
    const macSlots = resolveKeyboardShortcutSlots({}, true);
    expect(matchNavigationShortcutBinding(
      { key: 'Dead', code: 'KeyI', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macSlots,
    )).toEqual({ action: 'serverPrev', slot: 'primary', chord: 'Alt+i' });
    expect(matchNavigationShortcutBinding(
      { key: 'w', code: 'KeyW', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macSlots,
    )).toEqual({ action: 'serverPrev', slot: 'secondary', chord: 'Ctrl+w' });
    expect(matchNavigationShortcutBinding(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macSlots,
    )).toEqual({ action: 'tabPrev', slot: 'secondary', chord: 'Ctrl+a' });

    const macClearedTabPrevSecondary = resolveKeyboardShortcutSlots({ secondary: { tabPrev: null } }, true);
    expect(matchNavigationShortcutBinding(
      { key: 'a', code: 'KeyA', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macClearedTabPrevSecondary,
    )).toBeNull();
    expect(matchNavigationShortcutBinding(
      { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      macClearedTabPrevSecondary,
    )).toEqual({ action: 'tabPrev', slot: 'primary', chord: 'Alt+j' });

    const winPrimaryClearedSecondaryBound = resolveKeyboardShortcutSlots(
      { tabPrev: null, secondary: { tabPrev: 'Ctrl+ArrowLeft' } },
      false,
    );
    expect(matchNavigationShortcutBinding(
      { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      winPrimaryClearedSecondaryBound,
    )).toBeNull();
    expect(matchNavigationShortcutBinding(
      { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      winPrimaryClearedSecondaryBound,
    )).toEqual({ action: 'tabPrev', slot: 'secondary', chord: 'Ctrl+ArrowLeft' });

    expect(matchNavigationShortcutBinding(
      { key: '0', code: 'Digit0', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      macSlots,
    )).toEqual({ action: 'subSessionCloseAll', slot: 'primary', chord: 'Ctrl+0' });

    const customCloseAllSlots = resolveKeyboardShortcutSlots({ subSessionCloseAll: 'Alt+Shift+x' }, false);
    expect(matchNavigationShortcutBinding(
      { key: '0', code: 'Digit0', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
      customCloseAllSlots,
    )).toBeNull();
    expect(matchNavigationShortcutBinding(
      { key: 'X', code: 'KeyX', metaKey: false, ctrlKey: false, altKey: true, shiftKey: true },
      customCloseAllSlots,
    )).toEqual({ action: 'subSessionCloseAll', slot: 'primary', chord: 'Alt+Shift+x' });

    expect(findShortcutSlotConflicts({
      serverPrev: { primary: 'Alt+i', secondary: 'Ctrl+w' },
      serverNext: { primary: 'Alt+k', secondary: 'Ctrl+w' },
      tabPrev: { primary: 'Alt+j', secondary: 'Alt+j' },
      tabNext: { primary: 'Alt+l', secondary: null },
      subSessionCloseAll: { primary: 'Ctrl+0', secondary: 'Alt+l' },
      toggleTaskMode: { primary: 'Ctrl+Shift+t', secondary: null },
    })).toEqual({
      serverPrev: { secondary: [{ action: 'serverNext', slot: 'secondary' }] },
      serverNext: { secondary: [{ action: 'serverPrev', slot: 'secondary' }] },
      tabPrev: {
        primary: [{ action: 'tabPrev', slot: 'secondary' }],
        secondary: [{ action: 'tabPrev', slot: 'primary' }],
      },
      tabNext: { primary: [{ action: 'subSessionCloseAll', slot: 'secondary' }] },
      subSessionCloseAll: { secondary: [{ action: 'tabNext', slot: 'primary' }] },
    });

    // toggleTaskMode default Ctrl+Shift+T matches both uppercase 'T' and lowercase 't' on Mac and non-Mac,
    // and supports custom recorded overrides
    expect(formatShortcutKeycaps('Ctrl+Shift+t', true)).toEqual(['⌃', '⇧', 'T']);
    expect(formatShortcutKeycaps('Ctrl+Shift+t', false)).toEqual(['Ctrl', 'Shift', 'T']);
    for (const slots of [macSlots, resolveKeyboardShortcutSlots({}, false)]) {
      expect(matchNavigationShortcutBinding(
        { key: 'T', code: 'KeyT', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        slots,
      )).toEqual({ action: 'toggleTaskMode', slot: 'primary', chord: 'Ctrl+Shift+t' });
      expect(matchNavigationShortcutBinding(
        { key: 't', code: 'KeyT', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        slots,
      )).toEqual({ action: 'toggleTaskMode', slot: 'primary', chord: 'Ctrl+Shift+t' });
    }
    const customTaskModeSlots = resolveKeyboardShortcutSlots({ toggleTaskMode: 'Alt+t', secondary: { toggleTaskMode: 'Meta+Shift+k' } }, true);
    expect(matchNavigationShortcutBinding(
      { key: 'T', code: 'KeyT', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      customTaskModeSlots,
    )).toBeNull();
    expect(matchNavigationShortcutBinding(
      { key: '†', code: 'KeyT', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false },
      customTaskModeSlots,
    )).toEqual({ action: 'toggleTaskMode', slot: 'primary', chord: 'Alt+t' });
    expect(matchNavigationShortcutBinding(
      { key: 'K', code: 'KeyK', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      customTaskModeSlots,
    )).toEqual({ action: 'toggleTaskMode', slot: 'secondary', chord: 'Meta+Shift+k' });
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
    expect(cycleOrderedId(ids, 's4', 2)).toBe('s1');
    expect(cycleOrderedId(ids, 's4', 3)).toBe('s2');
    expect(cycleOrderedId(ids, 's4', -2)).toBe('s1');
    expect(cycleOrderedId(ids, 's4', -3)).toBe('s3');
    expect(cycleOrderedId(ids, 's4', 0)).toBeNull();
    expect(cycleOrderedId(ids, 'missing', 1)).toBe('s4');
    expect(cycleOrderedId(ids, 'missing', 3)).toBe('s1');
    expect(cycleOrderedId(ids, 'missing', -1)).toBe('s2');
    expect(cycleOrderedId(ids, 'missing', -2)).toBe('s1');
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

  it('allows return-to-main-window shortcut in remote desktop, fullscreen, xterm, and panel editors, while blocking mobile, IME, and shortcut recording', () => {
    const remotePanel = document.createElement('div');
    remotePanel.className = 'remote-desktop-panel';
    const remoteCanvas = document.createElement('canvas');
    remoteCanvas.className = 'remote-desktop-canvas';
    remoteCanvas.setAttribute('data-remote-desktop-surface', 'true');
    remoteCanvas.tabIndex = 0;
    remotePanel.appendChild(remoteCanvas);
    document.body.appendChild(remotePanel);
    remoteCanvas.focus();

    expect(canHandleReturnToMainWindowShortcut(remoteCanvas, remoteCanvas, { isMobile: false })).toBe(true);

    // Browser fullscreen on Remote Desktop panel remains allowed
    const origFs = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: remotePanel });
    try {
      expect(canHandleReturnToMainWindowShortcut(remoteCanvas, remoteCanvas, { isMobile: false })).toBe(true);
    } finally {
      if (origFs) Object.defineProperty(document, 'fullscreenElement', origFs);
      else delete (document as { fullscreenElement?: Element | null }).fullscreenElement;
    }
    remotePanel.remove();

    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const xtermTa = document.createElement('textarea');
    xtermTa.className = 'xterm-helper-textarea';
    xterm.appendChild(xtermTa);
    document.body.appendChild(xterm);
    xtermTa.focus();
    expect(canHandleReturnToMainWindowShortcut(xtermTa, xtermTa, { isMobile: false })).toBe(true);
    xterm.remove();

    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const input = document.createElement('input');
    editor.appendChild(input);
    document.body.appendChild(editor);
    input.focus();
    expect(canHandleReturnToMainWindowShortcut(input, input, { isMobile: false })).toBe(true);
    editor.remove();

    // Blocked on mobile, IME composition, and active shortcut recording
    expect(canHandleReturnToMainWindowShortcut(document.body, document.body, { isMobile: true })).toBe(false);
    expect(canHandleReturnToMainWindowShortcut(document.body, document.body, { isMobile: false, isComposing: true })).toBe(false);

    const recorder = document.createElement('button');
    recorder.setAttribute('data-shortcut-recording', 'true');
    document.body.appendChild(recorder);
    expect(canHandleReturnToMainWindowShortcut(recorder, recorder, { isMobile: false })).toBe(false);
    recorder.remove();
  });

  it('authoritatively resolves terminal vs chat view mode for focused sub-sessions without falling back to main chat', () => {
    const subWin = document.createElement('div');
    subWin.className = 'subsession-window subsession-window-active';
    subWin.setAttribute('data-subsession-id', 'sub-1');
    subWin.setAttribute('data-view-mode', 'terminal');
    const modeBtn = document.createElement('button');
    const subComposer = document.createElement('div');
    subWin.appendChild(modeBtn);
    subWin.appendChild(subComposer);
    document.body.appendChild(subWin);

    const inputRefs = new Map<string, Element>([['deck_sub_sub-1', subComposer]]);

    // Focus inside subwindow chrome (header mode button) -> terminal
    expect(resolveFocusedKeyboardViewMode({
      target: modeBtn,
      activeElement: modeBtn,
      focusedSubId: 'sub-1',
      isFocusedSubOpen: true,
      inputRefs,
      fallbackMainViewMode: 'chat',
      doc: document,
    })).toBe('terminal');

    // Focus on document.body while terminal subwindow is active -> still terminal via inputRefs/DOM
    expect(resolveFocusedKeyboardViewMode({
      target: document.body,
      activeElement: document.body,
      focusedSubId: 'sub-1',
      isFocusedSubOpen: true,
      inputRefs,
      fallbackMainViewMode: 'chat',
      doc: document,
    })).toBe('terminal');

    // Missing inputRef while subwindow is open in terminal -> DOM attribute / fail-closed still resolves terminal
    expect(resolveFocusedKeyboardViewMode({
      target: document.body,
      activeElement: document.body,
      focusedSubId: 'sub-1',
      isFocusedSubOpen: true,
      inputRefs: new Map(),
      fallbackMainViewMode: 'chat',
      doc: document,
    })).toBe('terminal');

    // Toggling subwindow to chat -> resolves chat even if main session is terminal
    subWin.setAttribute('data-view-mode', 'chat');
    expect(resolveFocusedKeyboardViewMode({
      target: subComposer,
      activeElement: subComposer,
      focusedSubId: 'sub-1',
      isFocusedSubOpen: true,
      inputRefs,
      fallbackMainViewMode: 'terminal',
      doc: document,
    })).toBe('chat');

    // Once subwindow closes -> falls back cleanly to main view mode
    expect(resolveFocusedKeyboardViewMode({
      target: document.body,
      activeElement: document.body,
      focusedSubId: 'sub-1',
      isFocusedSubOpen: false,
      inputRefs,
      fallbackMainViewMode: 'chat',
      doc: document,
    })).toBe('chat');

    subWin.remove();
  });

  it('sanitizes, formats, applies, and matches configurable sub-session quick modifiers (0..9)', () => {
    expect(getDefaultSubSessionQuickModifiers()).toEqual(['ctrl']);
    expect(resolveSubSessionQuickModifiers(undefined)).toEqual(['ctrl']);
    expect(resolveSubSessionQuickModifiers({ subSessionQuickModifiers: [] })).toEqual(['ctrl']);

    expect(sanitizeSubSessionQuickModifiers(['shift', 'control', 'CMD', 'alt', 'ctrl'])).toEqual([
      'ctrl',
      'alt',
      'shift',
      'meta',
    ]);
    expect(sanitizeSubSessionQuickModifiers(['invalid'])).toBeUndefined();
    expect(sanitizeSubSessionQuickModifiers('ctrl')).toBeUndefined();

    expect(sanitizeShortcutOverrides({
      tabNext: 'Alt+ArrowRight',
      subSessionQuickModifiers: ['alt', 'ctrl'],
    })).toEqual({
      tabNext: 'Alt+ArrowRight',
      subSessionQuickModifiers: ['ctrl', 'alt'],
    });
    expect(sanitizeShortcutOverrides({
      subSessionQuickModifiers: ['bogus' as never],
    })).toEqual({});

    const withCombo = applySubSessionQuickModifiers({}, ['shift', 'ctrl']);
    expect(withCombo).toEqual({ subSessionQuickModifiers: ['ctrl', 'shift'] });
    expect(resolveSubSessionQuickModifiers(withCombo)).toEqual(['ctrl', 'shift']);
    expect(areSubSessionQuickModifiersEqual(['ctrl', 'shift'], ['shift', 'ctrl'])).toBe(true);

    const resetBack = applySubSessionQuickModifiers(withCombo, ['ctrl']);
    expect(resetBack).toEqual({});
    expect(applySubSessionQuickModifiers(withCombo, [])).toEqual({});

    expect(formatSubSessionQuickModifierKeycaps(['ctrl'], false)).toEqual(['Ctrl']);
    expect(formatSubSessionQuickModifierKeycaps(['ctrl', 'alt', 'shift', 'meta'], false)).toEqual([
      'Ctrl',
      'Alt',
      'Shift',
      'Win',
    ]);
    expect(formatSubSessionQuickModifierKeycaps(['ctrl', 'alt', 'shift', 'meta'], true)).toEqual([
      '⌃',
      '⌥',
      '⇧',
      '⌘',
    ]);

    // Default Ctrl + 1..9 / 0
    expect(matchSubSessionQuickShortcut({
      key: '1',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }, ['ctrl'])).toEqual({ kind: 'open', index: 0 });
    expect(matchSubSessionQuickShortcut({
      key: '9',
      code: 'Numpad9',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }, ['ctrl'])).toEqual({ kind: 'open', index: 8 });
    // 0 is no longer hardcoded in matchSubSessionQuickShortcut; it is a normal configurable ShortcutActionId (subSessionCloseAll)
    expect(matchSubSessionQuickShortcut({
      key: '0',
      code: 'Digit0',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }, ['ctrl'])).toBeNull();

    // Exact modifier match: Ctrl+Shift+Digit1 must NOT fire when configured modifier is ['ctrl']
    expect(matchSubSessionQuickShortcut({
      key: '!',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, ['ctrl'])).toBeNull();

    // When configured modifier is ['ctrl', 'shift'], e.code Digit1 matches even with e.key === '!'
    expect(matchSubSessionQuickShortcut({
      key: '!',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, ['ctrl', 'shift'])).toEqual({ kind: 'open', index: 0 });

    // 0 remains ignored by matchSubSessionQuickShortcut regardless of modifier combo
    expect(matchSubSessionQuickShortcut({
      key: '0',
      code: 'Numpad0',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    }, ['ctrl', 'alt'])).toBeNull();

    // IME composing is ignored
    expect(matchSubSessionQuickShortcut({
      key: '1',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: true,
    }, ['ctrl'])).toBeNull();
  });

  it('sanitizes, resolves, and applies Mac inline voice double-tap modifier overrides', () => {
    expect(DEFAULT_MAC_VOICE_INLINE_MODIFIER).toBe('ctrl');
    expect(resolveMacVoiceInlineModifier(undefined)).toBe('ctrl');
    expect(resolveMacVoiceInlineModifier({})).toBe('ctrl');

    expect(sanitizeMacVoiceInlineModifier('ctrl')).toBe('ctrl');
    expect(sanitizeMacVoiceInlineModifier('Option')).toBe('alt');
    expect(sanitizeMacVoiceInlineModifier('cmd')).toBe('meta');
    expect(sanitizeMacVoiceInlineModifier('Shift')).toBe('shift');
    expect(sanitizeMacVoiceInlineModifier(null)).toBeNull();
    expect(sanitizeMacVoiceInlineModifier('off')).toBeNull();
    expect(sanitizeMacVoiceInlineModifier('invalid-key')).toBeUndefined();

    expect(sanitizeShortcutOverrides({ macVoiceInlineModifier: 'meta' })).toEqual({
      macVoiceInlineModifier: 'meta',
    });
    expect(sanitizeShortcutOverrides({ macVoiceInlineModifier: null })).toEqual({
      macVoiceInlineModifier: null,
    });
    expect(sanitizeShortcutOverrides({ macVoiceInlineModifier: 'bogus' })).toEqual({});

    expect(resolveMacVoiceInlineModifier({ macVoiceInlineModifier: 'alt' })).toBe('alt');
    expect(resolveMacVoiceInlineModifier({ macVoiceInlineModifier: null })).toBeNull();

    const withShift = applyMacVoiceInlineModifier({}, 'shift');
    expect(withShift).toEqual({ macVoiceInlineModifier: 'shift' });
    const withDisabled = applyMacVoiceInlineModifier(withShift, null);
    expect(withDisabled).toEqual({ macVoiceInlineModifier: null });
    const resetDefault = applyMacVoiceInlineModifier(withDisabled, 'ctrl');
    expect(resetDefault).toEqual({});
  });

  it('defaults taskPairSplitModifiers to Ctrl+Shift, sanitizes overrides, and matches Shift-shifted Digit1..9', () => {
    expect(DEFAULT_TASK_PAIR_SPLIT_MODIFIERS).toEqual(['ctrl', 'shift']);
    expect(getDefaultTaskPairSplitModifiers()).toEqual(['ctrl', 'shift']);
    expect(resolveTaskPairSplitModifiers(undefined)).toEqual(['ctrl', 'shift']);
    expect(resolveTaskPairSplitModifiers({ taskPairSplitModifiers: [] })).toEqual(['ctrl', 'shift']);

    expect(sanitizeShortcutOverrides({ taskPairSplitModifiers: ['shift', 'ctrl'] })).toEqual({
      taskPairSplitModifiers: ['ctrl', 'shift'],
    });
    expect(applyTaskPairSplitModifiers({}, ['alt', 'shift'])).toEqual({
      taskPairSplitModifiers: ['alt', 'shift'],
    });
    expect(applyTaskPairSplitModifiers({ taskPairSplitModifiers: ['alt', 'shift'] }, ['shift', 'ctrl'])).toEqual({});

    expect(formatShortcutModifierKeycaps(['ctrl', 'shift'], true, DEFAULT_TASK_PAIR_SPLIT_MODIFIERS)).toEqual(['⌃', '⇧']);
    expect(formatShortcutModifierKeycaps(['ctrl', 'shift'], false, DEFAULT_TASK_PAIR_SPLIT_MODIFIERS)).toEqual(['Ctrl', 'Shift']);

    // Shift + Digit1 emits e.key === '!' while e.code === 'Digit1'
    expect(matchTaskPairSplitQuickShortcut({
      key: '!',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, ['ctrl', 'shift'])).toEqual({ kind: 'toggleSplit', index: 0 });
    expect(matchTaskPairSplitQuickShortcut({
      key: '9',
      code: 'Numpad9',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, ['ctrl', 'shift'])).toEqual({ kind: 'toggleSplit', index: 8 });
    // Plain Ctrl+1 does NOT match default task-pair split shortcut
    expect(matchTaskPairSplitQuickShortcut({
      key: '1',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }, ['ctrl', 'shift'])).toBeNull();
    // Ctrl+Shift+0 and IME composing are ignored
    expect(matchTaskPairSplitQuickShortcut({
      key: ')',
      code: 'Digit0',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    }, ['ctrl', 'shift'])).toBeNull();
    expect(matchTaskPairSplitQuickShortcut({
      key: '!',
      code: 'Digit1',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      isComposing: true,
    }, ['ctrl', 'shift'])).toBeNull();
  });

  it('allows non-text input controls and non-modal aria-modal="false" dialogs while blocking text inputs and modals', () => {
    const panel = document.createElement('div');
    panel.className = 'floating-panel';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const radio = document.createElement('input');
    radio.type = 'radio';
    const btnInput = document.createElement('input');
    btnInput.type = 'button';
    const rangeInput = document.createElement('input');
    rangeInput.type = 'range';

    const textInput = document.createElement('input');
    textInput.type = 'text';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    const defaultInput = document.createElement('input');
    const selectEl = document.createElement('select');
    const textareaEl = document.createElement('textarea');

    panel.append(checkbox, radio, btnInput, rangeInput, textInput, searchInput, defaultInput, selectEl, textareaEl);
    document.body.appendChild(panel);

    for (const nonText of [checkbox, radio, btnInput, rangeInput]) {
      nonText.focus();
      expect(canHandleGlobalNavigationShortcut(nonText, nonText, {
        hasBlockingOverlay: false,
        isMobile: false,
        viewMode: 'chat',
      })).toBe(true);
    }

    for (const textCtrl of [textInput, searchInput, defaultInput, selectEl, textareaEl]) {
      textCtrl.focus();
      expect(canHandleGlobalNavigationShortcut(textCtrl, textCtrl, {
        hasBlockingOverlay: false,
        isMobile: false,
        viewMode: 'chat',
      })).toBe(false);
    }

    const miniChatFloat = document.createElement('div');
    miniChatFloat.className = 'cloud-docs-mini-chat';
    miniChatFloat.setAttribute('role', 'dialog');
    miniChatFloat.setAttribute('aria-modal', 'false');
    const floatBtn = document.createElement('button');
    miniChatFloat.appendChild(floatBtn);
    panel.appendChild(miniChatFloat);
    floatBtn.focus();
    expect(canHandleGlobalNavigationShortcut(floatBtn, floatBtn, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(true);

    const realModal = document.createElement('div');
    realModal.setAttribute('role', 'dialog');
    realModal.setAttribute('aria-modal', 'true');
    document.body.appendChild(realModal);
    expect(canHandleGlobalNavigationShortcut(floatBtn, floatBtn, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);

    realModal.remove();
    panel.remove();
  });

  it('resolves non-terminal .floating-panel focus to chat even with an open shell sub-session or terminal main mode, while keeping terminal/RD surfaces terminal', () => {
    const floatingPanel = document.createElement('div');
    floatingPanel.className = 'floating-panel';
    const fbButton = document.createElement('button');
    const fbCheckbox = document.createElement('input');
    fbCheckbox.type = 'checkbox';
    floatingPanel.append(fbButton, fbCheckbox);

    const rdPanel = document.createElement('div');
    rdPanel.className = 'remote-desktop-panel';
    const rdBtn = document.createElement('button');
    rdPanel.appendChild(rdBtn);
    floatingPanel.appendChild(rdPanel);

    const xtermWrap = document.createElement('div');
    xtermWrap.className = 'xterm';
    const xtermTa = document.createElement('textarea');
    xtermTa.className = 'xterm-helper-textarea';
    xtermWrap.appendChild(xtermTa);
    floatingPanel.appendChild(xtermWrap);

    const subWin = document.createElement('div');
    subWin.className = 'subsession-window subsession-window-active';
    subWin.setAttribute('data-subsession-id', 'sub-shell');
    subWin.setAttribute('data-view-mode', 'terminal');
    const subBtn = document.createElement('button');
    subWin.appendChild(subBtn);

    document.body.append(floatingPanel, subWin);

    for (const el of [fbButton, fbCheckbox]) {
      el.focus();
      expect(resolveFocusedKeyboardViewMode({
        target: el,
        activeElement: el,
        focusedSubId: 'sub-shell',
        isFocusedSubOpen: true,
        focusedSubType: 'shell',
        focusedSubSessionName: 'deck_sub_shell',
        inputRefs: new Map(),
        fallbackMainViewMode: 'terminal',
        doc: document,
      })).toBe('chat');
    }

    // Focus inside .subsession-window[data-view-mode="terminal"] stays 'terminal'
    subBtn.focus();
    expect(resolveFocusedKeyboardViewMode({
      target: subBtn,
      activeElement: subBtn,
      focusedSubId: 'sub-shell',
      isFocusedSubOpen: true,
      focusedSubType: 'shell',
      focusedSubSessionName: 'deck_sub_shell',
      inputRefs: new Map(),
      fallbackMainViewMode: 'chat',
      doc: document,
    })).toBe('terminal');

    // Focus inside .remote-desktop-panel or .xterm inside .floating-panel must NOT be promoted to 'chat'
    rdBtn.focus();
    expect(resolveFocusedKeyboardViewMode({
      target: rdBtn,
      activeElement: rdBtn,
      focusedSubId: null,
      isFocusedSubOpen: false,
      inputRefs: new Map(),
      fallbackMainViewMode: 'terminal',
      doc: document,
    })).toBe('terminal');
    expect(canHandleGlobalNavigationShortcut(rdBtn, rdBtn, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);

    xtermTa.focus();
    expect(resolveFocusedKeyboardViewMode({
      target: xtermTa,
      activeElement: xtermTa,
      focusedSubId: null,
      isFocusedSubOpen: false,
      inputRefs: new Map(),
      fallbackMainViewMode: 'terminal',
      doc: document,
    })).toBe('terminal');
    expect(canHandleGlobalNavigationShortcut(xtermTa, xtermTa, {
      hasBlockingOverlay: false,
      isMobile: false,
      viewMode: 'chat',
    })).toBe(false);

    floatingPanel.remove();
    subWin.remove();
  });

  it('matches Cmd+, on macOS and Ctrl+, on non-macOS while rejecting IME and shortcut recording', () => {
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(true);
    expect(matchesOpenSettingsShortcut({ key: 'Process', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(true);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, true)).toBe(false);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, false)).toBe(true);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, false)).toBe(false);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, true)).toBe(false);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, true)).toBe(false);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: true }, true)).toBe(false);
    expect(matchesOpenSettingsShortcut({ key: ',', code: 'Comma', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, keyCode: 229 }, true)).toBe(false);

    const composer = document.createElement('div');
    composer.className = 'controls-input';
    document.body.appendChild(composer);
    const xterm = document.createElement('textarea');
    xterm.className = 'xterm-helper-textarea';
    document.body.appendChild(xterm);
    expect(canHandleOpenSettingsShortcut(composer, composer)).toBe(true);
    expect(canHandleOpenSettingsShortcut(xterm, xterm)).toBe(true);
    expect(canHandleOpenSettingsShortcut(composer, composer, { isComposing: true })).toBe(false);

    const recorder = document.createElement('button');
    recorder.setAttribute('data-shortcut-recording', 'true');
    document.body.appendChild(recorder);
    expect(canHandleOpenSettingsShortcut(recorder, recorder)).toBe(false);
    expect(canHandleOpenSettingsShortcut(composer, composer)).toBe(false);

    composer.remove();
    xterm.remove();
    recorder.remove();
  });

  it('allows toggleTaskMode in Workspace, composer, terminals, and Task Mode while blocking mobile, IME, shortcut recording, and modal dialogs', () => {
    const composer = document.createElement('div');
    composer.className = 'controls-input';
    composer.contentEditable = 'true';
    document.body.appendChild(composer);
    composer.focus();

    expect(canHandleToggleTaskModeShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
    })).toBe(true);

    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const xtermTa = document.createElement('textarea');
    xtermTa.className = 'xterm-helper-textarea';
    xterm.appendChild(xtermTa);
    document.body.appendChild(xterm);
    xtermTa.focus();
    expect(canHandleToggleTaskModeShortcut(xtermTa, xtermTa, {
      hasBlockingOverlay: false,
      isMobile: false,
    })).toBe(true);
    xterm.remove();

    expect(canHandleToggleTaskModeShortcut(document.body, document.body, {
      hasBlockingOverlay: false,
      isMobile: true,
    })).toBe(false);
    expect(canHandleToggleTaskModeShortcut(composer, composer, {
      hasBlockingOverlay: false,
      isMobile: false,
      isComposing: true,
    })).toBe(false);
    expect(canHandleToggleTaskModeShortcut(composer, composer, {
      hasBlockingOverlay: true,
      isMobile: false,
    })).toBe(false);

    const recorder = document.createElement('button');
    recorder.setAttribute('data-shortcut-recording', 'true');
    document.body.appendChild(recorder);
    expect(canHandleToggleTaskModeShortcut(recorder, recorder, {
      hasBlockingOverlay: false,
      isMobile: false,
    })).toBe(false);
    recorder.remove();

    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const modalInput = document.createElement('input');
    modal.appendChild(modalInput);
    document.body.appendChild(modal);
    modalInput.focus();
    expect(canHandleToggleTaskModeShortcut(modalInput, modalInput, {
      hasBlockingOverlay: false,
      isMobile: false,
    })).toBe(false);
    modal.remove();

    composer.remove();
  });
});
