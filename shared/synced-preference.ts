/** Existing write-through preference envelope (whole-value last-write-wins). */
export interface SyncedPreferencePayload<T = unknown> {
  v: T;
  t: number;
}

/** Accept both historical JSON-string values and object values, never partial envelopes. */
export function parseSyncedPreference<T = unknown>(raw: unknown): SyncedPreferencePayload<T> | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, 'v')
      || typeof payload.t !== 'number' || !Number.isSafeInteger(payload.t) || payload.t < 0) return null;
    return { v: payload.v as T, t: payload.t };
  } catch {
    return null;
  }
}
