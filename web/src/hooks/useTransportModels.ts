import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { WsClient } from '../ws-client.js';
import {
  CODEBUDDY_CHINA_DEFAULT_MODEL,
  CODEBUDDY_CHINA_MODEL_FALLBACK,
  CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK,
  CODEBUDDY_PROVIDER_IDS,
  isCodeBuddyProviderId,
} from '@shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '@shared/hermes-agent.js';
import {
  AGY_DEFAULT_MODEL_ID,
  AGY_FALLBACK_MODEL_IDS,
  AGY_SDK_PROVIDER_ID,
} from '@shared/agy-agent.js';
import {
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  GEMINI_MODEL_IDS,
  MUSE_MODEL_IDS,
} from '../../../src/shared/models/options.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE } from '@shared/agent-types.js';

export interface TransportModelInfo {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  supportedEffortLevels?: import('@shared/effort-levels.js').TransportEffortLevel[];
}

export interface TransportModelState {
  models: TransportModelInfo[];
  defaultModel?: string;
  isAuthenticated?: boolean;
  loading: boolean;
  error?: string;
}

export interface CachedTransportModelCatalog {
  models: TransportModelInfo[];
  defaultModel?: string;
  isAuthenticated?: boolean;
}

const memoryModelCatalogCache = new Map<string, CachedTransportModelCatalog>();
const STORAGE_PREFIX = 'imcodes:transport-models:';

function getSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch { /* storage inaccessible */ }
  return null;
}

export function __clearTransportModelCacheForTests(): void {
  memoryModelCatalogCache.clear();
  const storage = getSessionStorage();
  if (storage) {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) storage.removeItem(k);
    } catch { /* ignore */ }
  }
}

export function getStaticFallbackModels(agentType: string | undefined | null): TransportModelState | null {
  if (!agentType) return null;
  if (agentType === AGY_SDK_PROVIDER_ID) {
    return {
      models: AGY_FALLBACK_MODEL_IDS.map((id) => ({ id })),
      defaultModel: AGY_DEFAULT_MODEL_ID,
      isAuthenticated: true,
      loading: false,
    };
  }
  if (agentType === 'gemini-sdk') {
    return {
      models: GEMINI_MODEL_IDS.map((id) => ({ id })),
      defaultModel: GEMINI_MODEL_IDS[0],
      isAuthenticated: true,
      loading: false,
    };
  }
  if (agentType === 'claude-code-sdk' || agentType === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) {
    return {
      models: CLAUDE_CODE_MODEL_IDS.map((id) => ({ id })),
      defaultModel: CLAUDE_CODE_MODEL_IDS[0],
      loading: false,
    };
  }
  if (agentType === 'codex-sdk') {
    return {
      models: CODEX_MODEL_IDS.map((id) => ({ id })),
      defaultModel: CODEX_MODEL_IDS[0],
      loading: false,
    };
  }
  if (agentType === 'muse-code-sdk') {
    return {
      models: MUSE_MODEL_IDS.map((id) => ({ id })),
      defaultModel: MUSE_MODEL_IDS[0],
      isAuthenticated: true,
      loading: false,
    };
  }
  if (agentType === CODEBUDDY_PROVIDER_IDS.CHINA) {
    return {
      models: CODEBUDDY_CHINA_MODEL_FALLBACK.map((id) => ({ id })),
      defaultModel: CODEBUDDY_CHINA_DEFAULT_MODEL,
      isAuthenticated: true,
      loading: false,
    };
  }
  if (agentType === CODEBUDDY_PROVIDER_IDS.INTERNATIONAL) {
    return {
      models: CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK.map((id) => ({ id })),
      defaultModel: CODEBUDDY_INTERNATIONAL_MODEL_FALLBACK[0],
      isAuthenticated: true,
      loading: false,
    };
  }
  return null;
}

function validTransportModels(value: unknown): TransportModelInfo[] {
  return Array.isArray(value)
    ? value.filter((model) => model && typeof model.id === 'string' && model.id.trim().length > 0)
    : [];
}

function normalizeCatalog(entry: CachedTransportModelCatalog | null | undefined, agentType?: string | null): CachedTransportModelCatalog | null {
  if (!entry) return null;
  const models = validTransportModels(entry.models);
  if (!models.length) return null;
  return {
    models,
    ...(typeof entry.defaultModel === 'string' ? { defaultModel: entry.defaultModel } : {}),
    ...(typeof entry.isAuthenticated === 'boolean' ? { isAuthenticated: entry.isAuthenticated } : {}),
    // Old stored catalogs can still carry the previous Antigravity default.
    // Model selections live in session settings, not this catalog default.
    ...(agentType === AGY_SDK_PROVIDER_ID && models.some((model) => model.id === AGY_DEFAULT_MODEL_ID)
      ? { defaultModel: AGY_DEFAULT_MODEL_ID }
      : {}),
  };
}

export function readCachedTransportModels(
  catalogIdentity: string,
  agentType?: string | null,
): CachedTransportModelCatalog | null {
  const storage = getSessionStorage();
  // Preserve exact-target precedence, then the existing same-provider cache.
  const keys = agentType ? [catalogIdentity, `\0${agentType}\0`] : [catalogIdentity];
  for (const key of keys) {
    // Entries enter this map only after normalization; renders get an O(1) hit.
    const cached = memoryModelCatalogCache.get(key);
    if (cached) return cached;
    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_PREFIX + key);
        const parsed = raw ? normalizeCatalog(JSON.parse(raw), agentType) : null;
        if (parsed) {
          memoryModelCatalogCache.set(key, parsed);
          return parsed;
        }
      } catch { /* corrupt or inaccessible storage: use the next cache or fallback */ }
    }
  }
  const fallback = getStaticFallbackModels(agentType);
  return fallback ? {
    models: fallback.models,
    defaultModel: fallback.defaultModel,
    isAuthenticated: fallback.isAuthenticated,
  } : null;
}

export function writeCachedTransportModels(
  catalogIdentity: string,
  agentType: string | undefined | null,
  entry: CachedTransportModelCatalog,
): void {
  const catalog = normalizeCatalog(entry, agentType);
  if (!catalog) return;
  memoryModelCatalogCache.set(catalogIdentity, catalog);
  if (agentType) {
    memoryModelCatalogCache.set(`\0${agentType}\0`, catalog);
  }
  const storage = getSessionStorage();
  if (storage) {
    try {
      const serialized = JSON.stringify(catalog);
      storage.setItem(STORAGE_PREFIX + catalogIdentity, serialized);
      if (agentType) {
        storage.setItem(STORAGE_PREFIX + `\0${agentType}\0`, serialized);
      }
    } catch { /* quota exceeded or storage disabled */ }
  }
}

/** Agent types that support dynamic model discovery via `transport.list_models`. */
export type TransportAgentTypeWithModels = 'claude-code-sdk' | typeof CLAUDE_CODE_CLI_SDK_AGENT_TYPE | 'copilot-sdk' | 'cursor-headless' | 'codex-sdk' | 'opencode-sdk' | 'gemini-sdk' | 'grok-sdk' | 'kimi-sdk' | 'muse-code-sdk' | typeof HERMES_AGENT_PROVIDER_ID | typeof AGY_SDK_PROVIDER_ID | 'deepseek-harness' | 'pi' | 'qwen' | typeof CODEBUDDY_PROVIDER_IDS.CHINA | typeof CODEBUDDY_PROVIDER_IDS.INTERNATIONAL;

export function supportsDynamicTransportModels(
  agentType: string | undefined | null,
): agentType is TransportAgentTypeWithModels {
  return agentType === 'claude-code-sdk' || agentType === CLAUDE_CODE_CLI_SDK_AGENT_TYPE || agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'codex-sdk' || agentType === 'opencode-sdk' || agentType === 'gemini-sdk' || agentType === 'grok-sdk' || agentType === 'kimi-sdk' || agentType === 'muse-code-sdk' || agentType === HERMES_AGENT_PROVIDER_ID || agentType === AGY_SDK_PROVIDER_ID || agentType === 'deepseek-harness' || agentType === 'pi' || agentType === 'qwen' || isCodeBuddyProviderId(agentType ?? undefined);
}

/** Fetch and cache the list of available models for a transport agent type.
 *
 *  The daemon has authoritative knowledge of what models the local CLIs / SDKs
 *  expose. Hardcoded suggestions drift; this hook keeps the picker in sync.
 *  The fetch is lazy: pass `undefined`/`null` for `agentType` to suspend it.
 */
export function useTransportModels(
  ws: WsClient | null,
  agentType: string | undefined | null,
  ccPreset?: string | null,
  sessionName?: string | null,
): TransportModelState & { refresh: () => void } {
  // Session scope is part of catalogue identity: the same preset name on two
  // shared owner machines can resolve to completely different providers and
  // model sets. Never retain one owner's entries while switching sessions.
  const catalogIdentity = `${sessionName?.trim() ?? ''}\0${agentType ?? ''}\0${ccPreset?.trim().toLowerCase() ?? ''}`;
  const [state, setState] = useState<TransportModelState>(() => {
    const cached = readCachedTransportModels(catalogIdentity, agentType);
    return {
      models: cached?.models ?? [],
      defaultModel: cached?.defaultModel,
      isAuthenticated: cached?.isAuthenticated,
      loading: false,
    };
  });
  const latestRequestId = useRef<string | null>(null);
  const acceptedReplySequence = useRef(0);
  const currentCatalogIdentity = useRef(catalogIdentity);
  const wsConnected = !!ws?.connected;

  const fetchModels = useCallback(
    (force: boolean) => {
      const providerChanged = currentCatalogIdentity.current !== catalogIdentity;
      currentCatalogIdentity.current = catalogIdentity;
      const cached = readCachedTransportModels(catalogIdentity, agentType);
      const retainCatalog = (loading: boolean, error?: string) => {
        setState((prev) => ({
          ...(!providerChanged && prev.models.length > 0 ? prev : {
            models: cached?.models ?? [],
            defaultModel: cached?.defaultModel,
            isAuthenticated: cached?.isAuthenticated,
          }),
          loading,
          error,
        }));
      };
      if (!supportsDynamicTransportModels(agentType)) {
        latestRequestId.current = null;
        setState({ models: [], loading: false });
        return;
      }
      // A refresh can race a disconnect. Keep this target's last good catalog
      // or static fallback; a socket failure is not an authoritative empty list.
      if (!ws || !ws.connected) {
        latestRequestId.current = null;
        retainCatalog(false);
        return;
      }
      // Queue-full responses can arrive synchronously inside the request call.
      // Subscribe before dispatch and do not overwrite a completed response
      // with loading:true after the request method returns.
      latestRequestId.current = null;
      const replySequenceBeforeDispatch = acceptedReplySequence.current;
      let requestId: string;
      try {
        const request = {
          agentType,
          ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
          ...(ccPreset?.trim() ? { ccPreset: ccPreset.trim() } : {}),
          ...(force ? { force: true } : {}),
        };
        // Component hosts and embedded clients may expose the narrower legacy
        // WsClient surface while they are upgraded independently. Keep model
        // discovery functional there, while the current WsClient owns the
        // production single-flight/rate-limit path.
        if (typeof ws.requestTransportModels === 'function') {
          requestId = ws.requestTransportModels(request);
        } else {
          requestId = `models-${Math.random().toString(36).slice(2)}-${Date.now()}`;
          ws.send({
            type: TRANSPORT_MSG.LIST_MODELS,
            requestId,
            ...request,
          });
        }
      } catch (err) {
        retainCatalog(false, err instanceof Error ? err.message : String(err));
        return;
      }
      latestRequestId.current = requestId;
      if (acceptedReplySequence.current === replySequenceBeforeDispatch) retainCatalog(true);
    },
    [ws, wsConnected, agentType, ccPreset, sessionName, catalogIdentity],
  );

  useEffect(() => {
    if (!ws) {
      fetchModels(false);
      return;
    }
    if (!supportsDynamicTransportModels(agentType)) {
      setState({ models: [], loading: false });
      latestRequestId.current = null;
      currentCatalogIdentity.current = catalogIdentity;
      return;
    }

    const unsub = ws.onMessage((msg) => {
      if (currentCatalogIdentity.current !== catalogIdentity) return;
      const raw = msg as unknown as Record<string, unknown>;
      if (raw.type === DAEMON_MSG.RECONNECTED) {
        fetchModels(false);
        return;
      }
      if (raw.type !== TRANSPORT_MSG.MODELS_RESPONSE) return;
      if (typeof raw.sessionName === 'string' && raw.sessionName !== (sessionName?.trim() ?? '')) return;
      const replyAgent = raw.agentType;
      if (replyAgent !== agentType) return;
      const replyPreset = typeof raw.ccPreset === 'string'
        ? raw.ccPreset.trim().toLowerCase()
        : '';
      if (replyPreset !== (ccPreset?.trim().toLowerCase() ?? '')) return;
      // Accept both single-cast (requestId-matched) and broadcast replies.
      const replyId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
      if (replyId && latestRequestId.current && replyId !== latestRequestId.current) return;
      acceptedReplySequence.current += 1;
      const catalog = normalizeCatalog({
        models: validTransportModels(raw.models),
        ...(typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
        ...(typeof raw.isAuthenticated === 'boolean' ? { isAuthenticated: raw.isAuthenticated } : {}),
      }, agentType);
      if (catalog) writeCachedTransportModels(catalogIdentity, agentType, catalog);
      setState((prev) => ({
        ...(catalog ?? prev),
        error: undefined,
        ...(!catalog && typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
        ...(typeof raw.isAuthenticated === 'boolean'
          ? { isAuthenticated: raw.isAuthenticated }
          : {}),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        loading: false,
      }));
    });

    // Grok, Hermes, Antigravity, and OpenCode require a live provider catalog
    // check on load: their models depend on the local binary/auth state and
    // must actively probe (`force: true`) so dynamic models and auth status are resolved.
    // DeepSeek Harness deliberately stays off this list: `dsh` resolves its
    // provider routes and model ids from its own `~/.dsh` config, so the
    // daemon's catalog is a constant empty list and a forced probe would only
    // spend a round trip to re-learn that. Its picker is free text, like Kimi.
    fetchModels(
      agentType === 'grok-sdk'
      || agentType === HERMES_AGENT_PROVIDER_ID
      || agentType === AGY_SDK_PROVIDER_ID
      || agentType === 'opencode-sdk',
    );
    return unsub;
  }, [ws, wsConnected, agentType, ccPreset, catalogIdentity, fetchModels]);

  return {
    ...state,
    refresh: () => fetchModels(true),
  };
}
