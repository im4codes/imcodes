import {
  DEFAULT_REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES,
  REMOTE_DESKTOP_QUALITY_PRIORITY,
  isRemoteDesktopQualityPreference,
  type RemoteDesktopQualityMode,
  type RemoteDesktopQualityPreference,
} from '@shared/remote-desktop.js';

/**
 * The viewer's quality choice for one machine, remembered in this browser.
 * Per machine, because a 5K Mac on the LAN and a laptop behind a slow relay
 * want different settings from the same person.
 */
export const REMOTE_DESKTOP_QUALITY_STORAGE_KEY = 'imcodes.web.remote-desktop-quality.v1';

export interface RemoteDesktopQualityChoice {
  mode: RemoteDesktopQualityMode;
  /** Only meaningful for the custom mode; kept so switching back restores it. */
  custom: RemoteDesktopQualityPreference;
}

export const DEFAULT_CUSTOM_QUALITY_PREFERENCE: RemoteDesktopQualityPreference = Object.freeze({
  maxHeight: 1080,
  maxFps: 30,
  maxBitrateBps: 0,
  priority: REMOTE_DESKTOP_QUALITY_PRIORITY.BALANCED,
});

/**
 * Bitrate caps offered in the custom popover; 0 = no cap. The saved value
 * must be one of these so the select always shows what is in effect.
 */
export const REMOTE_DESKTOP_QUALITY_BITRATE_OPTIONS = [
  0, 1_000_000, 2_000_000, 4_000_000, 8_000_000, 12_000_000, 20_000_000, 30_000_000,
] as const;

export function defaultRemoteDesktopQualityChoice(): RemoteDesktopQualityChoice {
  return { mode: DEFAULT_REMOTE_DESKTOP_QUALITY_MODE, custom: { ...DEFAULT_CUSTOM_QUALITY_PREFERENCE } };
}

function isMode(value: unknown): value is RemoteDesktopQualityMode {
  return typeof value === 'string'
    && (Object.values(REMOTE_DESKTOP_QUALITY_MODE) as string[]).includes(value);
}

type StoredChoices = Record<string, RemoteDesktopQualityChoice>;

function readAll(storage: Pick<Storage, 'getItem'>): StoredChoices {
  try {
    const raw = storage.getItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { version?: unknown; machines?: unknown } | null;
    if (parsed?.version !== 1 || !parsed.machines || typeof parsed.machines !== 'object') return {};
    return parsed.machines as StoredChoices;
  } catch {
    return {};
  }
}

export function loadRemoteDesktopQualityChoice(
  machineId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): RemoteDesktopQualityChoice {
  const stored = readAll(storage)[machineId];
  if (!stored || !isMode(stored.mode)) return defaultRemoteDesktopQualityChoice();
  return {
    mode: stored.mode,
    custom: isRemoteDesktopQualityPreference(stored.custom)
      && (REMOTE_DESKTOP_QUALITY_BITRATE_OPTIONS as readonly number[]).includes(stored.custom.maxBitrateBps)
      ? { ...stored.custom }
      : { ...DEFAULT_CUSTOM_QUALITY_PREFERENCE },
  };
}

export function saveRemoteDesktopQualityChoice(
  machineId: string,
  choice: RemoteDesktopQualityChoice,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  try {
    const machines = readAll(storage);
    machines[machineId] = { mode: choice.mode, custom: { ...choice.custom } };
    storage.setItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY, JSON.stringify({ version: 1, machines }));
  } catch {
    // Local preference only; the choice still applies to this session.
  }
}

/** What the chosen mode means on the wire. */
export function resolveRemoteDesktopQualityPreference(
  choice: RemoteDesktopQualityChoice,
): RemoteDesktopQualityPreference {
  return choice.mode === REMOTE_DESKTOP_QUALITY_MODE.CUSTOM
    ? { ...choice.custom }
    : { ...REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES[choice.mode] };
}
