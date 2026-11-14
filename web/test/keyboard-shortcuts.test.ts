/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  applyShortcutSlotOverride,
  canHandleGlobalNavigationShortcut,
  chordFromKeyboardEvent,
  cycleOrderedId,
  findShortcutConflicts,
  findShortcutSlotConflicts,
  focusComposerElement,
  formatShortcutKeycaps,
  getDefaultSecondaryShortcuts,
  getDefaultShortcuts,
  isMacPlatform,
  matchesShortcutChord,
  matchNavigationShortcutAction,
  matchNavigationShortcutBinding,
  normalizeShortcutChordString,
  parseShortcutChord,
  resolveFocusedKeyboardViewMode,
  resolveKeyboardShortcuts,
  resolveKeyboardShortcutSlots,
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
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
    });

    expect(getDefaultShortcuts(false)).toEqual({
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
    });

    expect(getDefaultSecondaryShortcuts(true)).toEqual({
      serverPrev: 'Ctrl+w',
      serverNext: 'Ctrl+s',
      tabPrev: 'Ctrl+a',
      tabNext: 'Ctrl+d',
    });

    expect(getDefaultSecondaryShortcuts(false)).toEqual({
      serverPrev: null,
      serverNext: null,
      tabPrev: null,
      tabNext: null,
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
    });
    expect(resolveKeyboardShortcuts({ tabPrev: 'Meta+ArrowLeft', tabNext: 'Meta+ArrowRight' }, true)).toEqual({
      serverPrev: 'Alt+i',
      serverNext: 'Alt+k',
      tabPrev: 'Meta+ArrowLeft',
      tabNext: 'Meta+ArrowRight',
    });
    expect(resolveKeyboardShortcuts(clean, false)).toEqual({
      serverPrev: 'Alt+ArrowUp',
      serverNext: null,
      tabPrev: 'Alt+j',
      tabNext: 'Alt+l',
    });

    // Dual-slot sanitization, legacy backward compatibility, and non-resurrecting clear semantics
    expect(resolveKeyboardShortcutSlots({ tabPrev: 'Meta+ArrowLeft' }, true)).toEqual({
      serverPrev: { primary: 'Alt+i', secondary: 'Ctrl+w' },
      serverNext: { primary: 'Alt+k', secondary: 'Ctrl+s' },
      tabPrev: { primary: 'Meta+ArrowLeft', secondary: 'Ctrl+a' },
      tabNext: { primary: 'Alt+l', secondary: 'Ctrl+d' },
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
    });
    expect(resolveKeyboardShortcutSlots({}, false)).toEqual({
      serverPrev: { primary: 'Alt+i', secondary: null },
      serverNext: { primary: 'Alt+k', secondary: null },
      tabPrev: { primary: 'Alt+j', secondary: null },
      tabNext: { primary: 'Alt+l', secondary: null },
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

    expect(findShortcutSlotConflicts({
      serverPrev: { primary: 'Alt+i', secondary: 'Ctrl+w' },
      serverNext: { primary: 'Alt+k', secondary: 'Ctrl+w' },
      tabPrev: { primary: 'Alt+j', secondary: 'Alt+j' },
      tabNext: { primary: 'Alt+l', secondary: null },
    })).toEqual({
      serverPrev: { secondary: [{ action: 'serverNext', slot: 'secondary' }] },
      serverNext: { secondary: [{ action: 'serverPrev', slot: 'secondary' }] },
      tabPrev: {
        primary: [{ action: 'tabPrev', slot: 'secondary' }],
        secondary: [{ action: 'tabPrev', slot: 'primary' }],
      },
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
});
