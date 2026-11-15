import type { MacVoiceInlineModifier, ShortcutModifierKey } from './keyboard-shortcuts.js';
import { DEFAULT_MAC_VOICE_INLINE_MODIFIER } from './keyboard-shortcuts.js';
import { subscribeDeviceLayoutChange } from './mobile-device.js';
import { isNativeMacDesktop } from './native-platform.js';

export const DOUBLE_TAP_MODIFIER_WINDOW_MS = 450;
export const MAX_MODIFIER_TAP_HOLD_MS = 450;
export const NATIVE_MODIFIER_PRESS_EVENT = 'imcodes:native-modifier-press';

export interface NativeModifierPressDetail {
  source?: 'native';
  phase: 'down' | 'up' | 'cancel' | 'other';
  modifier?: ShortcutModifierKey;
  timestamp?: number;
}

export interface MacVoiceComposerHandler {
  isActive: () => boolean;
  isInlineVoiceActive: () => boolean;
  isFocused: () => boolean;
  triggerToggleOrSubmit: () => boolean;
}

export interface DoubleTapModifierDetectorOptions {
  getTargetModifier: () => MacVoiceInlineModifier;
  onDoubleTap: () => void;
  isEnabled?: () => boolean;
  isBlocked?: () => boolean;
  now?: () => number;
  doubleTapWindowMs?: number;
  maxHoldMs?: number;
}

export interface DoubleTapModifierDetector {
  handleKeyDown: (e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat' | 'isComposing'>) => boolean;
  handleKeyUp: (e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>) => boolean;
  handleNativeEvent: (detail: NativeModifierPressDetail | null | undefined) => boolean;
  reset: () => void;
}

export function extractModifierKeyFromKeyboardEvent(
  e: Pick<KeyboardEvent, 'key' | 'code'>,
): ShortcutModifierKey | null {
  switch (e.code) {
    case 'ControlLeft':
    case 'ControlRight':
      return 'ctrl';
    case 'AltLeft':
    case 'AltRight':
      return 'alt';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'shift';
    case 'MetaLeft':
    case 'MetaRight':
      return 'meta';
    default:
      break;
  }
  switch (e.key) {
    case 'Control':
      return 'ctrl';
    case 'Alt':
    case 'AltGraph':
      return 'alt';
    case 'Shift':
      return 'shift';
    case 'Meta':
      return 'meta';
    default:
      return null;
  }
}

export function hasOtherModifiersActive(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  target: ShortcutModifierKey,
): boolean {
  if (target !== 'ctrl' && e.ctrlKey) return true;
  if (target !== 'alt' && e.altKey) return true;
  if (target !== 'shift' && e.shiftKey) return true;
  if (target !== 'meta' && e.metaKey) return true;
  return false;
}

export function isShortcutRecordingActiveInDom(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('[data-shortcut-recording="true"]'));
}

export function createDoubleTapModifierDetector(
  options: DoubleTapModifierDetectorOptions,
): DoubleTapModifierDetector {
  const isEnabled = options.isEnabled ?? (() => isNativeMacDesktop());
  const now = options.now ?? (() => Date.now());
  const doubleTapWindowMs = options.doubleTapWindowMs ?? DOUBLE_TAP_MODIFIER_WINDOW_MS;
  const maxHoldMs = options.maxHoldMs ?? MAX_MODIFIER_TAP_HOLD_MS;

  let phase: 'idle' | 'pressed' | 'released_once' = 'idle';
  let downAt = 0;
  let firstTapUpAt: number | null = null;
  let dirty = false;

  const reset = () => {
    phase = 'idle';
    downAt = 0;
    firstTapUpAt = null;
    dirty = false;
  };

  const canProcess = (): ShortcutModifierKey | null => {
    if (!isEnabled()) {
      reset();
      return null;
    }
    if (isShortcutRecordingActiveInDom() || options.isBlocked?.()) {
      reset();
      return null;
    }
    const target = options.getTargetModifier();
    if (!target) {
      reset();
      return null;
    }
    return target;
  };

  const handleOtherActivity = () => {
    if (phase === 'pressed') {
      // Mark current press dirty so releasing Ctrl after Ctrl+C cannot count as a tap.
      dirty = true;
      firstTapUpAt = null;
      return;
    }
    if (phase === 'released_once') {
      reset();
    }
  };

  const handleTargetDown = () => {
    // Ignore duplicate keydown / native down for a press already in flight so
    // native UIKit + DOM events dedupe without resetting hold timer or dirty flag.
    if (phase === 'pressed') return false;
    phase = 'pressed';
    downAt = now();
    dirty = false;
    return true;
  };

  const handleTargetUp = (otherModsActive: boolean): boolean => {
    if (phase !== 'pressed') return false;
    const t = now();
    const holdElapsed = t - downAt;
    const wasDirty = dirty || otherModsActive || holdElapsed > maxHoldMs || holdElapsed < 0;
    dirty = false;
    downAt = 0;
    if (wasDirty) {
      reset();
      return false;
    }
    if (firstTapUpAt !== null && (t - firstTapUpAt) <= doubleTapWindowMs && (t - firstTapUpAt) >= 0) {
      reset();
      options.onDoubleTap();
      return true;
    }
    phase = 'released_once';
    firstTapUpAt = t;
    return false;
  };

  return {
    reset,
    handleKeyDown(e) {
      const target = canProcess();
      if (!target) return false;
      if (e.isComposing) {
        reset();
        return false;
      }
      const mod = extractModifierKeyFromKeyboardEvent(e);
      if (mod !== target || hasOtherModifiersActive(e, target)) {
        handleOtherActivity();
        return false;
      }
      if (e.repeat) return false;
      handleTargetDown();
      return false;
    },
    handleKeyUp(e) {
      const target = canProcess();
      if (!target) return false;
      if (e.isComposing) {
        reset();
        return false;
      }
      const mod = extractModifierKeyFromKeyboardEvent(e);
      if (mod !== target) {
        return false;
      }
      return handleTargetUp(hasOtherModifiersActive(e, target));
    },
    handleNativeEvent(detail) {
      const target = canProcess();
      if (!target || !detail) return false;
      if (detail.phase === 'cancel') {
        reset();
        return false;
      }
      if (detail.phase === 'other' || (detail.modifier && detail.modifier !== target)) {
        handleOtherActivity();
        return false;
      }
      if (detail.modifier !== target) {
        return false;
      }
      if (detail.phase === 'down') {
        handleTargetDown();
        return false;
      }
      if (detail.phase === 'up') {
        return handleTargetUp(false);
      }
      return false;
    },
  };
}

export interface InstallMacVoiceShortcutListenerOptions extends DoubleTapModifierDetectorOptions {
  targetWindow?: Window;
}

const composerHandlers = new Set<MacVoiceComposerHandler>();
let externalListenerCount = 0;
let fallbackCleanup: (() => void) | null = null;
let fallbackModifier: MacVoiceInlineModifier = DEFAULT_MAC_VOICE_INLINE_MODIFIER;

export function setFallbackMacVoiceModifier(modifier: MacVoiceInlineModifier): void {
  fallbackModifier = modifier;
}

function syncFallbackListener(): void {
  if (typeof window === 'undefined') return;
  if (composerHandlers.size === 0 || externalListenerCount > 0) {
    if (fallbackCleanup) {
      fallbackCleanup();
      fallbackCleanup = null;
    }
    return;
  }
  if (!fallbackCleanup) {
    fallbackCleanup = attachShortcutListenerInternal({
      getTargetModifier: () => fallbackModifier,
      onDoubleTap: () => {
        triggerRegisteredMacVoiceComposer();
      },
    });
  }
}

export function registerMacVoiceComposerHandler(handler: MacVoiceComposerHandler): () => void {
  composerHandlers.add(handler);
  syncFallbackListener();
  return () => {
    composerHandlers.delete(handler);
    syncFallbackListener();
  };
}

export function triggerRegisteredMacVoiceComposer(): boolean {
  const list = Array.from(composerHandlers);
  for (const h of list) {
    if (h.isInlineVoiceActive()) {
      return h.triggerToggleOrSubmit();
    }
  }
  for (const h of list) {
    if (h.isFocused()) {
      return h.triggerToggleOrSubmit();
    }
  }
  for (const h of list) {
    if (h.isActive()) {
      return h.triggerToggleOrSubmit();
    }
  }
  for (const h of list) {
    if (h.triggerToggleOrSubmit()) return true;
  }
  return false;
}

function attachShortcutListenerInternal(options: InstallMacVoiceShortcutListenerOptions): () => void {
  const win = options.targetWindow ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return () => {};
  const detector = createDoubleTapModifierDetector(options);

  const onKeyDown = (e: Event) => {
    detector.handleKeyDown(e as KeyboardEvent);
  };
  const onKeyUp = (e: Event) => {
    detector.handleKeyUp(e as KeyboardEvent);
  };
  const onBlur = () => {
    detector.reset();
  };
  const onCompositionStart = () => {
    detector.reset();
  };
  const onNativeEvent = (e: Event) => {
    const custom = e as CustomEvent<NativeModifierPressDetail | undefined>;
    detector.handleNativeEvent(custom.detail);
  };

  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  win.addEventListener('blur', onBlur);
  win.addEventListener('compositionstart', onCompositionStart, true);
  win.addEventListener(NATIVE_MODIFIER_PRESS_EVENT, onNativeEvent as EventListener);
  const unsubscribeHost = subscribeDeviceLayoutChange(() => {
    if (!(options.isEnabled ? options.isEnabled() : isNativeMacDesktop())) {
      detector.reset();
    }
  }, { includeResize: false });

  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUp, true);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('compositionstart', onCompositionStart, true);
    win.removeEventListener(NATIVE_MODIFIER_PRESS_EVENT, onNativeEvent as EventListener);
    unsubscribeHost();
    detector.reset();
  };
}

export function installMacVoiceShortcutListener(options: InstallMacVoiceShortcutListenerOptions): () => void {
  externalListenerCount += 1;
  syncFallbackListener();
  const detach = attachShortcutListenerInternal(options);
  return () => {
    detach();
    externalListenerCount = Math.max(0, externalListenerCount - 1);
    syncFallbackListener();
  };
}
