import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { LOCAL_PREVIEW_HISTORY_MAX } from '@shared/preview-types.js';

/**
 * Validator/normalizer for a single preview input field.
 *
 * Receives the raw user input and returns the canonical value that will be
 * BOTH stored in history and used as the dedup key, or `null` to reject the
 * input (it is not written to history). For the path field the caller's
 * validator MUST strip `preview_access_token` (via
 * `stripPreviewAccessTokenFromUpstreamPath`) before returning, so the access
 * token never lands in localStorage.
 */
export type PreviewInputValidator = (raw: string) => string | null;

/**
 * Browser-local MRU (most-recently-used first) history for one preview input
 * field (capability local-web-preview-input-history).
 *
 * - Port and path each get their OWN independent instance (own storageKey).
 * - Dedup key = the validator's normalized OUTPUT (not the raw input).
 * - Capacity is `LOCAL_PREVIEW_HISTORY_MAX`; the oldest entries are dropped.
 * - Commit (write) happens only when a preview is successfully created — never
 *   on every keystroke — so half-typed input never pollutes history.
 * - All localStorage access degrades silently (quota / private mode): history
 *   may be unavailable but preview creation is never blocked and never throws.
 *
 * Legacy single-value migration: pass `legacyKey` to fold an old single-value
 * localStorage entry (e.g. `imcodes_local_preview_port`) into the history as
 * its first item when no history list exists yet. The legacy key is removed
 * after migration so the single-value and history representations never
 * coexist.
 */
export function useLocalPreviewInputHistory(
  storageKey: string,
  validator: PreviewInputValidator,
  legacyKey?: string,
): {
  history: string[];
  /** Canonical first entry (most recent), or undefined when history is empty. */
  mostRecent: string | undefined;
  /** Record a successful input. No-op when the validator rejects the raw value. */
  commit: (raw: string) => void;
} {
  // Validator identity is treated as stable for the lifetime of the hook
  // (callers pass module-level or useCallback-wrapped functions). We capture it
  // in a ref so `commit` stays referentially stable across renders.
  const validatorRef = useRef(validator);
  validatorRef.current = validator;

  const [history, setHistory] = useState<string[]>(() =>
    readHistory(storageKey, legacyKey, validator),
  );

  const commit = useCallback((raw: string) => {
    const normalized = validatorRef.current(raw);
    if (normalized === null) return;
    setHistory((prev) => {
      const next = mergeMru(prev, normalized);
      // Referential equality short-circuit: if the MRU is unchanged (already
      // first), skip the state update AND the storage write.
      if (next === prev) return prev;
      writeHistory(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const mostRecent = useMemo(() => history[0], [history]);

  return { history, mostRecent, commit };
}

/**
 * Insert `value` at the front of an MRU list, removing any existing duplicate
 * and truncating to `LOCAL_PREVIEW_HISTORY_MAX`. Returns the SAME array
 * reference when the value is already first (no observable change), so callers
 * can skip redundant writes/re-renders.
 */
export function mergeMru(prev: string[], value: string): string[] {
  if (prev[0] === value) return prev;
  const next = [value, ...prev.filter((item) => item !== value)];
  if (next.length > LOCAL_PREVIEW_HISTORY_MAX) {
    next.length = LOCAL_PREVIEW_HISTORY_MAX;
  }
  return next;
}

function readHistory(
  storageKey: string,
  legacyKey: string | undefined,
  validator: PreviewInputValidator,
): string[] {
  let stored: string[] = [];
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Re-validate persisted entries so a normalization change (or a hand-
        // edited / corrupt store) cannot resurrect stale or invalid values.
        stored = sanitize(parsed, validator);
      }
    }
  } catch {
    stored = [];
  }

  // One-time legacy single-value migration: fold the old value in as history[0]
  // (validated), then remove the legacy key so the two representations never
  // coexist.
  if (legacyKey) {
    try {
      const legacyRaw = localStorage.getItem(legacyKey);
      if (legacyRaw !== null) {
        const legacyValue = validator(legacyRaw);
        if (legacyValue !== null) {
          stored = mergeMru(stored, legacyValue);
        }
        localStorage.removeItem(legacyKey);
        // Persist the merged result so the migration survives a reload even if
        // no new preview is created.
        writeHistory(storageKey, stored);
      }
    } catch {
      // Legacy migration is best-effort; ignore storage failures.
    }
  }

  return stored;
}

/** Drop non-string / invalid / duplicate entries, preserving order, capped. */
function sanitize(parsed: unknown[], validator: PreviewInputValidator): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const normalized = validator(item);
    if (normalized === null) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= LOCAL_PREVIEW_HISTORY_MAX) break;
  }
  return out;
}

function writeHistory(storageKey: string, history: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(history));
  } catch {
    // quota exceeded or private/incognito mode — degrade silently.
  }
}
