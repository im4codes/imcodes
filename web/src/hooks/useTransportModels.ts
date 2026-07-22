import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import type { WsClient } from '../ws-client.js';

export interface TransportModelInfo {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
}

export interface TransportModelState {
  models: TransportModelInfo[];
  defaultModel?: string;
  isAuthenticated?: boolean;
  loading: boolean;
  error?: string;
}

/** Agent types that support dynamic model discovery via `transport.list_models`. */
export type TransportAgentTypeWithModels = 'claude-code-sdk' | 'copilot-sdk' | 'cursor-headless' | 'codex-sdk' | 'opencode-sdk' | 'gemini-sdk' | 'grok-sdk' | 'kimi-sdk';

export function supportsDynamicTransportModels(
  agentType: string | undefined | null,
): agentType is TransportAgentTypeWithModels {
  return agentType === 'claude-code-sdk' || agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'codex-sdk' || agentType === 'opencode-sdk' || agentType === 'gemini-sdk' || agentType === 'grok-sdk' || agentType === 'kimi-sdk';
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
): TransportModelState & { refresh: () => void } {
  const [state, setState] = useState<TransportModelState>({ models: [], loading: false });
  const pendingRequestId = useRef<string | null>(null);
  const catalogAgentType = useRef<string | undefined | null>(agentType);
  const wsConnected = !!ws?.connected;

  const fetchModels = useCallback(
    (force: boolean) => {
      if (!ws || !wsConnected || !supportsDynamicTransportModels(agentType)) {
        setState({ models: [], loading: false });
        return;
      }
      const requestId = `models-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      pendingRequestId.current = requestId;
      // Clear only when the picker actually changes provider. Reconnects and
      // repeated refreshes for the same provider keep the last good catalog
      // visible until its replacement arrives.
      const providerChanged = catalogAgentType.current !== agentType;
      catalogAgentType.current = agentType;
      setState((prev) => providerChanged
        ? { models: [], loading: true }
        : { ...prev, loading: true, error: undefined });
      try {
        ws.send({
          type: 'transport.list_models',
          agentType,
          requestId,
          ...(force ? { force: true } : {}),
        });
      } catch (err) {
        setState({
          models: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [ws, wsConnected, agentType],
  );

  useEffect(() => {
    if (!ws) return;
    if (!supportsDynamicTransportModels(agentType)) {
      setState({ models: [], loading: false });
      pendingRequestId.current = null;
      catalogAgentType.current = agentType;
      return;
    }

    const unsub = ws.onMessage((msg) => {
      const raw = msg as unknown as Record<string, unknown>;
      if (raw.type === DAEMON_MSG.RECONNECTED) {
        fetchModels(false);
        return;
      }
      if (raw.type !== 'transport.models_response') return;
      const replyAgent = raw.agentType;
      if (replyAgent !== agentType) return;
      // Accept both single-cast (requestId-matched) and broadcast replies.
      const replyId = typeof raw.requestId === 'string' ? raw.requestId : undefined;
      if (replyId && pendingRequestId.current && replyId !== pendingRequestId.current) return;
      pendingRequestId.current = null;
      const models = Array.isArray(raw.models)
        ? (raw.models as TransportModelInfo[]).filter((m) => m && typeof m.id === 'string')
        : [];
      setState({
        models,
        ...(typeof raw.defaultModel === 'string' ? { defaultModel: raw.defaultModel } : {}),
        ...(typeof raw.isAuthenticated === 'boolean'
          ? { isAuthenticated: raw.isAuthenticated }
          : {}),
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        loading: false,
      });
    });

    // Grok and OpenCode have no safe hardcoded model roster. Their live
    // provider catalogs are the authoritative binary/authentication check, so
    // the first picker load must actively connect instead of asking for the
    // passive fallback (which is intentionally empty for these providers).
    if (wsConnected) fetchModels(agentType === 'grok-sdk' || agentType === 'opencode-sdk');
    return unsub;
  }, [ws, wsConnected, agentType, fetchModels]);

  return {
    ...state,
    refresh: () => fetchModels(true),
  };
}
