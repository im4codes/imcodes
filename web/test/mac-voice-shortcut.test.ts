/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_TAP_MODIFIER_WINDOW_MS,
  MAX_MODIFIER_TAP_HOLD_MS,
  NATIVE_MODIFIER_PRESS_EVENT,
  createDoubleTapModifierDetector,
  installMacVoiceShortcutListener,
} from '../src/mac-voice-shortcut.js';
import type { MacVoiceInlineModifier } from '../src/keyboard-shortcuts.js';

function modEvent(
  key: 'Control' | 'Alt' | 'Shift' | 'Meta',
  code: string,
  extra: Partial<KeyboardEvent> = {},
) {
  return {
    key,
    code,
    ctrlKey: extra.ctrlKey ?? (key === 'Control'),
    altKey: extra.altKey ?? (key === 'Alt'),
    shiftKey: extra.shiftKey ?? (key === 'Shift'),
    metaKey: extra.metaKey ?? (key === 'Meta'),
    repeat: extra.repeat ?? false,
    isComposing: extra.isComposing ?? false,
  };
}

describe('mac-voice-shortcut double-tap modifier detector', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('triggers on clean double-tap of Ctrl within window when enabled', () => {
    let now = 1000;
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => 'ctrl',
      isEnabled: () => true,
      now: () => now,
      onDoubleTap,
    });

    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 40;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    now += 150;
    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 40;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('never fires when disabled (non-Mac browsers / phones) or target modifier is null', () => {
    let now = 1000;
    let enabled = false;
    let target: MacVoiceInlineModifier = 'ctrl';
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => target,
      isEnabled: () => enabled,
      now: () => now,
      onDoubleTap,
    });

    for (let i = 0; i < 2; i++) {
      detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
      now += 40;
      detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
      now += 80;
    }
    expect(onDoubleTap).not.toHaveBeenCalled();

    enabled = true;
    target = null;
    for (let i = 0; i < 2; i++) {
      detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
      now += 40;
      detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
      now += 80;
    }
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('does not steal Ctrl+C / Cmd+C chords, Ctrl+Shift combos, or taps separated by typing', () => {
    let now = 1000;
    let target: MacVoiceInlineModifier = 'ctrl';
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => target,
      isEnabled: () => true,
      now: () => now,
      onDoubleTap,
    });

    // Ctrl+C twice must NOT trigger double-tap Ctrl
    for (let i = 0; i < 2; i++) {
      detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
      now += 20;
      detector.handleKeyDown({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false });
      now += 20;
      detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
      now += 80;
    }
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Ctrl down, Shift down -> dirty
    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft', { ctrlKey: true, shiftKey: true }));
    now += 30;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    now += 50;
    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Ctrl tap, type 'a', Ctrl tap within window -> must reset between taps
    now += 1000;
    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    now += 50;
    detector.handleKeyDown({ key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false });
    now += 50;
    detector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Cmd+C when configured modifier is meta
    target = 'meta';
    detector.reset();
    detector.handleKeyDown(modEvent('Meta', 'MetaLeft'));
    detector.handleKeyDown({ key: 'c', code: 'KeyC', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true, repeat: false, isComposing: false });
    now += 20;
    detector.handleKeyUp(modEvent('Meta', 'MetaLeft', { metaKey: false }));
    now += 80;
    detector.handleKeyDown(modEvent('Meta', 'MetaLeft'));
    now += 20;
    detector.handleKeyUp(modEvent('Meta', 'MetaLeft', { metaKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('rejects long holds and expired double-tap windows while supporting alt, meta, and shift', () => {
    let now = 1000;
    let target: MacVoiceInlineModifier = 'alt';
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => target,
      isEnabled: () => true,
      now: () => now,
      onDoubleTap,
    });

    // First tap held longer than MAX_MODIFIER_TAP_HOLD_MS -> ignored
    detector.handleKeyDown(modEvent('Alt', 'AltLeft'));
    now += MAX_MODIFIER_TAP_HOLD_MS + 50;
    detector.handleKeyUp(modEvent('Alt', 'AltLeft', { altKey: false }));
    now += 60;
    detector.handleKeyDown(modEvent('Alt', 'AltLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Alt', 'AltLeft', { altKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Too slow between tap 1 and tap 2 -> ignored, then quick follow-up triggers
    now += DOUBLE_TAP_MODIFIER_WINDOW_MS + 100;
    detector.handleKeyDown(modEvent('Alt', 'AltRight'));
    now += 30;
    detector.handleKeyUp(modEvent('Alt', 'AltRight', { altKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    now += 120;
    detector.handleKeyDown(modEvent('Alt', 'AltRight'));
    now += 30;
    detector.handleKeyUp(modEvent('Alt', 'AltRight', { altKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);

    // Shift works too
    target = 'shift';
    now += 500;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 20;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    now += 80;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 20;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(2);
  });

  it('dedupes UIKit native modifier events with DOM events and rescues missing DOM keyup (Cmd)', () => {
    let now = 1000;
    let target: MacVoiceInlineModifier = 'meta';
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => target,
      isEnabled: () => true,
      now: () => now,
      onDoubleTap,
    });

    // Tap 1: native down + DOM down + native up (DOM keyup omitted as on Catalyst Cmd)
    detector.handleNativeEvent({ source: 'native', phase: 'down', modifier: 'meta' });
    detector.handleKeyDown(modEvent('Meta', 'MetaLeft'));
    now += 35;
    detector.handleNativeEvent({ source: 'native', phase: 'up', modifier: 'meta' });
    // Even if DOM keyup arrives late, same press must not double-count as 2 taps!
    detector.handleKeyUp(modEvent('Meta', 'MetaLeft', { metaKey: false }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Tap 2: native down + native up triggers once
    now += 120;
    detector.handleNativeEvent({ source: 'native', phase: 'down', modifier: 'meta' });
    now += 35;
    detector.handleNativeEvent({ source: 'native', phase: 'up', modifier: 'meta' });
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('installs window listeners that gate on Mac desktop and respect active shortcut recording', () => {
    const onDoubleTap = vi.fn();
    let now = 2000;
    const cleanup = installMacVoiceShortcutListener({
      getTargetModifier: () => 'ctrl',
      isEnabled: () => true,
      now: () => now,
      onDoubleTap,
    });

    // Shortcut recorder active in Settings -> blocked
    const recorder = document.createElement('button');
    recorder.setAttribute('data-shortcut-recording', 'true');
    document.body.appendChild(recorder);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 20;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    now += 80;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 20;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    recorder.remove();

    // Normal double-tap via native + DOM events on window
    window.dispatchEvent(new CustomEvent(NATIVE_MODIFIER_PRESS_EVENT, { detail: { source: 'native', phase: 'down', modifier: 'ctrl' } }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    window.dispatchEvent(new CustomEvent(NATIVE_MODIFIER_PRESS_EVENT, { detail: { source: 'native', phase: 'up', modifier: 'ctrl' } }));
    now += 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
