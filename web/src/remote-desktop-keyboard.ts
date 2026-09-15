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

/**
 * One key on the mobile "computer keyboard" tab -- the keys a software IME
 * cannot reach at all (function keys, navigation cluster, modifiers held on
 * their own). `modifier` marks the four keys that latch in combo mode
 * instead of firing immediately: Control/Shift/Option-or-Alt/Command-or-Win.
 */
export interface RemoteDesktopComputerKeySpec {
  code: string;
  key: string;
  modifier: boolean;
}

const modKey = (code: string, key: string): RemoteDesktopComputerKeySpec => ({ code, key, modifier: true });
const plainKey = (code: string, key: string): RemoteDesktopComputerKeySpec => ({ code, key, modifier: false });

/**
 * Row-major layout for the on-screen computer keyboard: modifiers, then
 * Esc/Tab/backtick/PrintScreen/ScrollLock/Pause, then three rows pairing
 * F1-F9 with Insert/Home/PageUp/Delete/End/PageDown/CapsLock, and finally
 * F10-F12 with the arrow cluster.
 */
export const REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS: readonly (readonly RemoteDesktopComputerKeySpec[])[] = [
  [modKey('ControlLeft', 'Control'), modKey('ShiftLeft', 'Shift'), modKey('AltLeft', 'Alt'), modKey('MetaLeft', 'Meta')],
  [plainKey('Escape', 'Escape'), plainKey('Tab', 'Tab'), plainKey('Backquote', '`'), plainKey('PrintScreen', 'PrintScreen'), plainKey('ScrollLock', 'ScrollLock'), plainKey('Pause', 'Pause')],
  [plainKey('F1', 'F1'), plainKey('F2', 'F2'), plainKey('F3', 'F3'), plainKey('Insert', 'Insert'), plainKey('Home', 'Home'), plainKey('PageUp', 'PageUp')],
  [plainKey('F4', 'F4'), plainKey('F5', 'F5'), plainKey('F6', 'F6'), plainKey('Delete', 'Delete'), plainKey('End', 'End'), plainKey('PageDown', 'PageDown')],
  [plainKey('F7', 'F7'), plainKey('F8', 'F8'), plainKey('F9', 'F9'), plainKey('CapsLock', 'CapsLock'), plainKey('ArrowUp', 'ArrowUp')],
  [plainKey('F10', 'F10'), plainKey('F11', 'F11'), plainKey('F12', 'F12'), plainKey('ArrowLeft', 'ArrowLeft'), plainKey('ArrowDown', 'ArrowDown'), plainKey('ArrowRight', 'ArrowRight')],
];

const DIGIT_ROW_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const QWERTY_ROW_LETTERS = 'qwertyuiop';
const HOME_ROW_LETTERS = 'asdfghjkl';
const BOTTOM_ROW_LETTERS = 'zxcvbnm';

const letterKey = (letter: string): RemoteDesktopComputerKeySpec => plainKey(
  `Key${letter.toUpperCase()}`,
  // Lowercase, matching the established convention for every other
  // single-letter key sent from a chip click (e.g. remoteDesktopMobileShortcutKeys'
  // `KeyA`/'a') -- there is no physical keypress behind a tap to reconcile
  // against, only what the target host's own key-event handling expects for
  // an unshifted letter. Combo mode can still produce the uppercase form: a
  // latched Shift is a real ShiftLeft keydown already on the wire, so the
  // target computes the capital itself exactly as it would from a real
  // keyboard, regardless of the case sent here.
  letter,
);
const digitKey = (digit: string): RemoteDesktopComputerKeySpec => plainKey(digit === '0' ? 'Digit0' : `Digit${digit}`, digit);

/**
 * Second computer-keyboard page: the full alphanumeric/punctuation layout a
 * software IME already covers for typing, but as individually addressable
 * keys instead of characters composed through an input method -- useful
 * together with a modifier latched on the first page (e.g. Control from
 * page one, then a letter here, form one chord same as tapping both on a
 * single page would).
 */
export const REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2: readonly (readonly RemoteDesktopComputerKeySpec[])[] = [
  [
    plainKey('Minus', '-'), plainKey('Equal', '='),
    plainKey('BracketLeft', '['), plainKey('BracketRight', ']'),
    plainKey('Backslash', '\\'),
    plainKey('Semicolon', ';'), plainKey('Quote', "'"),
    plainKey('Comma', ','), plainKey('Period', '.'), plainKey('Slash', '/'),
  ],
  DIGIT_ROW_KEYS.map(digitKey),
  QWERTY_ROW_LETTERS.split('').map(letterKey),
  [...HOME_ROW_LETTERS.split('').map(letterKey), plainKey('Backspace', 'Backspace')],
  [...BOTTOM_ROW_LETTERS.split('').map(letterKey), plainKey('Space', ' '), plainKey('Enter', 'Enter')],
];

/** Every computer-keyboard page, in swipe order. */
export const REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES: readonly (readonly (readonly RemoteDesktopComputerKeySpec[])[])[] = [
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2,
];

const LETTER_KEY_LABELS: Record<string, string> = Object.fromEntries(
  'abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => [`Key${letter.toUpperCase()}`, letter.toUpperCase()]),
);

const COMPUTER_KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Backquote: '~ `',
  PrintScreen: 'PrtScr',
  ScrollLock: 'ScrLk',
  Pause: 'Pause',
  Insert: 'Ins',
  Home: 'Home',
  PageUp: 'PgUp',
  Delete: 'Del',
  End: 'End',
  PageDown: 'PgDn',
  CapsLock: 'Caps',
  ArrowUp: '▲',
  ArrowDown: '▼',
  ArrowLeft: '◀',
  ArrowRight: '▶',
  ...LETTER_KEY_LABELS,
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Space: 'Space', Enter: '↵', Backspace: '⌫',
};

/**
 * The visible glyph for one computer-keyboard key. Control and Shift read
 * the same on every target; Option/Alt and Command/Win are the two keys
 * whose printed cap -- and so the label a controller expects -- differs
 * between a macOS target and a Windows/Linux one.
 */
export function remoteDesktopComputerKeyLabel(
  spec: RemoteDesktopComputerKeySpec,
  targetPlatform: RemoteDesktopTargetPlatform,
): string {
  const macTarget = targetPlatform === 'macos';
  if (spec.code === 'AltLeft') return macTarget ? 'Option' : 'Alt';
  if (spec.code === 'MetaLeft') return macTarget ? '⌘' : 'Win';
  if (spec.code === 'ControlLeft') return 'Control';
  if (spec.code === 'ShiftLeft') return 'Shift';
  return COMPUTER_KEY_LABELS[spec.code] ?? spec.key;
}

/** How long the mobile IME target stays read-only/disabled before regaining focus — see {@link focusRemoteDesktopMobileInput}. */
export const REMOTE_DESKTOP_MOBILE_INPUT_ACCESSORY_SUPPRESS_MS = 100;

/**
 * Focus the mobile hidden IME textarea while suppressing iOS Safari/
 * WKWebView's own accessory toolbar — the "Previous"/"Next" field-navigation
 * chevrons plus a Done/checkmark button it otherwise draws above the system
 * keyboard for any focused text field. There is nothing to navigate to or
 * confirm on this invisible IME target (what is typed lands directly on the
 * remote screen), and the bar just eats screen space above an already
 * cramped mobile keyboard.
 *
 * iOS decides whether to draw the bar at the exact moment a field becomes
 * focused and editable, so the standard purely-web workaround is to make the
 * field briefly read-only/disabled at that instant, then clear both and
 * refocus a beat later: iOS never draws the bar for a field it observed as
 * non-editable when the keyboard was requested. Every call site that focuses
 * this textarea MUST go through here rather than calling `.focus()` directly,
 * so the bar stays suppressed across every path (opening the panel,
 * switching back from the Keys tab, and after sending a shortcut chord).
 */
export function focusRemoteDesktopMobileInput(input: HTMLTextAreaElement | null | undefined): void {
  if (!input) return;
  input.setAttribute('readonly', 'readonly');
  input.setAttribute('disabled', 'true');
  setTimeout(() => {
    input.removeAttribute('readonly');
    input.removeAttribute('disabled');
    input.focus({ preventScroll: true });
  }, REMOTE_DESKTOP_MOBILE_INPUT_ACCESSORY_SUPPRESS_MS);
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
