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
  commandAsControl: boolean;
}

export interface RemoteDesktopChordKey {
  code: string;
  key: string;
}

export const REMOTE_DESKTOP_MOBILE_SHORTCUTS = [
  { id: 'select_all', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyA', key: 'a' }] },
  { id: 'copy', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyC', key: 'c' }] },
  { id: 'paste', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyV', key: 'v' }] },
  { id: 'cut', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyX', key: 'x' }] },
  { id: 'find', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyF', key: 'f' }] },
  { id: 'undo', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyZ', key: 'z' }] },
  { id: 'redo', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyY', key: 'y' }] },
  { id: 'save', keys: [{ code: 'ControlLeft', key: 'Control' }, { code: 'KeyS', key: 's' }] },
  { id: 'switch_window', keys: [{ code: 'AltLeft', key: 'Alt' }, { code: 'Tab', key: 'Tab' }] },
  { id: 'escape', keys: [{ code: 'Escape', key: 'Escape' }] },
  { id: 'tab', keys: [{ code: 'Tab', key: 'Tab' }] },
  { id: 'enter', keys: [{ code: 'Enter', key: 'Enter' }] },
  { id: 'backspace', keys: [{ code: 'Backspace', key: 'Backspace' }] },
] as const satisfies readonly { id: string; keys: readonly RemoteDesktopChordKey[] }[];

export function remoteDesktopShortcutLabel(id: string): string {
  if (id === 'select_all') return 'Ctrl+A';
  if (id === 'copy') return 'Ctrl+C';
  if (id === 'paste') return 'Ctrl+V';
  if (id === 'cut') return 'Ctrl+X';
  if (id === 'find') return 'Ctrl+F';
  if (id === 'undo') return 'Ctrl+Z';
  if (id === 'redo') return 'Ctrl+Y';
  if (id === 'save') return 'Ctrl+S';
  if (id === 'switch_window') return 'Alt+Tab';
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
 * The controlled desktop is Windows. On an Apple controller, Command is the
 * user's primary shortcut modifier, so its physical left/right transitions
 * are represented as the corresponding Windows Control transitions. The
 * browser's local Meta/Windows key is never forwarded directly.
 */
export function mapRemoteDesktopKeyboardEvent(
  event: RemoteDesktopKeyboardEventLike,
  platform = readControllerPlatform(),
): RemoteDesktopMappedKey | null {
  const commandAsControl = isAppleControllerPlatform(platform);
  let code = event.code;
  let key = event.key;
  if (code === 'MetaLeft' || code === 'MetaRight') {
    if (!commandAsControl) return null;
    code = code === 'MetaLeft' ? 'ControlLeft' : 'ControlRight';
    key = 'Control';
  }
  return {
    code,
    key,
    modifiers: {
      control: event.ctrlKey || (commandAsControl && event.metaKey),
      alt: event.altKey,
    },
    commandAsControl,
  };
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
