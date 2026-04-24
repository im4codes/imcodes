import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
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
export type TransportAgentTypeWithModels = 'copilot-sdk' | 'cursor-headless' | 'codex-sdk';

export function supportsDynamicTransportModels(
  agentType: string | undefined | null,
): agentType is TransportAgentTypeWithModels {
  return agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'codex-sdk';
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

  const fetchModels = useCallback(
    (force: boolean) => {
      if (!ws || !supportsDynamicTransportModels(agentType)) {
        setState({ models: [], loading: false });
        return;
      }
      const requestId = `models-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      pendingRequestId.current = requestId;
      setState((prev) => ({ ...prev, loading: true, error: undefined }));
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
    [ws, agentType],
  );

  useEffect(() => {
    if (!ws) return;
    if (!supportsDynamicTransportModels(agentType)) {
      setState({ models: [], loading: false });
      pendingRequestId.current = null;
      return;
    }

    const unsub = ws.onMessage((msg) => {
      const raw = msg as unknown as Record<string, unknown>;
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

    fetchModels(false);
    return unsub;
  }, [ws, agentType, fetchModels]);

  return {
    ...state,
    refresh: () => fetchModels(true),
  };
}
