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

/**
 * An editing key the phone keyboard reported as itself on keydown -- iOS does
 * for Backspace and Return, Gboard does for Backspace in an empty field. With
 * nothing in the field to delete, such a key never becomes a beforeinput or
 * input event, so it is sent from keydown or not at all. Keys that belong to
 * an IME composition report keyCode 229 and are left to that path.
 */
export function remoteDesktopMobileEditingKey(
  key: string,
  keyCode: number,
): RemoteDesktopChordKey | null {
  if (keyCode === 229) return null;
  if (key === 'Backspace' || key === 'Delete' || key === 'Enter') return { code: key, key };
  return null;
}

/** Whether a phone-keyboard input event is Return. */
export function isRemoteDesktopMobileLineBreak(inputType: string): boolean {
  return inputType === 'insertLineBreak' || inputType === 'insertParagraph';
}

export interface RemoteDesktopMobileTextSplit {
  /** Whatever ordinary text preceded the line break, if any. */
  text: string;
  /** Whether the value ended in a line break at all. */
  enter: boolean;
}

/**
 * Separates a trailing Enter/Return from mobile IME-committed text.
 *
 * A mobile on-screen keyboard's Enter/Return/Go key is not a distinguishable
 * `keydown` with `key === 'Enter'` here the way a physical keyboard's is --
 * this hidden target's own `onKeyDown` is a no-op by design (see its call
 * site), because mobile IMEs do not reliably fire keydown for composed
 * input at all. Instead, mobile Enter shows up as an ordinary line break
 * character bundled into the committed text itself: either the value handed
 * to `compositionend` when Enter closes an active composition, or the value
 * of a plain, non-composing `input` event when it does not. Sending that
 * value straight through `RemoteDesktopClient.text()` -- the remote TEXT/
 * paste channel, which inserts literal Unicode content -- silently drops
 * it: nothing about that channel synthesizes a keypress, so an embedded
 * "\n" reached the remote as nothing at all, exactly like the keystroke had
 * never happened.
 *
 * Splits it out instead, the same way `remoteDesktopMobileDeletionKey`
 * above already splits deletion out of the same input stream: a call site
 * sends `text` (if non-empty) through the ordinary text channel, then sends
 * a real Enter key chord through the KEY_DOWN/KEY_UP channel when `enter` is
 * true -- so Return reaches the remote target as what it actually is, a
 * keypress, regardless of whether it arrived alone or trailing other text in
 * the same event.
 */
export function splitRemoteDesktopMobileTextEnter(
  value: string,
): RemoteDesktopMobileTextSplit {
  const lineBreak = /\r\n$|[\r\n]$/.exec(value);
  if (!lineBreak) return { text: value, enter: false };
  return { text: value.slice(0, -lineBreak[0].length), enter: true };
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
  // The mirror image of the command bridge: a Windows/Linux controller's
  // Control is its primary shortcut modifier, and a Mac target spells that
  // Command -- Control+C/V/Z/A/S/... are not bound to anything there.
  const controlAsCommand = !bridge.appleController && targetPlatform === 'macos';
  let code = event.code;
  let key = event.key;
  if (code === 'MetaLeft' || code === 'MetaRight') {
    if (!bridge.appleController) return null;
    if (bridge.translateToControl) {
      code = code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight';
      key = 'Control';
    }
    // else: the target is also a Mac, so Command is forwarded as itself.
  } else if (controlAsCommand && (code === 'ControlLeft' || code === 'ControlRight')) {
    code = code === 'ControlLeft' ? 'MetaLeft' : 'MetaRight';
    key = 'Meta';
  }
  return {
    code,
    key,
    modifiers: {
      control: (event.ctrlKey && !controlAsCommand) || (bridge.translateToControl && event.metaKey),
      alt: event.altKey,
    },
    commandAsControl: bridge.translateToControl,
    usesCommandBridge: bridge.appleController,
  };
}

export const REMOTE_DESKTOP_CLIPBOARD_SHORTCUT = {
  COPY: 'copy',
  CUT: 'cut',
  PASTE: 'paste',
} as const;

export type RemoteDesktopClipboardShortcut = typeof REMOTE_DESKTOP_CLIPBOARD_SHORTCUT[
  keyof typeof REMOTE_DESKTOP_CLIPBOARD_SHORTCUT
];

/**
 * The copy/cut/paste the operator actually meant, in their own platform's
 * terms: Command on an Apple controller, Control everywhere else (plus the
 * older Control+Insert / Shift+Insert pair PC keyboards still use).
 *
 * These are special among shortcuts because the clipboards are not shared.
 * Forwarding the keystroke alone copies into the remote machine's clipboard,
 * which the operator cannot reach, and pastes from it, which is never what they
 * just copied locally -- so the intent has to be recognised here and answered
 * by the clipboard bridge instead. Cut belongs here too: a cut forwarded blind
 * lands only in the remote clipboard, so the next paste would bring back
 * whatever was copied locally before it.
 *
 * Shift or Alt held means something else entirely (paste-special, column copy),
 * so those keep going to the remote untouched -- except in a Linux terminal,
 * which copies and pastes with Control+Shift+C/V (Control+C is SIGINT there).
 */
export function detectRemoteDesktopClipboardShortcut(
  event: RemoteDesktopKeyboardEventLike & { shiftKey?: boolean },
  platform = readControllerPlatform(),
  targetPlatform: RemoteDesktopTargetPlatform = null,
): RemoteDesktopClipboardShortcut | null {
  const apple = isAppleControllerPlatform(platform);
  const shift = event.shiftKey === true;
  if (event.altKey) return null;
  if (!apple && !event.metaKey && event.code === 'Insert') {
    if (event.ctrlKey && !shift) return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY;
    if (shift && !event.ctrlKey) return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE;
    return null;
  }
  const primaryHeld = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primaryHeld) return null;
  if (shift && (apple || targetPlatform !== 'linux')) return null;
  if (event.code === 'KeyC') return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY;
  if (event.code === 'KeyV') return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE;
  if (event.code === 'KeyX' && !shift) return REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.CUT;
  return null;
}

/**
 * Whether a recognised copy keystroke should still reach the remote as well.
 *
 * Only a PC operator's plain Control+C on a Linux target: there the worker
 * reads the selection without pressing anything, and Control+C itself still
 * has to arrive -- it is how a remote terminal is interrupted, and how a
 * remote app copies into its own clipboard. A Mac operator's Command+C would
 * arrive as Control+C, i.e. as that interrupt, so it never travels (their
 * physical Control+C still does); Windows and Mac workers press their own copy
 * shortcut when asked for the selection.
 */
export function shouldForwardRemoteDesktopCopyKeystroke(
  event: RemoteDesktopKeyboardEventLike & { shiftKey?: boolean },
  platform = readControllerPlatform(),
  targetPlatform: RemoteDesktopTargetPlatform = null,
): boolean {
  return targetPlatform === 'linux'
    && !isAppleControllerPlatform(platform)
    && event.code === 'KeyC'
    && event.shiftKey !== true
    && detectRemoteDesktopClipboardShortcut(event, platform, targetPlatform)
      === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY;
}

export type RemoteDesktopModifierKind = 'control' | 'alt' | 'shift' | 'meta';

const MODIFIER_KIND_BY_CODE: Readonly<Record<string, RemoteDesktopModifierKind>> = {
  ControlLeft: 'control',
  ControlRight: 'control',
  AltLeft: 'alt',
  AltRight: 'alt',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  MetaLeft: 'meta',
  MetaRight: 'meta',
};

/** The `KeyboardEvent.key` a modifier of each kind reports. */
export const REMOTE_DESKTOP_MODIFIER_KEY: Readonly<Record<RemoteDesktopModifierKind, string>> = {
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
};

/** Which modifier a physical key code is, or null for every other key. */
export function remoteDesktopModifierKind(code: string): RemoteDesktopModifierKind | null {
  return MODIFIER_KIND_BY_CODE[code] ?? null;
}

/**
 * Keyboard conventions come in two families: Mac (Command-centric) and PC
 * (Windows and Linux share Control-based shortcuts). A shortcut typed in the
 * controller's family means the same thing spelled the target family's way.
 */
export type RemoteDesktopKeyboardFamily = 'apple' | 'pc';

export function remoteDesktopControllerFamily(platform = readControllerPlatform()): RemoteDesktopKeyboardFamily {
  return isAppleControllerPlatform(platform) ? 'apple' : 'pc';
}

export function remoteDesktopTargetFamily(targetPlatform: RemoteDesktopTargetPlatform): RemoteDesktopKeyboardFamily {
  return targetPlatform === 'macos' ? 'apple' : 'pc';
}

export interface RemoteDesktopShortcutEventLike extends RemoteDesktopKeyboardEventLike {
  shiftKey: boolean;
}

/** One chord of a translated shortcut: modifiers first, then the key they apply to. */
export type RemoteDesktopTranslatedChord = readonly RemoteDesktopChordKey[];

const CHORD_CONTROL: RemoteDesktopChordKey = { code: 'ControlLeft', key: 'Control' };
const CHORD_COMMAND: RemoteDesktopChordKey = { code: 'MetaLeft', key: 'Meta' };
const CHORD_ALT: RemoteDesktopChordKey = { code: 'AltLeft', key: 'Alt' };
const CHORD_SHIFT: RemoteDesktopChordKey = { code: 'ShiftLeft', key: 'Shift' };
const chordKey = (code: string, key: string): RemoteDesktopChordKey => ({ code, key });

const ARROW_CODES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * Shortcuts that one family spells differently from the other -- the ones a
 * straight modifier swap (Command <-> Control, done by
 * mapRemoteDesktopKeyboardEvent) gets wrong. Returns the chords to tap on the
 * target, or null when the event should travel as itself.
 *
 * Mac controller -> Windows/Linux target:
 *   Command+Left/Right -> Home/End, Command+Up/Down -> Control+Home/End,
 *   Option+arrows -> Control+arrows (by word/paragraph), Option+Backspace/
 *   Delete -> Control+Backspace/Delete, Command+Backspace/Delete -> delete to
 *   the start/end of the line, Command+Shift+[/] and Command+Option+Left/Right
 *   -> Control+PageUp/PageDown (previous/next tab), and Command+Shift+Z ->
 *   Control+Y on Windows (Linux apps take Control+Shift+Z themselves).
 * Windows/Linux controller -> Mac target: the reverse -- Home/End,
 *   Control+Home/End, Control+arrows, Control+Backspace/Delete, Control+Y and
 *   Control+PageUp/PageDown -- while Control+Tab, Control+Space, Control+H and
 *   Control+M stay Control: as Command they would switch apps, open
 *   Spotlight, hide the app or minimize the window.
 * Shift is carried over wherever it extends a selection.
 *
 * Deliberately NOT translated, because the same keys mean different things in
 * different apps: Command+[/] (browser back/forward, but outdent/indent in
 * editors) and Alt+Left/Right.
 */
export function translateRemoteDesktopShortcut(
  event: RemoteDesktopShortcutEventLike,
  platform = readControllerPlatform(),
  targetPlatform: RemoteDesktopTargetPlatform = null,
): readonly RemoteDesktopTranslatedChord[] | null {
  const controller = remoteDesktopControllerFamily(platform);
  const target = remoteDesktopTargetFamily(targetPlatform);
  if (controller === target) return null;
  const { code, ctrlKey: ctrl, altKey: alt, metaKey: meta, shiftKey: shift } = event;
  const selecting = (chord: RemoteDesktopChordKey[]): RemoteDesktopTranslatedChord => (
    shift ? [CHORD_SHIFT, ...chord] : chord
  );
  const arrow = ARROW_CODES.has(code);

  if (controller === 'apple') {
    const commandOnly = meta && !ctrl && !alt;
    const optionOnly = alt && !ctrl && !meta;
    const commandOption = meta && alt && !ctrl;
    if (commandOnly && code === 'ArrowLeft') return [selecting([chordKey('Home', 'Home')])];
    if (commandOnly && code === 'ArrowRight') return [selecting([chordKey('End', 'End')])];
    if (commandOnly && code === 'ArrowUp') return [selecting([CHORD_CONTROL, chordKey('Home', 'Home')])];
    if (commandOnly && code === 'ArrowDown') return [selecting([CHORD_CONTROL, chordKey('End', 'End')])];
    if (optionOnly && arrow) return [selecting([CHORD_CONTROL, chordKey(code, code)])];
    if (optionOnly && !shift && code === 'Backspace') return [[CHORD_CONTROL, chordKey('Backspace', 'Backspace')]];
    if (optionOnly && !shift && code === 'Delete') return [[CHORD_CONTROL, chordKey('Delete', 'Delete')]];
    if (commandOnly && !shift && code === 'Backspace') {
      return [[CHORD_SHIFT, chordKey('Home', 'Home')], [chordKey('Backspace', 'Backspace')]];
    }
    if (commandOnly && !shift && code === 'Delete') {
      return [[CHORD_SHIFT, chordKey('End', 'End')], [chordKey('Delete', 'Delete')]];
    }
    if ((commandOnly && shift && code === 'BracketLeft') || (commandOption && !shift && code === 'ArrowLeft')) {
      return [[CHORD_CONTROL, chordKey('PageUp', 'PageUp')]];
    }
    if ((commandOnly && shift && code === 'BracketRight') || (commandOption && !shift && code === 'ArrowRight')) {
      return [[CHORD_CONTROL, chordKey('PageDown', 'PageDown')]];
    }
    if (commandOnly && shift && code === 'KeyZ' && targetPlatform === 'windows') {
      return [[CHORD_CONTROL, chordKey('KeyY', 'y')]];
    }
    return null;
  }

  const plain = !ctrl && !alt && !meta;
  const controlOnly = ctrl && !alt && !meta;
  if (plain && code === 'Home') return [selecting([CHORD_COMMAND, chordKey('ArrowLeft', 'ArrowLeft')])];
  if (plain && code === 'End') return [selecting([CHORD_COMMAND, chordKey('ArrowRight', 'ArrowRight')])];
  if (controlOnly && code === 'Home') return [selecting([CHORD_COMMAND, chordKey('ArrowUp', 'ArrowUp')])];
  if (controlOnly && code === 'End') return [selecting([CHORD_COMMAND, chordKey('ArrowDown', 'ArrowDown')])];
  if (controlOnly && arrow) return [selecting([CHORD_ALT, chordKey(code, code)])];
  if (controlOnly && !shift && code === 'Backspace') return [[CHORD_ALT, chordKey('Backspace', 'Backspace')]];
  if (controlOnly && !shift && code === 'Delete') return [[CHORD_ALT, chordKey('Delete', 'Delete')]];
  if (controlOnly && !shift && code === 'KeyY') return [[CHORD_COMMAND, CHORD_SHIFT, chordKey('KeyZ', 'z')]];
  if (controlOnly && !shift && code === 'PageUp') return [[CHORD_COMMAND, CHORD_SHIFT, chordKey('BracketLeft', '[')]];
  if (controlOnly && !shift && code === 'PageDown') return [[CHORD_COMMAND, CHORD_SHIFT, chordKey('BracketRight', ']')]];
  if (controlOnly && code === 'Tab') return [selecting([CHORD_CONTROL, chordKey('Tab', 'Tab')])];
  if (controlOnly && !shift && code === 'Space') return [[CHORD_CONTROL, chordKey('Space', ' ')]];
  if (controlOnly && !shift && code === 'KeyH') return [[CHORD_CONTROL, chordKey('KeyH', 'h')]];
  if (controlOnly && !shift && code === 'KeyM') return [[CHORD_CONTROL, chordKey('KeyM', 'm')]];
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
  /**
   * The key's value needs Shift held: `key` is the shifted glyph (`!`, `@`,
   * `{`...) and `code` is the physical key it sits on. Tapping it sends Shift
   * plus that key -- what a real keyboard sends -- rather than the bare key.
   */
  shifted?: boolean;
  /** What the cap reads when that differs from what the key is called elsewhere. */
  label?: string;
  /**
   * The character this key types with Shift held (`!` over `1`...). The cap
   * draws it small in its corner, and swiping up on the key sends it -- the
   * same Shift-plus-key a real keyboard produces -- so the symbols are one
   * gesture away without a separate page or a taller key.
   */
  upper?: string;
}

/** Shift-layer glyph of each number / punctuation key on a standard US keyboard. */
const SHIFT_LAYER_GLYPHS: Readonly<Record<string, string>> = {
  Digit1: '!', Digit2: '@', Digit3: '#', Digit4: '$', Digit5: '%',
  Digit6: '^', Digit7: '&', Digit8: '*', Digit9: '(', Digit0: ')',
  Minus: '_', Equal: '+', BracketLeft: '{', BracketRight: '}', Backslash: '|',
  Semicolon: ':', Quote: '"', Comma: '<', Period: '>', Slash: '?',
};

/**
 * The key an upward swipe on `spec` sends: its shift-layer character on the
 * same physical key, or null when the key has none.
 */
export function remoteDesktopComputerUpperKey(
  spec: RemoteDesktopComputerKeySpec,
): RemoteDesktopComputerKeySpec | null {
  if (!spec.upper) return null;
  return { code: spec.code, key: spec.upper, modifier: false, shifted: true };
}

const modKey = (code: string, key: string): RemoteDesktopComputerKeySpec => ({ code, key, modifier: true });
const plainKey = (code: string, key: string): RemoteDesktopComputerKeySpec => {
  const upper = SHIFT_LAYER_GLYPHS[code];
  return upper === undefined ? { code, key, modifier: false } : { code, key, modifier: false, upper };
};
const shiftedKey = (code: string, key: string): RemoteDesktopComputerKeySpec => ({ code, key, modifier: false, shifted: true });

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
 * The letters page's case key. Not a key sent to the remote: it switches the
 * page between lowercase and capitals, and a capital goes out as Shift plus
 * the letter -- what a real keyboard sends -- so it never depends on, or
 * changes, the remote's own Caps Lock.
 */
export const REMOTE_DESKTOP_COMPUTER_CASE_KEY = plainKey('CaseToggle', 'CaseToggle');

/** Whether a computer-keyboard key is one of the 26 letters. */
export function isRemoteDesktopComputerLetterKey(spec: RemoteDesktopComputerKeySpec): boolean {
  return /^Key[A-Z]$/.test(spec.code);
}

/** A special-character key: Shift held, and the glyph itself as the value. */
export function remoteDesktopComputerShiftedChord(
  spec: RemoteDesktopComputerKeySpec,
): readonly RemoteDesktopChordKey[] {
  return [{ code: 'ShiftLeft', key: 'Shift' }, { code: spec.code, key: spec.key }];
}

/**
 * What one tap on a computer-keyboard key sends: Shift plus the key for a
 * special character, Shift plus the capital for a letter while the letters
 * page is on capitals, otherwise the bare key. The chord is the same whether
 * it fires alone or as the last step of a combo.
 */
export function remoteDesktopComputerKeyChord(
  spec: RemoteDesktopComputerKeySpec,
  capital = false,
): readonly RemoteDesktopChordKey[] {
  if (spec.shifted) return remoteDesktopComputerShiftedChord(spec);
  if (capital && isRemoteDesktopComputerLetterKey(spec)) return remoteDesktopComputerCapitalChord(spec);
  return [{ code: spec.code, key: spec.key }];
}

/** The letter key as a capital: Shift held, and the capital as its value. */
export function remoteDesktopComputerCapitalChord(
  spec: RemoteDesktopComputerKeySpec,
): readonly RemoteDesktopChordKey[] {
  return [{ code: 'ShiftLeft', key: 'Shift' }, { code: spec.code, key: spec.key.toUpperCase() }];
}

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
  [REMOTE_DESKTOP_COMPUTER_CASE_KEY, ...BOTTOM_ROW_LETTERS.split('').map(letterKey), plainKey('Space', ' '), plainKey('Enter', 'Enter')],
];

/**
 * Third computer-keyboard page: the special characters. Every symbol that
 * sits on a number or punctuation key behind Shift, plus the backtick, so
 * nothing printable is out of reach of this keyboard -- the IME tab would
 * need the operator to hunt through the phone's own symbol pages for them,
 * and the letters page only carries the unshifted punctuation. Space,
 * Backspace and Return ride along so a whole string of symbols can be typed
 * without swiping back.
 */
export const REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE3: readonly (readonly RemoteDesktopComputerKeySpec[])[] = [
  [
    shiftedKey('Digit1', '!'), shiftedKey('Digit2', '@'), shiftedKey('Digit3', '#'),
    shiftedKey('Digit4', '$'), shiftedKey('Digit5', '%'), shiftedKey('Digit6', '^'),
    shiftedKey('Digit7', '&'), shiftedKey('Digit8', '*'), shiftedKey('Digit9', '('),
    shiftedKey('Digit0', ')'),
  ],
  [
    shiftedKey('Minus', '_'), shiftedKey('Equal', '+'),
    shiftedKey('BracketLeft', '{'), shiftedKey('BracketRight', '}'),
    shiftedKey('Backslash', '|'),
    shiftedKey('Semicolon', ':'), shiftedKey('Quote', '"'),
    shiftedKey('Comma', '<'), shiftedKey('Period', '>'), shiftedKey('Slash', '?'),
  ],
  [
    shiftedKey('Backquote', '~'), { ...plainKey('Backquote', '`'), label: '`' },
    plainKey('Space', ' '), plainKey('Backspace', 'Backspace'), plainKey('Enter', 'Enter'),
  ],
];

/** Every computer-keyboard page, in swipe order. */
export const REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES: readonly (readonly (readonly RemoteDesktopComputerKeySpec[])[])[] = [
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE2,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_ROWS_PAGE3,
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
  capitals = false,
): string {
  if (spec.code === REMOTE_DESKTOP_COMPUTER_CASE_KEY.code) return '⇧';
  // A special character reads as the glyph it types, not the key it sits on.
  if (spec.label !== undefined) return spec.label;
  if (spec.shifted) return spec.key;
  if (isRemoteDesktopComputerLetterKey(spec)) return capitals ? spec.key.toUpperCase() : spec.key.toLowerCase();
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
