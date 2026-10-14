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
  if (agentType === 'claude-code-sdk') {
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

export function readCachedTransportModels(
  catalogIdentity: string,
  agentType?: string | null,
): CachedTransportModelCatalog | null {
  // 1. Direct memory hit
  const exact = memoryModelCatalogCache.get(catalogIdentity);
  if (exact && exact.models.length > 0) return exact;

  // 2. Exact match in sessionStorage
  const storage = getSessionStorage();
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_PREFIX + catalogIdentity);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedTransportModelCatalog;
        if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
          memoryModelCatalogCache.set(catalogIdentity, parsed);
          return parsed;
        }
      }
    } catch { /* ignore corrupt entry */ }
  }

  // 3. Fallback to generic agentType cache if switching sessions for the same provider
  if (agentType) {
    const genericKey = `\0${agentType}\0`;
    const genericCached = memoryModelCatalogCache.get(genericKey);
    if (genericCached && genericCached.models.length > 0) return genericCached;

    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_PREFIX + genericKey);
        if (raw) {
          const parsed = JSON.parse(raw) as CachedTransportModelCatalog;
          if (parsed && Array.isArray(parsed.models) && parsed.models.length > 0) {
            memoryModelCatalogCache.set(genericKey, parsed);
            return parsed;
          }
        }
      } catch { /* ignore */ }
    }

    // 4. Static fallback for known providers
    const staticFallback = getStaticFallbackModels(agentType);
    if (staticFallback && staticFallback.models.length > 0) {
      return {
        models: staticFallback.models,
        defaultModel: staticFallback.defaultModel,
        isAuthenticated: staticFallback.isAuthenticated,
      };
    }
  }

  return null;
}

export function writeCachedTransportModels(
  catalogIdentity: string,
  agentType: string | undefined | null,
  entry: CachedTransportModelCatalog,
): void {
  if (!entry.models.length) return;
  memoryModelCatalogCache.set(catalogIdentity, entry);
  if (agentType) {
    memoryModelCatalogCache.set(`\0${agentType}\0`, entry);
  }
  const storage = getSessionStorage();
  if (storage) {
    try {
      const serialized = JSON.stringify(entry);
      storage.setItem(STORAGE_PREFIX + catalogIdentity, serialized);
      if (agentType) {
        storage.setItem(STORAGE_PREFIX + `\0${agentType}\0`, serialized);
      }
    } catch { /* quota exceeded or storage disabled */ }
  }
}

/** Agent types that support dynamic model discovery via `transport.list_models`. */
export type TransportAgentTypeWithModels = 'claude-code-sdk' | 'copilot-sdk' | 'cursor-headless' | 'codex-sdk' | 'opencode-sdk' | 'gemini-sdk' | 'grok-sdk' | 'kimi-sdk' | 'muse-code-sdk' | typeof HERMES_AGENT_PROVIDER_ID | typeof AGY_SDK_PROVIDER_ID | 'deepseek-harness' | 'pi' | 'qwen' | typeof CODEBUDDY_PROVIDER_IDS.CHINA | typeof CODEBUDDY_PROVIDER_IDS.INTERNATIONAL;

export function supportsDynamicTransportModels(
  agentType: string | undefined | null,
): agentType is TransportAgentTypeWithModels {
  return agentType === 'claude-code-sdk' || agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'codex-sdk' || agentType === 'opencode-sdk' || agentType === 'gemini-sdk' || agentType === 'grok-sdk' || agentType === 'kimi-sdk' || agentType === 'muse-code-sdk' || agentType === HERMES_AGENT_PROVIDER_ID || agentType === AGY_SDK_PROVIDER_ID || agentType === 'deepseek-harness' || agentType === 'pi' || agentType === 'qwen' || isCodeBuddyProviderId(agentType ?? undefined);
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
  const initialCached = readCachedTransportModels(catalogIdentity, agentType);
  const [state, setState] = useState<TransportModelState>({
    models: initialCached?.models ?? [],
    defaultModel: initialCached?.defaultModel,
    isAuthenticated: initialCached?.isAuthenticated,
    loading: false,
  });
  const pendingRequestId = useRef<string | null>(null);
  const currentCatalogIdentity = useRef(catalogIdentity);
  const wsConnected = !!ws?.connected;

  const fetchModels = useCallback(
    (force: boolean) => {
      // Read the live socket flag at dispatch time. A daemon.reconnected event
      // can reach this handler before Preact has rendered the new `connected`
      // prop value; a closure over the previous false value would otherwise
      // discard the first authoritative participant catalogue after reconnect.
      if (!ws || !ws.connected || !supportsDynamicTransportModels(agentType)) {
        setState({ models: [], loading: false });
        return;
      }
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
        setState({
          models: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // When changing provider/identity, show the cached catalog for the new
      // target immediately (or static fallback) with loading: true. Reconnects
      // and repeated refreshes for the same provider keep the last good catalog
      // visible until its replacement arrives.
      const providerChanged = currentCatalogIdentity.current !== catalogIdentity;
      currentCatalogIdentity.current = catalogIdentity;
      if (providerChanged) {
        const cached = readCachedTransportModels(catalogIdentity, agentType);
        setState({
          models: cached?.models ?? [],
          defaultModel: cached?.defaultModel,
          isAuthenticated: cached?.isAuthenticated,
          loading: true,
          error: undefined,
        });
      } else {
        setState((prev) => ({ ...prev, loading: true, error: undefined }));
      }
    },
    [ws, wsConnected, agentType, ccPreset, sessionName, catalogIdentity],
  );

  useEffect(() => {
    if (!ws) return;
    if (!supportsDynamicTransportModels(agentType)) {
      setState({ models: [], loading: false });
      pendingRequestId.current = null;
      currentCatalogIdentity.current = catalogIdentity;
      return;
    }

    const unsub = ws.onMessage((msg) => {
      const raw = msg as unknown as Record<string, unknown>;
      if (raw.type === DAEMON_MSG.RECONNECTED) {
        fetchModels(false);
        return;
      }
      if (raw.type !== TRANSPORT_MSG.MODELS_RESPONSE) return;
      const replyAgent = raw.agentType;
      if (replyAgent !== agentType) return;
      const replyPreset = typeof raw.ccPreset === 'string'
        ? raw.ccPreset.trim().toLowerCase()
        : '';
      if (replyPreset !== (ccPreset?.trim().toLowerCase() ?? '')) return;
      // Accept both single-cast (requestId-matched) and broadcast replies.
      const replyId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
      if (replyId && pendingRequestId.current && replyId !== pendingRequestId.current) return;
      pendingRequestId.current = null;
      const models = Array.isArray(raw.models)
        ? (raw.models as TransportModelInfo[]).filter((m) => m && typeof m.id === 'string')
        : [];
      if (models.length > 0) {
        writeCachedTransportModels(catalogIdentity, agentType, {
          models,
          defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
          isAuthenticated: typeof raw.isAuthenticated === 'boolean' ? raw.isAuthenticated : undefined,
        });
      }
      setState((prev) => ({
        models: models.length > 0 ? models : prev.models,
        ...(typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
        ...(typeof raw.isAuthenticated === 'boolean'
          ? { isAuthenticated: raw.isAuthenticated }
          : {}),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        loading: false,
      }));
    });

    // Grok, Hermes, and OpenCode have no safe hardcoded model roster. Their live
    // provider catalogs are the authoritative binary/authentication check, so
    // the first picker load must actively connect instead of asking for the
    // passive fallback (which is intentionally empty for these providers).
    // DeepSeek Harness deliberately stays off this list: `dsh` resolves its
    // provider routes and model ids from its own `~/.dsh` config, so the
    // daemon's catalog is a constant empty list and a forced probe would only
    // spend a round trip to re-learn that. Its picker is free text, like Kimi.
    if (wsConnected) fetchModels(
      agentType === 'grok-sdk'
      || agentType === HERMES_AGENT_PROVIDER_ID
      || agentType === 'opencode-sdk',
    );
    return unsub;
  }, [ws, wsConnected, agentType, ccPreset, catalogIdentity, fetchModels]);

  return {
    ...state,
    refresh: () => fetchModels(true),
  };
}
