/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_TAP_MODIFIER_WINDOW_MS,
  MAX_MODIFIER_TAP_HOLD_MS,
  NATIVE_MODIFIER_PRESS_EVENT,
  SINGLE_TAP_MODIFIER_DELAY_MS,
  createDoubleTapModifierDetector,
  installMacVoiceShortcutListener,
  isAnyInlineVoiceComposerActive,
  isMacVoiceShortcutEnabled,
  registerMacVoiceComposerHandler,
  triggerMacVoiceComposerStopOnly,
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
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
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

  it('enables default double-tap modifier detection on macOS PC App while keeping plain/Windows browsers disabled and honoring explicit isEnabled', () => {
    let now = 3000;
    const onDoubleTap = vi.fn();

    // Plain web browser (no Capacitor Mac desktop and no PC App bridge): disabled
    expect(isMacVoiceShortcutEnabled()).toBe(false);
    const plainCleanup = installMacVoiceShortcutListener({
      getTargetModifier: () => 'ctrl',
      now: () => now,
      onDoubleTap,
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    now += 80;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Windows PC App (isNativeSpeechSupported === false): remains disabled
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      voice: { isNativeSpeechSupported: () => false },
    };
    expect(isMacVoiceShortcutEnabled()).toBe(false);
    now += 500;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    now += 80;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    expect(onDoubleTap).not.toHaveBeenCalled();

    // macOS PC App (isNativeSpeechSupported === true, Capacitor false): enables listener & detector
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      voice: { isNativeSpeechSupported: () => true },
    };
    expect(isMacVoiceShortcutEnabled()).toBe(true);
    now += 500;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    now += 80;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    now += 30;
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);

    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => 'meta',
      now: () => now,
      onDoubleTap,
    });
    now += 500;
    detector.handleKeyDown(modEvent('Meta', 'MetaLeft'));
    now += 25;
    detector.handleKeyUp(modEvent('Meta', 'MetaLeft', { metaKey: false }));
    now += 90;
    detector.handleKeyDown(modEvent('Meta', 'MetaLeft'));
    now += 25;
    detector.handleKeyUp(modEvent('Meta', 'MetaLeft', { metaKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(2);

    // Explicit isEnabled override takes precedence
    const suppressedDetector = createDoubleTapModifierDetector({
      getTargetModifier: () => 'ctrl',
      isEnabled: () => false,
      now: () => now,
      onDoubleTap,
    });
    now += 500;
    suppressedDetector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 25;
    suppressedDetector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    now += 90;
    suppressedDetector.handleKeyDown(modEvent('Control', 'ControlLeft'));
    now += 25;
    suppressedDetector.handleKeyUp(modEvent('Control', 'ControlLeft', { ctrlKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(2);

    plainCleanup();
  });

  it('fires onSingleTap only when shouldEmitSingleTap is true, cancels on fast double-tap or other key activity', () => {
    vi.useFakeTimers();
    let now = 5000;
    let inlineActive = false;
    const onSingleTap = vi.fn();
    const onDoubleTap = vi.fn();
    const detector = createDoubleTapModifierDetector({
      getTargetModifier: () => 'shift',
      isEnabled: () => true,
      now: () => now,
      shouldEmitSingleTap: () => inlineActive,
      onSingleTap,
      onDoubleTap,
    });

    // When idle (shouldEmitSingleTap() === false), single tap does not fire onSingleTap
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    vi.advanceTimersByTime(DOUBLE_TAP_MODIFIER_WINDOW_MS + 100);
    expect(onSingleTap).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();

    // When active (shouldEmitSingleTap() === true), clean single tap fires onSingleTap after window
    inlineActive = true;
    now += 500;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SINGLE_TAP_MODIFIER_DELAY_MS - 10);
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(onSingleTap).toHaveBeenCalledTimes(1);
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Another single tap right after reset works as a fresh tap, not a double-tap
    now += 200;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 30;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    vi.advanceTimersByTime(SINGLE_TAP_MODIFIER_DELAY_MS + 10);
    expect(onSingleTap).toHaveBeenCalledTimes(2);
    expect(onDoubleTap).not.toHaveBeenCalled();

    // Fast double-tap cancels pending onSingleTap and fires onDoubleTap
    now += 500;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 25;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    vi.advanceTimersByTime(100);
    now += 100;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 25;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DOUBLE_TAP_MODIFIER_WINDOW_MS + 100);
    expect(onSingleTap).toHaveBeenCalledTimes(2);

    // Normal Shift+letter typing cancels pending single-tap timer (both held chord and post-tap key)
    now += 500;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    detector.handleKeyDown({ key: 'A', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false, repeat: false, isComposing: false });
    now += 30;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    vi.advanceTimersByTime(SINGLE_TAP_MODIFIER_DELAY_MS + 50);
    expect(onSingleTap).toHaveBeenCalledTimes(2);

    now += 500;
    detector.handleKeyDown(modEvent('Shift', 'ShiftLeft'));
    now += 25;
    detector.handleKeyUp(modEvent('Shift', 'ShiftLeft', { shiftKey: false }));
    detector.handleKeyDown({ key: 'a', code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false });
    vi.advanceTimersByTime(SINGLE_TAP_MODIFIER_DELAY_MS + 50);
    expect(onSingleTap).toHaveBeenCalledTimes(2);
  });

  it('triggerMacVoiceComposerStopOnly invokes stopWithoutSubmit on active inline-voice handler without calling triggerToggleOrSubmit', () => {
    let inlineActive = false;
    const triggerToggleOrSubmit = vi.fn(() => true);
    const stopWithoutSubmit = vi.fn(() => true);
    const idleToggle = vi.fn(() => true);
    const idleStop = vi.fn(() => true);

    const unregIdle = registerMacVoiceComposerHandler({
      isActive: () => true,
      isInlineVoiceActive: () => false,
      isFocused: () => true,
      triggerToggleOrSubmit: idleToggle,
      stopWithoutSubmit: idleStop,
    });
    const unregActive = registerMacVoiceComposerHandler({
      isActive: () => true,
      isInlineVoiceActive: () => inlineActive,
      isFocused: () => false,
      triggerToggleOrSubmit,
      stopWithoutSubmit,
    });

    try {
      expect(isAnyInlineVoiceComposerActive()).toBe(false);
      expect(triggerMacVoiceComposerStopOnly()).toBe(false);
      expect(idleStop).not.toHaveBeenCalled();
      expect(stopWithoutSubmit).not.toHaveBeenCalled();

      inlineActive = true;
      expect(isAnyInlineVoiceComposerActive()).toBe(true);
      expect(triggerMacVoiceComposerStopOnly()).toBe(true);
      expect(stopWithoutSubmit).toHaveBeenCalledTimes(1);
      expect(triggerToggleOrSubmit).not.toHaveBeenCalled();
      expect(idleStop).not.toHaveBeenCalled();
      expect(idleToggle).not.toHaveBeenCalled();
    } finally {
      unregActive();
      unregIdle();
    }
  });
});
