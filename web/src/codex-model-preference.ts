export const CODEX_MODEL_STORAGE_KEY = 'imcodes-codex-model';

export function loadCodexModelPreference(): string | null {
  try {
    const value = localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
    const trimmed = value?.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export function saveCodexModelPreference(model: string): void {
  try {
    localStorage.setItem(CODEX_MODEL_STORAGE_KEY, model);
  } catch {
    // Ignore storage failures; the daemon/session metadata remains authoritative.
  }
}
