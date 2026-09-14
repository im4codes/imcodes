export interface RemoteDesktopKeyboardEventLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface RemoteDesktopMappedKey {
  code: string;
  key: string;
  modifiers: {
    control: boolean;
    alt: boolean;
  };
  /** True only when this event's Command press is being translated to Control. */
  commandAsControl: boolean;
  /** True whenever the Apple-controller command bridge applies at all, whether or not it translates. */
  usesCommandBridge: boolean;
}

/** Platform ids resolved from the target's advertised capabilities (shared/remote-desktop-platform.ts). */
export type RemoteDesktopTargetPlatform = 'windows' | 'macos' | 'linux' | null;

export interface RemoteDesktopCommandBridge {
  /** The local controller has no physical Ctrl key of its own -- Command is its primary shortcut modifier. */
  appleController: boolean;
  /** Whether an Apple controller's Command press needs translating to Control to mean the right thing on this target. */
  translateToControl: boolean;
  /** The code/key that represents "the primary shortcut modifier is held" for this controller+target pairing. */
  code: 'ControlLeft' | 'MetaLeft';
  key: 'Control' | 'Meta';
}

/**
 * How an Apple controller's Command key should be represented on the wire.
 *
 * Windows has no Command key, so a Mac controller's Command has always stood
 * in for Control there. A Mac TARGET is different: it already has a Command
 * key of its own, and forwarding Control there is not merely wrong, it does
 * nothing (Control+C/V/Z/etc. are not bound to anything on macOS, and can
 * mean something else entirely, e.g. SIGINT in a terminal) -- every Apple
 * controller shortcut looked identical to a working press while silently
 * failing on a Mac target. A non-Apple controller has its own real Control
 * key already and never needs any of this.
 */
export function remoteDesktopCommandBridge(
  platform: string,
  targetPlatform: RemoteDesktopTargetPlatform,
): RemoteDesktopCommandBridge {
  const appleController = isAppleControllerPlatform(platform);
  const commandStaysCommand = appleController && targetPlatform === 'macos';
  return {
    appleController,
    translateToControl: appleController && !commandStaysCommand,
    code: commandStaysCommand ? 'MetaLeft' : 'ControlLeft',
    key: commandStaysCommand ? 'Meta' : 'Control',
  };
}

export interface RemoteDesktopChordKey {
  code: string;
  key: string;
}

const MOBILE_BACKWARD_DELETE_INPUT_TYPES = new Set([
  'deleteContentBackward',
  'deleteWordBackward',
  'deleteSoftLineBackward',
  'deleteHardLineBackward',
]);

const MOBILE_FORWARD_DELETE_INPUT_TYPES = new Set([
  'deleteContentForward',
  'deleteWordForward',
  'deleteSoftLineForward',
  'deleteHardLineForward',
]);

export function remoteDesktopMobileDeletionKey(
  inputType: string,
): RemoteDesktopChordKey | null {
  if (MOBILE_BACKWARD_DELETE_INPUT_TYPES.has(inputType)) {
    return { code: 'Backspace', key: 'Backspace' };
  }
  if (MOBILE_FORWARD_DELETE_INPUT_TYPES.has(inputType)) {
    return { code: 'Delete', key: 'Delete' };
  }
  return null;
}

// Copy/paste are deliberately absent here: this row sends a literal chord
// straight to the remote, and the dedicated copy/paste buttons rendered
// after it already answer both actions through the clipboard bridge, which
// moves real clipboard content between the two machines instead of just
// replaying a keystroke, on every remote platform.
export const REMOTE_DESKTOP_MOBILE_SHORTCUT_IDS = [
  'select_all', 'cut', 'find', 'undo', 'redo', 'save', 'switch_window',
  'escape', 'tab', 'enter', 'backspace',
] as const;

export type RemoteDesktopMobileShortcutId = typeof REMOTE_DESKTOP_MOBILE_SHORTCUT_IDS[number];

/**
 * The chord for one shortcut, in the remote TARGET's own terms -- not the
 * controller's. A chip click has no physical keypress behind it, so unlike
 * interactive typing (remoteDesktopCommandBridge) there is no controller
 * convention to reconcile: the only question is what the target host binds
 * its primary shortcut modifier to. Windows and Linux use Control (and
 * Alt+Tab for window switching); macOS uses Command for all of these except
 * window switching (Command+Tab) and Redo (Command+Shift+Z rather than
 * Command+Y). Sending the Windows chord to a macOS target used to be a
 * silent no-op there -- Control+A/C/V/X/Z/etc. is not bound to anything on
 * macOS, and can mean something else entirely, e.g. SIGINT in a terminal --
 * while looking identical to a working press.
 */
export function remoteDesktopMobileShortcutKeys(
  id: RemoteDesktopMobileShortcutId,
  targetPlatform: RemoteDesktopTargetPlatform,
): readonly RemoteDesktopChordKey[] {
  const macTarget = targetPlatform === 'macos';
  const primary: RemoteDesktopChordKey = macTarget
    ? { code: 'MetaLeft', key: 'Meta' }
    : { code: 'ControlLeft', key: 'Control' };
  switch (id) {
    case 'select_all': return [primary, { code: 'KeyA', key: 'a' }];
    case 'cut': return [primary, { code: 'KeyX', key: 'x' }];
    case 'find': return [primary, { code: 'KeyF', key: 'f' }];
    case 'undo': return [primary, { code: 'KeyZ', key: 'z' }];
    case 'redo': return macTarget
      ? [primary, { code: 'ShiftLeft', key: 'Shift' }, { code: 'KeyZ', key: 'z' }]
      : [primary, { code: 'KeyY', key: 'y' }];
    case 'save': return [primary, { code: 'KeyS', key: 's' }];
    case 'switch_window': return macTarget
      ? [primary, { code: 'Tab', key: 'Tab' }]
      : [{ code: 'AltLeft', key: 'Alt' }, { code: 'Tab', key: 'Tab' }];
    case 'escape': return [{ code: 'Escape', key: 'Escape' }];
    case 'tab': return [{ code: 'Tab', key: 'Tab' }];
    case 'enter': return [{ code: 'Enter', key: 'Enter' }];
    case 'backspace': return [{ code: 'Backspace', key: 'Backspace' }];
  }
}

export function remoteDesktopShortcutLabel(
  id: RemoteDesktopMobileShortcutId,
  targetPlatform: RemoteDesktopTargetPlatform,
): string {
  const macTarget = targetPlatform === 'macos';
  const primary = macTarget ? '⌘' : 'Ctrl';
  if (id === 'select_all') return `${primary}+A`;
  if (id === 'cut') return `${primary}+X`;
  if (id === 'find') return `${primary}+F`;
  if (id === 'undo') return `${primary}+Z`;
  if (id === 'redo') return macTarget ? `${primary}+⇧+Z` : `${primary}+Y`;
  if (id === 'save') return `${primary}+S`;
  if (id === 'switch_window') return macTarget ? `${primary}+Tab` : 'Alt+Tab';
  if (id === 'escape') return 'Esc';
  if (id === 'tab') return 'Tab';
  if (id === 'enter') return '↵';
  return '⌫';
}

export function isAppleControllerPlatform(platform: string): boolean {
  return /(?:Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function readControllerPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.platform || navigator.userAgent || '';
}

/**
 * On an Apple controller, Command is the user's primary shortcut modifier,
 * so its physical left/right transitions are represented as the
 * corresponding transitions of whatever the TARGET binds its primary
 * shortcut modifier to: Control when the target is Windows/Linux (or
 * unknown -- Windows was the only supported target before per-platform
 * targets existed, so this preserves that as the default), or Command
 * itself, unchanged, when the target is also a Mac. A non-Apple
 * controller's own local Meta/Windows key is never forwarded directly, on
 * any target.
 */
export function mapRemoteDesktopKeyboardEvent(
  event: RemoteDesktopKeyboardEventLike,
  platform = readControllerPlatform(),
  targetPlatform: RemoteDesktopTargetPlatform = null,
): RemoteDesktopMappedKey | null {
  const bridge = remoteDesktopCommandBridge(platform, targetPlatform);
  let code = event.code;
  let key = event.key;
  if (code === 'MetaLeft' || code === 'MetaRight') {
    if (!bridge.appleController) return null;
    if (bridge.translateToControl) {
      code = code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight';
      key = 'Control';
    }
    // else: the target is also a Mac, so Command is forwarded as itself.
  }
  return {
    code,
    key,
    modifiers: {
      control: event.ctrlKey || (bridge.translateToControl && event.metaKey),
      alt: event.altKey,
    },
    commandAsControl: bridge.translateToControl,
    usesCommandBridge: bridge.appleController,
  };
}

export const REMOTE_DESKTOP_CLIPBOARD_SHORTCUT = {
  COPY: 'copy',
  PASTE: 'paste',
} as const;

export type RemoteDesktopClipboardShortcut = typeof REMOTE_DESKTOP_CLIPBOARD_SHORTCUT[
  keyof typeof REMOTE_DESKTOP_CLIPBOARD_SHORTCUT
];

/**
 * The copy/paste the operator actually meant, in their own platform's terms:
 * Command on an Apple controller, Control everywhere else.
 *
 * These two are special among shortcuts because the clipboards are not shared.
 * Forwarding the keystroke alone copies into the remote machine's clipboard,
 * which the operator cannot reach, and pastes from it, which is never what they
 * just copied locally — so the intent has to be recognised here and answered by
 * the clipboard bridge instead.
 *
 * Shift or Alt held means something else entirely (paste-special, column copy),
 * so those keep going to the remote untouched.
 */
export function detectRemoteDesktopClipboardShortcut(
  event: RemoteDesktopKeyboardEventLike & { shiftKey?: boolean },
  platform = readControllerPlatform(),
): RemoteDesktopClipboardShortcut | null {
  const primaryHeld = isAppleControllerPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primaryHeld || event.altKey || event.shiftKey === true) return null;
  if (event.code === 'KeyC') return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY;
  if (event.code === 'KeyV') return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE;
  return null;
}

export function sendRemoteDesktopChord(
  keys: readonly RemoteDesktopChordKey[],
  send: (
    code: string,
    key: string,
    down: boolean,
    repeat: boolean,
    modifiers: { control: boolean; alt: boolean },
  ) => boolean,
  releaseAll: () => void,
): boolean {
  const pressed: RemoteDesktopChordKey[] = [];
  let control = false;
  let alt = false;
  let ok = true;
  for (const key of keys) {
    if (key.code === 'ControlLeft' || key.code === 'ControlRight') control = true;
    if (key.code === 'AltLeft' || key.code === 'AltRight') alt = true;
    if (!send(key.code, key.key, true, false, { control, alt })) {
      ok = false;
      break;
    }
    pressed.push(key);
  }
  for (const key of [...pressed].reverse()) {
    if (!send(key.code, key.key, false, false, { control, alt })) ok = false;
    if (key.code === 'ControlLeft' || key.code === 'ControlRight') control = false;
    if (key.code === 'AltLeft' || key.code === 'AltRight') alt = false;
  }
  if (!ok) releaseAll();
  return ok;
}
