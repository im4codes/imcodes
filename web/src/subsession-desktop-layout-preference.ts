export const SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY = 'imcodes.web.subsession.desktop-layout.v1';
export const SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY = 'imcodes.web.subsession.desktop-dock-side.v1';

export const SUBSESSION_DESKTOP_LAYOUT = {
  HORIZONTAL: 'horizontal',
  VERTICAL: 'vertical',
} as const;

export type SubSessionDesktopLayout = typeof SUBSESSION_DESKTOP_LAYOUT[keyof typeof SUBSESSION_DESKTOP_LAYOUT];

export const SUBSESSION_DESKTOP_DOCK_SIDE = {
  LEFT: 'left',
  RIGHT: 'right',
} as const;

export type SubSessionDesktopDockSide = typeof SUBSESSION_DESKTOP_DOCK_SIDE[keyof typeof SUBSESSION_DESKTOP_DOCK_SIDE];

interface StoredSubSessionDesktopLayout {
  version: 1;
  layout: SubSessionDesktopLayout;
}

interface StoredSubSessionDesktopDockSide {
  version: 1;
  side: SubSessionDesktopDockSide;
}

function isSubSessionDesktopLayout(value: unknown): value is SubSessionDesktopLayout {
  return value === SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL || value === SUBSESSION_DESKTOP_LAYOUT.VERTICAL;
}

function isSubSessionDesktopDockSide(value: unknown): value is SubSessionDesktopDockSide {
  return value === SUBSESSION_DESKTOP_DOCK_SIDE.LEFT || value === SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT;
}

export function loadSubSessionDesktopLayout(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SubSessionDesktopLayout {
  try {
    const raw = storage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY);
    if (raw === null) return SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL;
    const value = JSON.parse(raw) as Partial<StoredSubSessionDesktopLayout> | null;
    if (value?.version === 1 && isSubSessionDesktopLayout(value.layout)) return value.layout;
  } catch {
    // Local preferences are fail-soft; an unavailable or corrupt store must not block the UI.
  }
  return SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL;
}

export function saveSubSessionDesktopLayout(
  layout: SubSessionDesktopLayout,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    const value: StoredSubSessionDesktopLayout = { version: 1, layout };
    storage.setItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Browser privacy modes and exhausted quotas are non-fatal for this local-only preference.
  }
}

export function loadSubSessionDesktopDockSide(
  storage: Pick<Storage, 'getItem'> = localStorage,
): SubSessionDesktopDockSide {
  try {
    const raw = storage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY);
    if (raw === null) return SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT;
    const value = JSON.parse(raw) as Partial<StoredSubSessionDesktopDockSide> | null;
    if (value?.version === 1 && isSubSessionDesktopDockSide(value.side)) return value.side;
  } catch {
    // Legacy, corrupt, and unavailable local stores all fail safely to the right.
  }
  return SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT;
}

export function saveSubSessionDesktopDockSide(
  side: SubSessionDesktopDockSide,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    const value: StoredSubSessionDesktopDockSide = { version: 1, side };
    storage.setItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Browser privacy modes and exhausted quotas are non-fatal for this local-only preference.
  }
}
