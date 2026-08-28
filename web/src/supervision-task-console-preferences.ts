export const SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY = 'rcc_supervision_task_console_preferences_v1';

export interface SupervisionTaskConsolePreferences {
  open: boolean;
  width: number;
}

export interface SupervisionTaskConsoleWidthBounds {
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
}

interface StoredSupervisionTaskConsolePreferences {
  version: 1;
  open: boolean;
  width: number;
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

function resolveBrowserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function clampSupervisionTaskConsolePreferenceWidth(
  width: number,
  bounds: SupervisionTaskConsoleWidthBounds,
): number {
  const minWidth = Math.round(bounds.minWidth);
  const maxWidth = Math.max(minWidth, Math.round(bounds.maxWidth));
  const fallback = Math.max(minWidth, Math.min(maxWidth, Math.round(bounds.defaultWidth)));
  if (!Number.isFinite(width)) return fallback;
  return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
}

function defaultPreferences(bounds: SupervisionTaskConsoleWidthBounds): SupervisionTaskConsolePreferences {
  return {
    open: false,
    width: clampSupervisionTaskConsolePreferenceWidth(bounds.defaultWidth, bounds),
  };
}

export function loadSupervisionTaskConsolePreferences(
  bounds: SupervisionTaskConsoleWidthBounds,
  storage: ReadableStorage | null = resolveBrowserStorage(),
): SupervisionTaskConsolePreferences {
  if (!storage) return defaultPreferences(bounds);
  try {
    const raw = storage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY);
    if (raw === null) return defaultPreferences(bounds);
    const parsed = JSON.parse(raw) as Partial<StoredSupervisionTaskConsolePreferences> | null;
    if (
      !parsed
      || parsed.version !== 1
      || typeof parsed.open !== 'boolean'
      || typeof parsed.width !== 'number'
    ) {
      return defaultPreferences(bounds);
    }
    return {
      open: parsed.open,
      width: clampSupervisionTaskConsolePreferenceWidth(parsed.width, bounds),
    };
  } catch {
    return defaultPreferences(bounds);
  }
}

export function saveSupervisionTaskConsolePreferences(
  preferences: SupervisionTaskConsolePreferences,
  bounds: SupervisionTaskConsoleWidthBounds,
  storage: WritableStorage | null = resolveBrowserStorage(),
): boolean {
  if (!storage) return false;
  const stored: StoredSupervisionTaskConsolePreferences = {
    version: 1,
    open: preferences.open,
    width: clampSupervisionTaskConsolePreferenceWidth(preferences.width, bounds),
  };
  try {
    storage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}
