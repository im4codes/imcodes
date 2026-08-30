export const SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY = 'imcodes.web.subsession.desktop-layout.v1';

export const SUBSESSION_DESKTOP_LAYOUT = {
  HORIZONTAL: 'horizontal',
  VERTICAL: 'vertical',
} as const;

export type SubSessionDesktopLayout = typeof SUBSESSION_DESKTOP_LAYOUT[keyof typeof SUBSESSION_DESKTOP_LAYOUT];

interface StoredSubSessionDesktopLayout {
  version: 1;
  layout: SubSessionDesktopLayout;
}

function isSubSessionDesktopLayout(value: unknown): value is SubSessionDesktopLayout {
  return value === SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL || value === SUBSESSION_DESKTOP_LAYOUT.VERTICAL;
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
