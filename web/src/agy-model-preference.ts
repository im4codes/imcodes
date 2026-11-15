export const AGY_MODEL_STORAGE_KEY = 'imcodes-agy-model';
const AGY_MODEL_SESSION_STORAGE_PREFIX = `${AGY_MODEL_STORAGE_KEY}:`;

function readStorageValue(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    const trimmed = value?.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; the daemon/session metadata remains authoritative.
  }
}

function getSessionPreferenceKey(sessionName: string | null | undefined): string | null {
  const trimmed = sessionName?.trim();
  return trimmed ? `${AGY_MODEL_SESSION_STORAGE_PREFIX}${trimmed}` : null;
}

export function loadAgyModelPreference(sessionName?: string | null): string | null {
  const sessionKey = getSessionPreferenceKey(sessionName);
  if (sessionKey) {
    const sessionValue = readStorageValue(sessionKey);
    if (sessionValue) return sessionValue;
  }
  return readStorageValue(AGY_MODEL_STORAGE_KEY);
}

export function saveAgyModelPreference(model: string, sessionName?: string | null): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  writeStorageValue(AGY_MODEL_STORAGE_KEY, trimmed);
  const sessionKey = getSessionPreferenceKey(sessionName);
  if (sessionKey) writeStorageValue(sessionKey, trimmed);
}
