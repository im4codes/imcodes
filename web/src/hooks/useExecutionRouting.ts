/**
 * useExecutionRouting — web preference layer for dedicated execution clone routing.
 *
 * Splits the preference exactly like the shared contract does:
 *   - GLOBAL enabled flag + bounded limits under `EXECUTION_ROUTING_PREF_KEY`.
 *   - PER-PROJECT (server-namespaced) selected template session under
 *     `executionTemplatePrefKey(serverId)`.
 *
 * Both halves reuse the SharedResource-backed {@link usePref} cache (do NOT
 * introduce a second cache). The template pref key string itself embeds the
 * `serverId` scope, so the per-key SharedResource cache is already namespaced
 * per project — switching projects never serves a stale other-project template.
 *
 * Persisting/toggling here only writes the preference. It NEVER dispatches an
 * execution; launch sites read the resolved preference separately.
 */
import { usePref } from './usePref.js';
import {
  EXECUTION_ROUTING_PREF_KEY,
  executionTemplatePrefKey,
  defaultDedicatedExecutionRoutingPreference,
  parseDedicatedExecutionRoutingPreference,
  serializeDedicatedExecutionRoutingPreference,
  type DedicatedExecutionRoutingGlobalPreference,
} from '@shared/execution-clone.js';

/** Bounded limit fields surfaced read-only to callers (no `enabled`). */
export interface ExecutionRoutingLimits {
  maxParallelClones: number;
  maxQueuedClones: number;
  cloneHardTimeoutMs: number;
  cloneRetentionMs: number;
}

export interface UseExecutionRoutingResult {
  /** Global enabled flag (defaults to false when unset). */
  enabled: boolean;
  /** Per-project selected template session name, or null when none is set. */
  templateSessionName: string | null;
  /** Global bounded limits (always defined; defaults applied). */
  limits: ExecutionRoutingLimits;
  /** True once both backing preferences have resolved at least once. */
  loaded: boolean;
  /** Persist the global enabled flag (keeps existing limits). Never dispatches. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Persist the per-project template session. Pass null/'' to clear it.
   * Never dispatches an execution.
   */
  setTemplateSessionName: (name: string | null) => Promise<void>;
}

/** Parse a stored template value: a non-empty string, otherwise null. */
function parseTemplateSessionName(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/**
 * Read/write the dedicated execution routing preference.
 *
 * @param serverId Active project/server id. Namespaces the per-project template
 *   key; a missing id falls back to the shared `default` scope (mirrors the
 *   shared `executionTemplatePrefKey` helper).
 */
export function useExecutionRouting(serverId?: string | null): UseExecutionRoutingResult {
  const globalPref = usePref<DedicatedExecutionRoutingGlobalPreference>(EXECUTION_ROUTING_PREF_KEY, {
    parse: parseDedicatedExecutionRoutingPreference,
    serialize: serializeDedicatedExecutionRoutingPreference,
  });

  // The key embeds serverId, so the SharedResource cache is namespaced per
  // project automatically. Switching projects switches the cache entry.
  const templateKey = executionTemplatePrefKey(serverId);
  const templatePref = usePref<string>(templateKey, {
    parse: parseTemplateSessionName,
  });

  const global = globalPref.value ?? defaultDedicatedExecutionRoutingPreference();
  const limits: ExecutionRoutingLimits = {
    maxParallelClones: global.maxParallelClones,
    maxQueuedClones: global.maxQueuedClones,
    cloneHardTimeoutMs: global.cloneHardTimeoutMs,
    cloneRetentionMs: global.cloneRetentionMs,
  };

  const setEnabled = async (enabled: boolean): Promise<void> => {
    // Preserve existing limits; only flip enabled. Serializer re-clamps.
    const base = globalPref.value ?? defaultDedicatedExecutionRoutingPreference();
    await globalPref.save({ ...base, enabled });
  };

  const setTemplateSessionName = async (name: string | null): Promise<void> => {
    const next = name && name.trim().length > 0 ? name : '';
    await templatePref.save(next);
  };

  return {
    enabled: global.enabled,
    templateSessionName: templatePref.value ?? null,
    limits,
    loaded: globalPref.loaded && templatePref.loaded,
    setEnabled,
    setTemplateSessionName,
  };
}
