export const KEYBOARD_SHORTCUTS_PREF_KEY = 'keyboard_shortcuts_v1';
export const LEGACY_TAB_ORDER_STORAGE_KEY = 'rcc_tab_order';

export type ShortcutActionId = 'serverPrev' | 'serverNext' | 'tabPrev' | 'tabNext';

export const SHORTCUT_ACTION_IDS: readonly ShortcutActionId[] = [
  'serverPrev',
  'serverNext',
  'tabPrev',
  'tabNext',
];

export type ShortcutSlot = 'primary' | 'secondary';

export const SHORTCUT_SLOTS: readonly ShortcutSlot[] = ['primary', 'secondary'];

export interface KeyboardShortcutSlotPair {
  primary: string | null;
  secondary: string | null;
}

export type ResolvedKeyboardShortcutSlots = Record<ShortcutActionId, KeyboardShortcutSlotPair>;

export interface MatchedNavigationShortcut {
  action: ShortcutActionId;
  slot: ShortcutSlot;
  chord: string;
}

export interface ShortcutSlotTarget {
  action: ShortcutActionId;
  slot: ShortcutSlot;
}

export type ResolvedShortcutSlotConflicts = Partial<
  Record<ShortcutActionId, Partial<Record<ShortcutSlot, ShortcutSlotTarget[]>>>
>;

/**
 * Stored per-user overrides.
 * Top-level keys represent the primary slot for backward compatibility with `keyboard_shortcuts_v1`;
 * optional `secondary` stores per-action overrides for the secondary slot:
 * - `undefined` (key omitted): use active platform default
 * - `null`: explicitly cleared / disabled
 * - `string`: normalized canonical chord string, e.g. `Meta+ArrowUp`
 */
export type ShortcutModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta';
export const SHORTCUT_MODIFIER_KEYS: readonly ShortcutModifierKey[] = ['ctrl', 'alt', 'shift', 'meta'];
export const DEFAULT_SUBSESSION_QUICK_MODIFIERS: readonly ShortcutModifierKey[] = ['ctrl'];

export type KeyboardShortcutOverrides = Partial<Record<ShortcutActionId, string | null>> & {
  secondary?: Partial<Record<ShortcutActionId, string | null>>;
  subSessionQuickModifiers?: ShortcutModifierKey[];
};
export type ResolvedKeyboardShortcuts = Record<ShortcutActionId, string | null>;

export interface ParsedShortcutChord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const IGNORED_KEYS = new Set([
  'Control',
  'Meta',
  'Shift',
  'Alt',
  'AltGraph',
  'OS',
  'Super',
  'Hyper',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Process',
  'Dead',
  'Unidentified',
]);

const SPECIAL_KEY_ALIASES: Record<string, string> = {
  '+': 'Plus',
  plus: 'Plus',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

const NON_TYPING_NAVIGATION_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

const KEY_LABELS_MAC: Record<string, string> = {
  Plus: '+',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Enter: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

const KEY_LABELS_NON_MAC: Record<string, string> = {
  Plus: '+',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/** Detect macOS desktop platforms cleanly without false positives on Windows/Linux. */
export function isMacPlatform(nav?: {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}): boolean {
  const source = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!source) return false;
  const uaDataPlatform = (source as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '';
  const platform = source.platform ?? '';
  const userAgent = source.userAgent ?? '';
  if (uaDataPlatform) return /mac/i.test(uaDataPlatform);
  if (platform) return /mac/i.test(platform);
  return /Macintosh|Mac OS/i.test(userAgent);
}

/** Unified default primary shortcut map across all desktop platforms (`Alt+I/K/J/L`). */
export function getDefaultShortcuts(isMac = isMacPlatform()): Record<ShortcutActionId, string> {
  void isMac;
  return {
    serverPrev: 'Alt+i',
    serverNext: 'Alt+k',
    tabPrev: 'Alt+j',
    tabNext: 'Alt+l',
  };
}

/** Platform default secondary shortcut map (`Ctrl+W/S/A/D` on macOS; unbound on Windows/Linux). */
export function getDefaultSecondaryShortcuts(isMac = isMacPlatform()): Record<ShortcutActionId, string | null> {
  if (isMac) {
    return {
      serverPrev: 'Ctrl+w',
      serverNext: 'Ctrl+s',
      tabPrev: 'Ctrl+a',
      tabNext: 'Ctrl+d',
    };
  }
  return {
    serverPrev: null,
    serverNext: null,
    tabPrev: null,
    tabNext: null,
  };
}

/** Return the platform default chord (or null) for one `(action, slot)` pair. */
export function getDefaultShortcutForSlot(
  action: ShortcutActionId,
  slot: ShortcutSlot,
  isMac = isMacPlatform(),
): string | null {
  return slot === 'primary'
    ? getDefaultShortcuts(isMac)[action]
    : getDefaultSecondaryShortcuts(isMac)[action];
}

function isFunctionKeyName(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

export function isNonTypingNavigationKey(key: string): boolean {
  return NON_TYPING_NAVIGATION_KEYS.has(key);
}

/**
 * Unified supported-chord validity contract shared by interactive capture,
 * persisted-string parsing/sanitization, and event matching:
 * - Rejects Escape, modifier-only keys, and IME composition tokens.
 * - Requires at least one primary modifier (Meta/Ctrl/Alt), OR a non-typing
 *   navigation/function key (`Arrow*`, `Home`, `End`, `PageUp`, `PageDown`, `F1`–`F24`,
 *   with or without `Shift`).
 */
export function isSupportedShortcutChord(parsed: ParsedShortcutChord): boolean {
  if (!parsed.key || parsed.key === 'Escape' || IGNORED_KEYS.has(parsed.key)) {
    return false;
  }
  const hasPrimaryModifier = parsed.meta || parsed.ctrl || parsed.alt;
  if (hasPrimaryModifier) return true;
  return isFunctionKeyName(parsed.key) || isNonTypingNavigationKey(parsed.key);
}

function recoverPhysicalAltToken(code: string | undefined): string | null {
  if (!code) return null;
  const letterMatch = /^Key([A-Z])$/.exec(code);
  if (letterMatch) return letterMatch[1].toLowerCase();
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) return digitMatch[1];
  return null;
}

/** Normalize a raw KeyboardEvent `key` / `code` token into our canonical key name. */
export function normalizeKeyToken(rawKey: string, code?: string, altKey = false): string | null {
  if (!rawKey) return null;
  if (IGNORED_KEYS.has(rawKey)) {
    // On macOS / international layouts, Option/Alt+letter (e.g. Option+i) can emit `key === 'Dead'`;
    // still recover the physical ASCII letter/digit from `e.code` when Alt/Option is held.
    if (rawKey === 'Dead' && altKey) {
      return recoverPhysicalAltToken(code);
    }
    return null;
  }

  const lower = rawKey.toLowerCase();
  if (SPECIAL_KEY_ALIASES[lower]) {
    return SPECIAL_KEY_ALIASES[lower];
  }

  if (rawKey.trim() === '') return null;

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(rawKey)) {
    return rawKey.toUpperCase();
  }

  // On macOS Option+letter/digit (or non-Latin layouts under Alt) `e.key` can hold composed/non-ASCII glyphs;
  // recover the physical ASCII letter/digit from `e.code` when available.
  if (altKey) {
    const recovered = recoverPhysicalAltToken(code);
    if (recovered) return recovered;
  }

  if (rawKey.length === 1) {
    if (/[A-Za-z]/.test(rawKey)) return rawKey.toLowerCase();
    return rawKey;
  }

  return rawKey;
}

/** Serialize a parsed chord into canonical `Meta+Ctrl+Alt+Shift+<Key>` order. */
export function serializeShortcutChord(parsed: ParsedShortcutChord): string {
  const parts: string[] = [];
  if (parsed.meta) parts.push('Meta');
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.alt) parts.push('Alt');
  if (parsed.shift) parts.push('Shift');
  parts.push(parsed.key);
  return parts.join('+');
}

function splitShortcutChordParts(trimmed: string): string[] | null {
  if (trimmed === '+') return ['Plus'];
  if (trimmed.endsWith('++')) {
    const prefix = trimmed.slice(0, -2);
    if (!prefix) return null;
    const prefixParts = prefix.split('+').map((part) => part.trim());
    if (prefixParts.some((part) => part.length === 0)) return null;
    return [...prefixParts, 'Plus'];
  }
  const parts = trimmed.split('+').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return null;
  return parts;
}

/** Parse a stored shortcut string; returns null if empty, malformed, or unsupported. */
export function parseShortcutChord(
  chord: string | null | undefined,
  options: { requireSupported?: boolean } = {},
): ParsedShortcutChord | null {
  if (typeof chord !== 'string') return null;
  const trimmed = chord.trim();
  if (!trimmed) return null;

  const parts = splitShortcutChordParts(trimmed);
  if (!parts) return null;

  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;

  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    const low = token.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast || low === 'meta' || low === 'cmd' || low === 'command' || low === 'ctrl' || low === 'control' || low === 'alt' || low === 'option' || low === 'shift') {
      if (low === 'meta' || low === 'cmd' || low === 'command') { meta = true; continue; }
      if (low === 'ctrl' || low === 'control') { ctrl = true; continue; }
      if (low === 'alt' || low === 'option') { alt = true; continue; }
      if (low === 'shift') { shift = true; continue; }
      return null;
    }
    key = normalizeKeyToken(token);
  }

  if (!key || key === 'Escape') return null;
  const parsed: ParsedShortcutChord = { meta, ctrl, alt, shift, key };
  if (options.requireSupported !== false && !isSupportedShortcutChord(parsed)) {
    return null;
  }
  return parsed;
}

/** Canonicalize a persisted shortcut string, or return null if invalid/disabled. */
export function normalizeShortcutChordString(chord: string | null | undefined): string | null {
  const parsed = parseShortcutChord(chord);
  return parsed ? serializeShortcutChord(parsed) : null;
}

function sanitizeShortcutSlotMap(raw: unknown): Partial<Record<ShortcutActionId, string | null>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<Record<ShortcutActionId, string | null>> = {};
  for (const action of SHORTCUT_ACTION_IDS) {
    if (!(action in input)) continue;
    const val = input[action];
    if (val === null) {
      out[action] = null;
    } else if (typeof val === 'string') {
      const normalized = normalizeShortcutChordString(val);
      if (normalized) out[action] = normalized;
    }
  }
  return out;
}

/** Sanitize untrusted/persisted override objects into clean `KeyboardShortcutOverrides`. */
export function sanitizeShortcutOverrides(raw: unknown): KeyboardShortcutOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: KeyboardShortcutOverrides = sanitizeShortcutSlotMap(input);
  if ('secondary' in input) {
    const cleanSecondary = sanitizeShortcutSlotMap(input.secondary);
    if (Object.keys(cleanSecondary).length > 0) {
      out.secondary = cleanSecondary;
    }
  }
  if ('subSessionQuickModifiers' in input) {
    const cleanModifiers = sanitizeSubSessionQuickModifiers(input.subSessionQuickModifiers);
    if (cleanModifiers) {
      out.subSessionQuickModifiers = cleanModifiers;
    }
  }
  return out;
}

/** Apply or clear a single slot override while preserving explicit `null` when clearing a non-null default. */
export function applyShortcutSlotOverride(
  overrides: KeyboardShortcutOverrides | null | undefined,
  action: ShortcutActionId,
  slot: ShortcutSlot,
  chord: string | null,
  isMac = isMacPlatform(),
): KeyboardShortcutOverrides {
  const next = sanitizeShortcutOverrides(overrides);
  const normalizedChord = chord === null ? null : normalizeShortcutChordString(chord);
  if (chord !== null && normalizedChord === null) {
    return next;
  }
  const defaultChord = getDefaultShortcutForSlot(action, slot, isMac);

  if (slot === 'primary') {
    if (normalizedChord === defaultChord) {
      delete next[action];
    } else {
      next[action] = normalizedChord;
    }
    return next;
  }

  const nextSecondary = { ...(next.secondary ?? {}) };
  if (normalizedChord === defaultChord) {
    delete nextSecondary[action];
  } else {
    nextSecondary[action] = normalizedChord;
  }
  if (Object.keys(nextSecondary).length > 0) {
    next.secondary = nextSecondary;
  } else {
    delete next.secondary;
  }
  return next;
}

/** Merge user primary overrides over current platform defaults. */
export function resolveKeyboardShortcuts(
  overrides: KeyboardShortcutOverrides | null | undefined,
  isMac = isMacPlatform(),
): ResolvedKeyboardShortcuts {
  const defaults = getDefaultShortcuts(isMac);
  const clean = sanitizeShortcutOverrides(overrides);
  const resolved: ResolvedKeyboardShortcuts = { ...defaults };
  for (const action of SHORTCUT_ACTION_IDS) {
    if (action in clean) {
      resolved[action] = clean[action] ?? null;
    }
  }
  return resolved;
}

/** Merge user primary + secondary overrides over current platform defaults. */
export function resolveKeyboardShortcutSlots(
  overrides: KeyboardShortcutOverrides | null | undefined,
  isMac = isMacPlatform(),
): ResolvedKeyboardShortcutSlots {
  const primaryDefaults = getDefaultShortcuts(isMac);
  const secondaryDefaults = getDefaultSecondaryShortcuts(isMac);
  const clean = sanitizeShortcutOverrides(overrides);
  const cleanSecondary = clean.secondary ?? {};
  const resolved = {} as ResolvedKeyboardShortcutSlots;
  for (const action of SHORTCUT_ACTION_IDS) {
    resolved[action] = {
      primary: action in clean ? (clean[action] ?? null) : primaryDefaults[action],
      secondary: action in cleanSecondary ? (cleanSecondary[action] ?? null) : secondaryDefaults[action],
    };
  }
  return resolved;
}

/**
 * Capture a canonical shortcut chord from a `KeyboardEvent`.
 * - Returns `null` for bare modifiers, Escape, IME composition, or disallowed bare typing keys.
 * - Guarantees captured strings round-trip through `parseShortcutChord` and `sanitizeShortcutOverrides`.
 */
export function chordFromKeyboardEvent(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  options: { requireModifier?: boolean } = {},
): string | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const key = normalizeKeyToken(e.key, e.code, Boolean(e.altKey));
  if (!key || key === 'Escape') return null;

  const parsed: ParsedShortcutChord = {
    meta: Boolean(e.metaKey),
    ctrl: Boolean(e.ctrlKey),
    alt: Boolean(e.altKey),
    shift: Boolean(e.shiftKey),
    key,
  };

  const requireModifier = options.requireModifier !== false;
  if (requireModifier && !isSupportedShortcutChord(parsed)) {
    return null;
  }

  const serialized = serializeShortcutChord(parsed);
  // Enforce capture/parse/persistence round-trip invariant.
  const roundTripped = parseShortcutChord(serialized, { requireSupported: requireModifier });
  return roundTripped ? serializeShortcutChord(roundTripped) : null;
}

/** Exact modifier + key match against a canonical shortcut chord string. */
export function matchesShortcutChord(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  chord: string | null | undefined,
): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const parsed = parseShortcutChord(chord);
  if (!parsed) return false;
  const eventKey = normalizeKeyToken(e.key, e.code, Boolean(e.altKey));
  if (!eventKey) return false;
  return Boolean(e.metaKey) === parsed.meta
    && Boolean(e.ctrlKey) === parsed.ctrl
    && Boolean(e.altKey) === parsed.alt
    && Boolean(e.shiftKey) === parsed.shift
    && eventKey === parsed.key;
}

/** Return which navigation action + slot + chord (if any) matches the keyboard event (primary before secondary). */
export function matchNavigationShortcutBinding(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  resolvedSlots: ResolvedKeyboardShortcutSlots,
): MatchedNavigationShortcut | null {
  for (const slot of SHORTCUT_SLOTS) {
    for (const action of SHORTCUT_ACTION_IDS) {
      const chord = resolvedSlots[action][slot];
      if (chord && matchesShortcutChord(e, chord)) {
        return { action, slot, chord };
      }
    }
  }
  return null;
}

/** Return which navigation action (if any) matches the keyboard event. */
export function matchNavigationShortcutAction(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  resolved: ResolvedKeyboardShortcuts,
): ShortcutActionId | null {
  for (const action of SHORTCUT_ACTION_IDS) {
    if (matchesShortcutChord(e, resolved[action])) {
      return action;
    }
  }
  return null;
}

/** Detect duplicate shortcut assignments across all 8 `(action, slot)` bindings. */
export function findShortcutSlotConflicts(
  resolvedSlots: ResolvedKeyboardShortcutSlots,
): ResolvedShortcutSlotConflicts {
  const byChord = new Map<string, ShortcutSlotTarget[]>();
  for (const action of SHORTCUT_ACTION_IDS) {
    for (const slot of SHORTCUT_SLOTS) {
      const chord = resolvedSlots[action][slot];
      if (!chord) continue;
      const list = byChord.get(chord) ?? [];
      list.push({ action, slot });
      byChord.set(chord, list);
    }
  }
  const conflicts: ResolvedShortcutSlotConflicts = {};
  for (const group of byChord.values()) {
    if (group.length <= 1) continue;
    for (const item of group) {
      const others = group.filter((other) => !(other.action === item.action && other.slot === item.slot));
      if (others.length === 0) continue;
      conflicts[item.action] = {
        ...conflicts[item.action],
        [item.slot]: others,
      };
    }
  }
  return conflicts;
}

/** Detect duplicate shortcut assignments across actions. */
export function findShortcutConflicts(
  resolved: ResolvedKeyboardShortcuts,
): Partial<Record<ShortcutActionId, ShortcutActionId[]>> {
  const byChord = new Map<string, ShortcutActionId[]>();
  for (const action of SHORTCUT_ACTION_IDS) {
    const chord = resolved[action];
    if (!chord) continue;
    const list = byChord.get(chord) ?? [];
    list.push(action);
    byChord.set(chord, list);
  }
  const conflicts: Partial<Record<ShortcutActionId, ShortcutActionId[]>> = {};
  for (const group of byChord.values()) {
    if (group.length <= 1) continue;
    for (const action of group) {
      conflicts[action] = group.filter((other) => other !== action);
    }
  }
  return conflicts;
}

/** Format a canonical shortcut chord into crisp human-readable keycaps. */
export function formatShortcutKeycaps(chord: string | null | undefined, isMac = isMacPlatform()): string[] {
  const parsed = parseShortcutChord(chord);
  if (!parsed) return [];
  const caps: string[] = [];
  if (parsed.ctrl) caps.push(isMac ? '⌃' : 'Ctrl');
  if (parsed.alt) caps.push(isMac ? '⌥' : 'Alt');
  if (parsed.shift) caps.push(isMac ? '⇧' : 'Shift');
  if (parsed.meta) caps.push(isMac ? '⌘' : 'Win');
  const map = isMac ? KEY_LABELS_MAC : KEY_LABELS_NON_MAC;
  const keyLabel = map[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  caps.push(keyLabel);
  return caps;
}

export function readLegacyTabOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_TAB_ORDER_STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Shared visual tab sorting used by both `SessionTabs` and global `tabPrev`/`tabNext`
 * navigation so keyboard switching always follows the exact rendered tab order
 * (pinned tabs first in `tabOrder` sequence, then unpinned tabs in `tabOrder` sequence).
 */
export function sortSessionsByTabOrder<T extends { name: string }>(
  sessions: readonly T[],
  tabOrder: readonly string[],
  pinned: ReadonlySet<string>,
): T[] {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const name of tabOrder) {
    if (seen.has(name)) continue;
    const session = byName.get(name);
    if (!session) continue;
    seen.add(name);
    ordered.push(session);
  }
  for (const session of sessions) {
    if (seen.has(session.name)) continue;
    seen.add(session.name);
    ordered.push(session);
  }
  const pinnedArr = ordered.filter((s) => pinned.has(s.name));
  const unpinnedArr = ordered.filter((s) => !pinned.has(s.name));
  return [...pinnedArr, ...unpinnedArr];
}

/** Cycle forward (+1) or backward (-1) across an ordered ID list with clean wrap-around. */
export function cycleOrderedId(
  ids: readonly string[],
  currentId: string | null | undefined,
  direction: -1 | 1,
): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  const idx = currentId ? ids.indexOf(currentId) : -1;
  if (idx === -1) {
    return direction === 1 ? ids[0] : ids[ids.length - 1];
  }
  const nextIdx = (idx + direction + ids.length) % ids.length;
  return ids[nextIdx];
}

export function isComposerInputElement(el: Element | null | undefined): boolean {
  return Boolean(el && typeof (el as HTMLElement).closest === 'function' && (el as HTMLElement).closest('.controls-input'));
}

const BLOCKING_DIALOG_SELECTOR = '[aria-modal="true"], [role="dialog"]:not([aria-modal="false"]):not(.feature-announcement), [role="alertdialog"], .modal-overlay, .dialog-backdrop, .dialog-overlay';

function isBlockingDomContextForElement(el: Element | null): boolean {
  if (!el || typeof (el as HTMLElement).closest !== 'function') return false;
  const htmlEl = el as HTMLElement;
  if (htmlEl.closest('[data-shortcut-recording="true"]')) return true;
  if (htmlEl.closest(BLOCKING_DIALOG_SELECTOR)) return true;
  if (htmlEl.closest('.xterm, .xterm-helper-textarea')) return true;
  if (htmlEl.closest('.remote-desktop-canvas, .remote-desktop-panel, [data-remote-desktop-surface="true"]')) return true;
  return false;
}

function isDisallowedEditableOrFormElement(el: Element | null): boolean {
  if (!el) return false;
  const htmlEl = el as HTMLElement;
  // Composer input `.controls-input` is explicitly allowed for navigation shortcuts
  // because auto-focus places focus there by default.
  if (isComposerInputElement(htmlEl)) return false;
  const tag = htmlEl.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const contentEditableAttr = htmlEl.getAttribute?.('contenteditable');
  const contentEditableProp = htmlEl.contentEditable;
  if (
    htmlEl.isContentEditable
    || contentEditableAttr === 'true'
    || contentEditableAttr === ''
    || contentEditableAttr === 'plaintext-only'
    || contentEditableProp === 'true'
    || contentEditableProp === ''
    || contentEditableProp === 'plaintext-only'
  ) {
    return true;
  }
  if (typeof htmlEl.closest === 'function' && htmlEl.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], .cm-editor, .fb-editor-cm')) {
    return true;
  }
  return false;
}

export function hasDomBlockingOverlay(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  if (!doc) return false;
  return Boolean(
    doc.querySelector(`[data-shortcut-recording="true"], ${BLOCKING_DIALOG_SELECTOR}`),
  );
}

/**
 * Determine whether a global keyboard navigation shortcut (`serverPrev/Next`, `tabPrev/Next`)
 * should handle this event instead of deferring to forms, modals, shortcut recorders,
 * xterm terminals, or remote desktop capture.
 */
export function canHandleGlobalNavigationShortcut(
  target: EventTarget | null,
  activeElement: Element | null,
  options: {
    hasBlockingOverlay: boolean;
    isMobile: boolean;
    isComposing?: boolean;
    viewMode?: 'terminal' | 'chat';
  },
): boolean {
  if (options.isMobile || options.isComposing || options.hasBlockingOverlay) return false;
  if (options.viewMode === 'terminal') return false;

  const doc = (activeElement?.ownerDocument ?? (target instanceof Node ? target.ownerDocument : undefined))
    ?? (typeof document !== 'undefined' ? document : undefined);
  if (hasDomBlockingOverlay(doc)) return false;
  if (doc?.fullscreenElement?.closest?.('.remote-desktop-panel, [data-remote-desktop-surface="true"]')) {
    return false;
  }

  const targetEl = target instanceof Element ? target : null;
  if (isBlockingDomContextForElement(targetEl) || isBlockingDomContextForElement(activeElement)) {
    return false;
  }
  if (isDisallowedEditableOrFormElement(targetEl) || isDisallowedEditableOrFormElement(activeElement)) {
    return false;
  }
  return true;
}

/**
 * Authoritatively resolve whether keyboard handling (navigation shortcuts or key passthrough)
 * targets `'terminal'` or `'chat'`, preventing a focused terminal sub-session window from
 * ever falling back to the underlying main session's `'chat'` mode.
 */
export function resolveFocusedKeyboardViewMode(options: {
  target: EventTarget | null;
  activeElement: Element | null;
  focusedSubId: string | null;
  isFocusedSubOpen: boolean;
  focusedSubType?: string | null;
  focusedSubSessionName?: string | null;
  inputRefs: ReadonlyMap<string, Element>;
  fallbackMainViewMode: 'terminal' | 'chat';
  doc?: Document;
}): 'terminal' | 'chat' {
  const {
    target,
    activeElement,
    focusedSubId,
    isFocusedSubOpen,
    focusedSubType,
    focusedSubSessionName,
    inputRefs,
    fallbackMainViewMode,
  } = options;

  const targetEl = target instanceof Element ? target : null;
  const domSubWin = (typeof targetEl?.closest === 'function' ? targetEl.closest('.subsession-window') : null)
    ?? (typeof (activeElement as HTMLElement | null)?.closest === 'function' ? activeElement?.closest('.subsession-window') : null);
  const directMode = domSubWin?.getAttribute('data-view-mode');
  if (directMode === 'terminal' || directMode === 'chat') {
    return directMode;
  }

  if (focusedSubId && isFocusedSubOpen) {
    if (focusedSubType === 'shell' || focusedSubType === 'script') {
      return 'terminal';
    }
    const subEl = (focusedSubSessionName ? inputRefs.get(focusedSubSessionName) : undefined)
      ?? inputRefs.get(`deck_sub_${focusedSubId}`);
    const refMode = typeof (subEl as HTMLElement | null)?.closest === 'function'
      ? subEl?.closest('.subsession-window')?.getAttribute('data-view-mode')
      : null;
    if (refMode === 'terminal' || refMode === 'chat') {
      return refMode;
    }

    const doc = options.doc
      ?? (activeElement?.ownerDocument ?? (target instanceof Node ? target.ownerDocument : undefined))
      ?? (typeof document !== 'undefined' ? document : undefined);
    if (doc) {
      const subWindows = doc.querySelectorAll('.subsession-window');
      let activeFallback: 'terminal' | 'chat' | null = null;
      for (let i = 0; i < subWindows.length; i += 1) {
        const win = subWindows[i];
        const winMode = win.getAttribute('data-view-mode');
        if (winMode !== 'terminal' && winMode !== 'chat') continue;
        if (win.getAttribute('data-subsession-id') === focusedSubId) {
          return winMode;
        }
        if (win.classList.contains('subsession-window-active')) {
          activeFallback = winMode;
        }
      }
      if (activeFallback) return activeFallback;
    }

    // Never silently fall back to main-session chat when an open subwindow's mode could not be read.
    return 'terminal';
  }

  return fallbackMainViewMode;
}

/** Focus a contentEditable composer `.controls-input` without scrolling the viewport. */
export { focusComposerElement } from './util/composer-focus.js';

function normalizeModifierToken(raw: unknown): ShortcutModifierKey | null {
  if (typeof raw !== 'string') return null;
  switch (raw.trim().toLowerCase()) {
    case 'ctrl':
    case 'control':
      return 'ctrl';
    case 'alt':
    case 'option':
    case 'opt':
      return 'alt';
    case 'shift':
      return 'shift';
    case 'meta':
    case 'cmd':
    case 'command':
    case 'win':
    case 'super':
      return 'meta';
    default:
      return null;
  }
}

/** Return the default modifier combination (`Ctrl`) for sub-session digit shortcuts. */
export function getDefaultSubSessionQuickModifiers(): ShortcutModifierKey[] {
  return [...DEFAULT_SUBSESSION_QUICK_MODIFIERS];
}

/** Sanitize a candidate modifier list into canonical non-empty `ShortcutModifierKey[]` order, or `undefined`. */
export function sanitizeSubSessionQuickModifiers(raw: unknown): ShortcutModifierKey[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const present = new Set<ShortcutModifierKey>();
  for (const item of raw) {
    const normalized = normalizeModifierToken(item);
    if (normalized) present.add(normalized);
  }
  if (present.size === 0) return undefined;
  return SHORTCUT_MODIFIER_KEYS.filter((mod) => present.has(mod));
}

/** Check whether two modifier combinations represent the exact same modifier set. */
export function areSubSessionQuickModifiersEqual(
  a: readonly ShortcutModifierKey[],
  b: readonly ShortcutModifierKey[],
): boolean {
  const normA = sanitizeSubSessionQuickModifiers([...a]) ?? DEFAULT_SUBSESSION_QUICK_MODIFIERS;
  const normB = sanitizeSubSessionQuickModifiers([...b]) ?? DEFAULT_SUBSESSION_QUICK_MODIFIERS;
  return normA.length === normB.length && normA.every((mod, idx) => mod === normB[idx]);
}

/** Resolve active sub-session quick-shortcut modifiers from stored overrides (defaults to `['ctrl']`). */
export function resolveSubSessionQuickModifiers(
  overrides: KeyboardShortcutOverrides | null | undefined,
): ShortcutModifierKey[] {
  return sanitizeSubSessionQuickModifiers(overrides?.subSessionQuickModifiers) ?? getDefaultSubSessionQuickModifiers();
}

/** Update `subSessionQuickModifiers` on an override object, omitting it when back to default `['ctrl']`. */
export function applySubSessionQuickModifiers(
  overrides: KeyboardShortcutOverrides | null | undefined,
  modifiers: readonly ShortcutModifierKey[],
): KeyboardShortcutOverrides {
  const next = sanitizeShortcutOverrides(overrides);
  const clean = sanitizeSubSessionQuickModifiers([...modifiers]) ?? getDefaultSubSessionQuickModifiers();
  if (areSubSessionQuickModifiersEqual(clean, DEFAULT_SUBSESSION_QUICK_MODIFIERS)) {
    delete next.subSessionQuickModifiers;
  } else {
    next.subSessionQuickModifiers = clean;
  }
  return next;
}

/** Format sub-session quick-shortcut modifiers into platform keycaps. */
export function formatSubSessionQuickModifierKeycaps(
  modifiers: readonly ShortcutModifierKey[],
  isMac = isMacPlatform(),
): string[] {
  const resolved = sanitizeSubSessionQuickModifiers([...modifiers]) ?? DEFAULT_SUBSESSION_QUICK_MODIFIERS;
  const caps: string[] = [];
  for (const mod of resolved) {
    if (mod === 'ctrl') caps.push(isMac ? '⌃' : 'Ctrl');
    else if (mod === 'alt') caps.push(isMac ? '⌥' : 'Alt');
    else if (mod === 'shift') caps.push(isMac ? '⇧' : 'Shift');
    else if (mod === 'meta') caps.push(isMac ? '⌘' : 'Win');
  }
  return caps;
}

export type SubSessionQuickShortcutMatch =
  | { kind: 'open'; index: number }
  | { kind: 'closeAll' };

function extractDigitFromKeyboardEvent(
  e: Pick<KeyboardEvent, 'key' | 'code'>,
): number | null {
  if (typeof e.code === 'string' && e.code.length > 0) {
    const codeMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (codeMatch) return Number(codeMatch[1]);
  }
  if (typeof e.key === 'string' && /^[0-9]$/.test(e.key)) {
    return Number(e.key);
  }
  return null;
}

/**
 * Match `<Modifier> + 1..9` (open N-th sub-session) or `<Modifier> + 0` (close all sub-sessions)
 * against the user's configured modifier combination. Matches exact modifier sets and checks
 * `e.code` (`Digit0..9`, `Numpad0..9`) before `e.key` so Shift-modified combos still match digits.
 */
export function matchSubSessionQuickShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
    isComposing?: boolean;
    keyCode?: number;
  },
  modifiers: readonly ShortcutModifierKey[],
): SubSessionQuickShortcutMatch | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const resolved = sanitizeSubSessionQuickModifiers([...modifiers]) ?? DEFAULT_SUBSESSION_QUICK_MODIFIERS;
  const needCtrl = resolved.includes('ctrl');
  const needAlt = resolved.includes('alt');
  const needShift = resolved.includes('shift');
  const needMeta = resolved.includes('meta');
  if (
    Boolean(e.ctrlKey) !== needCtrl
    || Boolean(e.altKey) !== needAlt
    || Boolean(e.shiftKey) !== needShift
    || Boolean(e.metaKey) !== needMeta
  ) {
    return null;
  }
  const digit = extractDigitFromKeyboardEvent(e);
  if (digit === null) return null;
  if (digit === 0) return { kind: 'closeAll' };
  if (digit >= 1 && digit <= 9) return { kind: 'open', index: digit - 1 };
  return null;
}
