import { resolveEffectiveSessionModel, type SessionModelMetadata } from '@shared/session-model.js';

export const CODEX_MODEL_STORAGE_KEY = 'imcodes-codex-model';
const CODEX_MODEL_SESSION_STORAGE_PREFIX = `${CODEX_MODEL_STORAGE_KEY}:`;

interface CodexPreferenceSession extends SessionModelMetadata {
  name?: string | null;
  sessionName?: string | null;
  agentType?: string | null;
  type?: string | null;
}

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
  return trimmed ? `${CODEX_MODEL_SESSION_STORAGE_PREFIX}${trimmed}` : null;
}

export function loadCodexModelPreference(sessionName?: string | null): string | null {
  const sessionKey = getSessionPreferenceKey(sessionName);
  if (sessionKey) {
    const sessionValue = readStorageValue(sessionKey);
    if (sessionValue) return sessionValue;
  }
  return readStorageValue(CODEX_MODEL_STORAGE_KEY);
}

export function saveCodexModelPreference(model: string, sessionName?: string | null): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  writeStorageValue(CODEX_MODEL_STORAGE_KEY, trimmed);
  const sessionKey = getSessionPreferenceKey(sessionName);
  if (sessionKey) writeStorageValue(sessionKey, trimmed);
}

/**
 * Legacy Codex SDK sessions created before model metadata was persisted can be
 * model-less even though the user selected a Codex model in the browser. Use
 * the saved browser preference only as a last-resort display/context fallback,
 * never to override confirmed session, detected, or usage model metadata.
 */
export function loadLegacyCodexModelPreferenceForModelessSession(
  session: CodexPreferenceSession | null | undefined,
  ...confirmedFallbacks: Array<string | null | undefined>
): string | null {
  if (!session) return null;
  const agentType = session.agentType ?? session.type;
  if (agentType !== 'codex-sdk') return null;
  if (resolveEffectiveSessionModel(session, ...confirmedFallbacks)) return null;
  return loadCodexModelPreference(session.name ?? session.sessionName ?? null);
}
