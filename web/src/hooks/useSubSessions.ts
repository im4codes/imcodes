/**
 * useSubSessions — loads sub-session list from PG, handles create/close,
 * and triggers daemon rebuild on connect.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import {
  listSubSessions,
  createSubSession as apiCreate,
  patchSubSession,
  type SubSessionData,
} from '../api.js';
import type { WsClient } from '../ws-client.js';
import { isRunningTimelineEvent } from '../timeline-running.js';
import { mergeTransportConfigPreservingSupervision } from '@shared/supervision-config.js';
import {
  buildTransportPendingSyncPatch,
  extractTransportPendingVersion,
  nextTransportQueueVersion,
  removeTransportPendingEntryForUserMessage,
} from '../transport-queue.js';
import { getSessionRuntimeType, isTransportSessionAgentType } from '@shared/agent-types.js';
import { getAutoSessionLabelPrefix } from '../agent-display.js';
import { EXECUTION_CLONE_KIND } from '@shared/execution-clone.js';

export interface SubSession extends SubSessionData {
  sessionName: string;
  /** runtime state from daemon */
  state: 'queued' | 'running' | 'idle' | 'stopped' | 'stopping' | 'error' | 'starting' | 'unknown';
  transportPendingMessages?: string[] | null;
  transportPendingMessageEntries?: import('../transport-queue.js').TransportPendingMessageEntry[] | null;
  queueEpoch?: string | null;
  queueAuthorityId?: string | null;
  failedMessageEntries?: import('../transport-queue.js').TransportPendingMessageEntry[] | null;
  /** Newest pending-queue version applied. Drops stale snapshots. */
  transportPendingMessageVersion?: number | null;
}

/**
 * True when a sub-session record is an ephemeral execution clone — identified by
 * its projected `executionCloneKind` discriminant (the canonical
 * {@link EXECUTION_CLONE_KIND} value) or, defensively, by carrying a
 * `parentRunId`. Execution clones must never render as flat top-level peers;
 * they are grouped under their parent run. See {@link SessionTree}.
 */
export function isExecutionCloneSubSession(
  sub: Pick<SubSessionData, 'executionCloneKind' | 'parentRunId'>,
): boolean {
  return sub.executionCloneKind === EXECUTION_CLONE_KIND || typeof sub.parentRunId === 'string';
}

function isCodexFamily(agentType: string | null | undefined): boolean {
  return agentType === 'codex' || agentType === 'codex-sdk';
}

function toSessionName(id: string): string {
  return `deck_sub_${id}`;
}

function mergeLoadedSubSession(s: SubSessionData, existing?: SubSession): SubSession {
  const base: SubSession = {
    ...s,
    runtimeType: s.runtimeType ?? getSessionRuntimeType(s.type),
    sessionName: toSessionName(s.id),
    state: 'unknown' as const,
  };
  if (!existing) return base;
  const preserveCodexDisplay = isCodexFamily(base.type);
  return {
    ...base,
    state: existing.state !== 'unknown' ? existing.state : base.state,
    transportPendingMessages: existing.transportPendingMessages ?? base.transportPendingMessages,
    transportPendingMessageEntries: existing.transportPendingMessageEntries ?? base.transportPendingMessageEntries,
    queueEpoch: existing.queueEpoch ?? base.queueEpoch,
    queueAuthorityId: existing.queueAuthorityId ?? base.queueAuthorityId,
    failedMessageEntries: existing.failedMessageEntries ?? base.failedMessageEntries,
    transportPendingMessageVersion: existing.transportPendingMessageVersion ?? base.transportPendingMessageVersion,
    ...(preserveCodexDisplay ? {
      codexAvailableModels: base.codexAvailableModels ?? existing.codexAvailableModels ?? null,
      requestedModel: base.requestedModel ?? existing.requestedModel ?? null,
      activeModel: base.activeModel ?? existing.activeModel ?? null,
      modelDisplay: base.modelDisplay ?? existing.modelDisplay ?? null,
      planLabel: base.planLabel ?? existing.planLabel ?? null,
      quotaLabel: base.quotaLabel ?? existing.quotaLabel ?? null,
      quotaUsageLabel: base.quotaUsageLabel ?? existing.quotaUsageLabel ?? null,
      quotaMeta: base.quotaMeta ?? existing.quotaMeta ?? null,
    } : {}),
  };
}

export function useSubSessions(
  serverId: string | null,
  ws: WsClient | null,
  connected: boolean,
  activeSession?: string | null,
  disableHttpLoad = false,
) {
  const [subSessions, setSubSessions] = useState<SubSession[]>([]);
  const [loadedServerId, setLoadedServerId] = useState<string | null>(null);
  const rebuiltRef = useRef(false);

  // A half-open WebSocket that gets healed by a ping/pong probe surfaces as a
  // `connected` event with reason `probe_recovered` — WITHOUT the app's
  // `connected` boolean ever flipping to false and back (only a real socket
  // `close` dispatches `disconnected`). Main sessions resync regardless because
  // app.tsx calls `requestSessionList()` directly on that event, but the
  // sub-session reload/rebuild effects below are keyed on the `connected`
  // boolean, so after a probe recovery they would never re-run — leaving each
  // sub-session's `state` stuck at whatever it was before the frontend went
  // away (e.g. a perpetual running pulse / sweep even though the agent has
  // since gone idle). Bump a nonce on probe recovery so the reload — and its
  // cascading rebuild → `subsession.sync` — re-fires and pulls fresh state.
  const [reconnectTick, setReconnectTick] = useState(0);
  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type === 'session.event' && msg.event === 'connected' && msg.reason === 'probe_recovered') {
        setReconnectTick((n) => n + 1);
      }
    });
  }, [ws]);

  // Load from PG — retries indefinitely with backoff until successful.
  // Re-triggers when serverId changes, the WS (re)connects, or a probe
  // recovery bumps `reconnectTick` (the API key / network may now be ready).
  const loadGenRef = useRef(0);
  const loadedGenRef = useRef(0);
  useEffect(() => {
    if (!serverId) { setSubSessions([]); setLoadedServerId(null); return; }
    if (disableHttpLoad) {
      const gen = ++loadGenRef.current;
      loadedGenRef.current = gen;
      setLoadedServerId(serverId);
      rebuiltRef.current = false;
      return;
    }
    if (!connected) {
      rebuiltRef.current = false;
      return;
    }
    rebuiltRef.current = false;
    const gen = ++loadGenRef.current;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function load() {
      if (gen !== loadGenRef.current) return; // stale
      listSubSessions(serverId!)
        .then((list) => {
          if (gen !== loadGenRef.current) return;
          console.warn(`[sub-sessions] loaded ${list.length} for server ${serverId}`);
          loadedGenRef.current = gen;
          setSubSessions((prev) => {
            const previousById = new Map(prev.map((existing) => [existing.id, existing] as const));
            return list.map((s) => mergeLoadedSubSession(s, previousById.get(s.id)));
          });
          setLoadedServerId(serverId);
        })
        .catch((err) => {
          if (gen !== loadGenRef.current) return;
          attempt++;
          // Backoff: 1s, 2s, 3s, then cap at 5s
          const delay = Math.min(attempt * 1000, 5000);
          console.warn(`[sub-sessions] load failed (attempt ${attempt}, retry in ${delay}ms):`, err);
          timer = setTimeout(load, delay);
        });
    }
    load();

    return () => { if (timer) clearTimeout(timer); };
  }, [serverId, connected, reconnectTick, disableHttpLoad]);

  const hydrateShared = useCallback((serverIdForShare: string, list: Array<{
    subSessionId: string;
    title: string;
    type: string;
    parentSessionName: string | null;
  }>) => {
    const now = Date.now();
    setSubSessions((prev) => {
      const previousById = new Map(prev.map((existing) => [existing.id, existing] as const));
      return list.map((item) => mergeLoadedSubSession({
        id: item.subSessionId,
        serverId: serverIdForShare,
        type: item.type,
        runtimeType: getSessionRuntimeType(item.type),
        providerId: getSessionRuntimeType(item.type) === 'transport' ? item.type : null,
        providerSessionId: null,
        shellBin: null,
        cwd: null,
        label: item.title,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        ccSessionId: null,
        geminiSessionId: null,
        parentSession: item.parentSessionName,
        description: null,
        ccPresetId: null,
      }, previousById.get(item.subSessionId)));
    });
    setLoadedServerId(serverIdForShare);
  }, []);

  // Rebuild all when daemon connects (once per connection)
  useEffect(() => {
    if (disableHttpLoad) return;
    if (!connected || !ws || subSessions.length === 0 || rebuiltRef.current) return;
    if (loadedServerId !== serverId) return;
    if (loadedGenRef.current !== loadGenRef.current) return;
    rebuiltRef.current = true;
    ws.subSessionRebuildAll(subSessions.map((s) => ({
      id: s.id,
      type: s.type,
      runtimeType: s.runtimeType,
      providerId: s.providerId,
      providerSessionId: s.providerSessionId,
      shellBin: s.shellBin,
      cwd: s.cwd,
      ccSessionId: s.ccSessionId,
      geminiSessionId: s.geminiSessionId,
      parentSession: s.parentSession,
      label: s.label,
      ccPresetId: s.ccPresetId,
      requestedModel: s.requestedModel,
      activeModel: s.activeModel,
      effort: s.effort,
      transportConfig: s.transportConfig,
    })));
  }, [connected, ws, subSessions, disableHttpLoad, loadedServerId, serverId]);

  // Reset rebuild flag when disconnected
  useEffect(() => {
    if (!connected) rebuiltRef.current = false;
  }, [connected]);

  // Listen for session state changes to update sub-session state
  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      let sessionName: string | undefined;
      let state: string | undefined;

      // Sub-session created by daemon (e.g., discussion orchestrator)
      if (msg.type === 'subsession.created') {
        const m = msg as any;
        if (m.id) {
          setSubSessions((prev) => {
            // Update existing sub-session metadata (subsession.sync re-broadcasts arrive as subsession.created)
            const existingIdx = prev.findIndex((s) => s.id === m.id);
            if (existingIdx !== -1) {
              const updated = [...prev];
              const existing = updated[existingIdx];
              const preserveQuota = isCodexFamily(existing.type);
              const transportPendingPatch = buildTransportPendingSyncPatch(
                existing,
                m,
                existing.sessionName,
              );
              updated[existingIdx] = { ...updated[existingIdx],
                ...(m.state != null && { state: m.state as SubSession['state'] }),
                ...(m.cwd != null && { cwd: m.cwd }),
                ...(m.label != null && { label: m.label }),
                ...(m.ccPresetId !== undefined && { ccPresetId: m.ccPresetId }),
                ...(m.modelDisplay != null && { modelDisplay: m.modelDisplay }),
                ...(m.requestedModel !== undefined && { requestedModel: m.requestedModel }),
                ...(m.activeModel !== undefined && { activeModel: m.activeModel }),
                ...((m.planLabel != null || (!preserveQuota && m.planLabel === null)) ? { planLabel: m.planLabel } : {}),
                ...((m.quotaLabel != null || (!preserveQuota && m.quotaLabel === null)) ? { quotaLabel: m.quotaLabel } : {}),
                ...((m.quotaUsageLabel != null || (!preserveQuota && m.quotaUsageLabel === null)) ? { quotaUsageLabel: m.quotaUsageLabel } : {}),
                ...((m.quotaMeta != null || (!preserveQuota && m.quotaMeta === null)) ? { quotaMeta: m.quotaMeta } : {}),
                ...(m.effort != null && { effort: m.effort }),
                ...(m.contextNamespace !== undefined && { contextNamespace: m.contextNamespace }),
                ...(m.contextNamespaceDiagnostics !== undefined && { contextNamespaceDiagnostics: m.contextNamespaceDiagnostics }),
                ...(m.executionCloneKind !== undefined && { executionCloneKind: m.executionCloneKind }),
                ...(m.parentRunId !== undefined && { parentRunId: m.parentRunId }),
                ...(m.transportConfig !== undefined && {
                  transportConfig: mergeTransportConfigPreservingSupervision(
                    m.transportConfig,
                    updated[existingIdx].transportConfig,
                  ),
                }),
                ...transportPendingPatch,
                ...(m.qwenModel != null && { qwenModel: m.qwenModel }),
                ...(m.qwenAuthType != null && { qwenAuthType: m.qwenAuthType }),
                ...(m.qwenAvailableModels != null && { qwenAvailableModels: m.qwenAvailableModels }),
                ...((m.codexAvailableModels != null || (!preserveQuota && m.codexAvailableModels === null)) ? { codexAvailableModels: m.codexAvailableModels } : {}),
                updatedAt: Date.now(),
              };
              return updated;
            }
            const now = Date.now();
            const sessionNameForCreate = m.sessionName || `deck_sub_${m.id}`;
            const transportPendingPatch = buildTransportPendingSyncPatch({}, m, sessionNameForCreate);
            return [...prev, {
              id: m.id,
              serverId: '',
              type: m.sessionType || 'shell',
              sessionName: sessionNameForCreate,
              runtimeType: m.runtimeType ?? getSessionRuntimeType(m.sessionType || 'shell'),
              providerId: m.providerId ?? null,
              providerSessionId: m.providerSessionId ?? null,
              cwd: m.cwd || null,
              label: m.label || null,
              ccPresetId: m.ccPresetId ?? null,
              parentSession: m.parentSession || null,
              createdAt: now,
              updatedAt: now,
              state: (m.state || 'idle') as SubSession['state'],
              qwenModel: m.qwenModel ?? null,
              requestedModel: m.requestedModel ?? null,
              activeModel: m.activeModel ?? m.modelDisplay ?? null,
              qwenAuthType: m.qwenAuthType ?? null,
              qwenAvailableModels: m.qwenAvailableModels ?? null,
              codexAvailableModels: m.codexAvailableModels ?? null,
              modelDisplay: m.modelDisplay ?? null,
              planLabel: m.planLabel ?? null,
              quotaLabel: m.quotaLabel ?? null,
              quotaUsageLabel: m.quotaUsageLabel ?? null,
              quotaMeta: m.quotaMeta ?? null,
              effort: m.effort ?? null,
              contextNamespace: m.contextNamespace ?? null,
              contextNamespaceDiagnostics: m.contextNamespaceDiagnostics ?? null,
              executionCloneKind: m.executionCloneKind ?? null,
              parentRunId: m.parentRunId ?? null,
              transportConfig: m.transportConfig ?? null,
              ...transportPendingPatch,
            }];
          });
        }
        return;
      }

      // Sub-session removed by daemon (stopped/cleaned up server-side)
      if (msg.type === 'subsession.removed') {
        const removedId = (msg as any).id as string;
        if (removedId) {
          setSubSessions((prev) => prev.filter((s) => s.id !== removedId));
        }
        return;
      }

      // Sub-session metadata sync from daemon (start, restart, set_model, periodic refresh)
      if (msg.type === 'subsession.sync') {
        const m = msg as any;
        if (m.id) {
          setSubSessions((prev) => prev.map((s) => {
            if (s.id !== m.id) return s;
            const preserveQuota = isCodexFamily(s.type);
            const transportPendingPatch = buildTransportPendingSyncPatch(s, m, s.sessionName);
            return { ...s,
              ...(m.state ? { state: m.state as SubSession['state'] } : {}),
              ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
              ...(m.label !== undefined ? { label: m.label } : {}),
              ...(m.ccPresetId !== undefined ? { ccPresetId: m.ccPresetId } : {}),
              ...(m.qwenModel !== undefined ? { qwenModel: m.qwenModel } : {}),
              ...((m.codexAvailableModels != null || (!preserveQuota && m.codexAvailableModels === null)) ? { codexAvailableModels: m.codexAvailableModels } : {}),
              ...(m.requestedModel !== undefined ? { requestedModel: m.requestedModel } : {}),
              ...(m.activeModel !== undefined ? { activeModel: m.activeModel } : {}),
              ...(m.modelDisplay !== undefined ? { modelDisplay: m.modelDisplay } : {}),
              ...((m.planLabel != null || (!preserveQuota && m.planLabel === null)) ? { planLabel: m.planLabel } : {}),
              ...((m.quotaLabel != null || (!preserveQuota && m.quotaLabel === null)) ? { quotaLabel: m.quotaLabel } : {}),
              ...((m.quotaUsageLabel != null || (!preserveQuota && m.quotaUsageLabel === null)) ? { quotaUsageLabel: m.quotaUsageLabel } : {}),
              ...((m.quotaMeta != null || (!preserveQuota && m.quotaMeta === null)) ? { quotaMeta: m.quotaMeta } : {}),
              ...(m.effort !== undefined ? { effort: m.effort } : {}),
              ...(m.contextNamespace !== undefined ? { contextNamespace: m.contextNamespace } : {}),
              ...(m.contextNamespaceDiagnostics !== undefined ? { contextNamespaceDiagnostics: m.contextNamespaceDiagnostics } : {}),
              ...(m.executionCloneKind !== undefined ? { executionCloneKind: m.executionCloneKind } : {}),
              ...(m.parentRunId !== undefined ? { parentRunId: m.parentRunId } : {}),
              ...(m.transportConfig !== undefined ? {
                transportConfig: mergeTransportConfigPreservingSupervision(
                  m.transportConfig,
                  s.transportConfig,
                ),
              } : {}),
              ...transportPendingPatch,
            };
          }));
        }
        return;
      }

      if (msg.type === 'timeline.event') {
        const ev = msg.event;
        if (ev.type === 'user.message') {
          const subSessionName = ev.sessionId;
          if (!subSessionName || !subSessionName.startsWith('deck_sub_')) return;
          const incomingVersion = extractTransportPendingVersion(ev.payload.pendingMessageVersion);
          setSubSessions((prev) => {
            const idx = prev.findIndex((s) => s.sessionName === subSessionName);
            if (idx === -1) return prev;
            const nextQueue = removeTransportPendingEntryForUserMessage(
              prev[idx].transportPendingMessageEntries,
              prev[idx].transportPendingMessages,
              {
                clientMessageId: ev.payload.clientMessageId,
                commandId: ev.payload.commandId,
                text: ev.payload.text,
              },
              subSessionName,
            );
            const advancedVersion = nextTransportQueueVersion(prev[idx].transportPendingMessageVersion ?? undefined, incomingVersion);
            if (!nextQueue.changed) {
              if (advancedVersion === (prev[idx].transportPendingMessageVersion ?? undefined)) return prev;
              const nextSame = [...prev];
              nextSame[idx] = { ...nextSame[idx], transportPendingMessageVersion: advancedVersion };
              return nextSame;
            }
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              state: next[idx].state === 'queued' && nextQueue.messages.length === 0 ? 'running' : next[idx].state,
              transportPendingMessages: nextQueue.messages,
              transportPendingMessageEntries: nextQueue.entries,
              transportPendingMessageVersion: advancedVersion,
            };
            return next;
          });
          return;
        }
        if (ev.type === 'session.state') {
          state = String(ev.payload.state ?? '');
          sessionName = ev.sessionId;
        } else if (isRunningTimelineEvent(ev)) {
          state = 'running';
          sessionName = ev.sessionId;
        } else {
          return;
        }
      } else if (msg.type === 'session.idle') {
        state = 'idle';
        sessionName = msg.session as string | undefined;
      } else {
        return;
      }

      if (!sessionName || !sessionName.startsWith('deck_sub_')) return;
      if (state === 'queued' || state === 'running' || state === 'idle') {
        setSubSessions((prev) => {
          const idx = prev.findIndex((s) => s.sessionName === sessionName);
          if (idx === -1) return prev;
          const next = [...prev];
          const transportPendingPatch = msg.type === 'timeline.event' && msg.event.type === 'session.state'
            ? buildTransportPendingSyncPatch(prev[idx], msg.event.payload as Record<string, unknown>, sessionName)
            : {};
          next[idx] = {
            ...next[idx],
            state: state as SubSession['state'],
            ...transportPendingPatch,
          };
          return next;
        });
        return;
      }
      if (state !== 'idle' && state !== 'running' && state !== 'stopping' && state !== 'stopped' && state !== 'error') return;
      setSubSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionName === sessionName);
        if (idx === -1) return prev;
        if (
          prev[idx].state === state
        ) return prev;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          state: state as SubSession['state'],
        };
        return next;
      });
    });
  }, [ws]);

  const create = useCallback(async (
    type: string,
    shellBin?: string,
    cwd?: string,
    label?: string,
    extra?: Record<string, unknown>,
  ): Promise<SubSession | null> => {
    if (!serverId) return null;
    try {
      // Auto-generate label if not provided: agentType + incrementing number
      let effectiveLabel = label;
      if (!effectiveLabel) {
        const siblings = subSessions.filter((s) => s.parentSession === activeSession);
        const prefix = getAutoSessionLabelPrefix(type);
        let n = siblings.filter((s) => s.type === type).length + 1;
        effectiveLabel = `${prefix}${n}`;
        while (siblings.some((s) => s.label === effectiveLabel)) { n++; effectiveLabel = `${prefix}${n}`; }
      } else {
        // Prevent duplicate labels within the same parent session
        const siblings = subSessions.filter((s) => s.parentSession === activeSession);
        if (siblings.some((s) => s.label === effectiveLabel)) {
          let n = 2;
          while (siblings.some((s) => s.label === `${effectiveLabel}${n}`)) n++;
          effectiveLabel = `${effectiveLabel}${n}`;
        }
      }
      const ccSessionId = type === 'claude-code' ? crypto.randomUUID() : undefined;
      const description = extra?.description as string | undefined;
      const ccPresetId = extra?.ccPreset as string | undefined;
      const requestedModel = (extra?.requestedModel as string | undefined) ?? (extra?.model as string | undefined);
      const transportConfig = extra?.transportConfig as Record<string, unknown> | undefined;
      const res = await apiCreate(serverId, {
        type,
        shellBin,
        cwd,
        label: effectiveLabel,
        ccSessionId,
        parentSession: activeSession ?? null,
        description,
        ccPresetId,
        requestedModel: requestedModel ?? null,
        activeModel: requestedModel ?? null,
        effort: (extra?.thinking as SubSession['effort'] | undefined) ?? null,
        transportConfig: transportConfig ?? null,
      });
      const sub: SubSession = {
        ...res.subSession,
        sessionName: res.sessionName,
        runtimeType: res.subSession.runtimeType ?? getSessionRuntimeType(type),
        providerId: res.subSession.providerId ?? (getSessionRuntimeType(type) === 'transport' ? type : null),
        state: 'starting',
        requestedModel: res.subSession.requestedModel ?? requestedModel ?? null,
        activeModel: res.subSession.activeModel ?? requestedModel ?? null,
        effort: (extra?.thinking as SubSession['effort'] | undefined) ?? res.subSession.effort ?? null,
        transportConfig: res.subSession.transportConfig ?? transportConfig ?? null,
      };
      setSubSessions((prev) => [...prev, sub]);
      // Ask daemon to start it — transport providers may need extra fields
      // ALL transport agent types (qwen/openclaw/copilot-sdk/cursor-headless/
      // claude-code-sdk/codex-sdk) need the full subsession.start message so the
      // daemon receives transport fields (requestedModel, thinking/effort,
      // transportConfig, ccSessionId, etc.). Previously only qwen/openclaw used ws.send;
      // copilot-sdk/cursor-headless fell through to subSessionStart which omits those
      // fields, causing chat subscriptions to appear "stuck" (no model → no response).
      // Use `isTransportSessionAgentType(type)` as the primary guard (not && extra)
      // so that copilot/cursor work even when extra is falsy.
      if (isTransportSessionAgentType(type)) {
        ws?.send({
          type: 'subsession.start',
          id: sub.id,
          sessionType: type,
          cwd,
          ccSessionId,
          parentSession: activeSession,
          ...(extra ?? {}),
        });
      } else if (extra?.ccPreset || extra?.ccInitPrompt) {
        // Plain claude-code with preset — no transport provider but has CC extras
        ws?.send({
          type: 'subsession.start',
          id: sub.id,
          sessionType: type,
          cwd,
          ccSessionId,
          parentSession: activeSession,
          ...extra,
        });
      } else {
        ws?.subSessionStart(sub.id, type, shellBin, cwd, ccSessionId, activeSession);
      }
      return sub;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Sub-session create failed:', msg);
      alert(`Failed to create session: ${msg}`);
      return null;
    }
  }, [serverId, ws, activeSession, subSessions]);

  const close = useCallback(async (id: string) => {
    if (!serverId) return;
    const sub = subSessions.find((s) => s.id === id);
    if (!sub) return;
    // Stop the tmux session
    ws?.subSessionStop(sub.sessionName);
    // Keep the sub-session visible until daemon/server confirm successful close.
    setSubSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, state: 'stopping' } : s,
    ));
  }, [serverId, ws, subSessions]);

  const restart = useCallback(async (id: string) => {
    if (!serverId || !ws) return;
    const sub = subSessions.find((s) => s.id === id);
    if (!sub) return;
    // In-place restart: daemon kills and recreates with same ID/name.
    // PG record stays — no close + create cycle.
    ws.subSessionRestart(sub.sessionName);
    setSubSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, state: 'starting' } : s,
    ));
  }, [serverId, ws, subSessions]);

  const rename = useCallback(async (id: string, label: string) => {
    if (!serverId) return;
    await patchSubSession(serverId, id, { label }).catch(() => {});
    setSubSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, label } : s,
    ));
  }, [serverId]);

  /** Update local state for a sub-session (does NOT write to DB — caller handles that). */
  const updateLocal = useCallback((id: string, fields: Partial<Pick<SubSession, 'type' | 'runtimeType' | 'label' | 'description' | 'cwd' | 'transportConfig'>>) => {
    setSubSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, ...fields } : s,
    ));
  }, []);

  // Filter sub-sessions by active main session (show only those belonging to it).
  // Sub-sessions with no parentSession (null) are always visible — they were created
  // before the parentSession feature or from a context without an active session.
  const visibleSubSessions = useMemo(() =>
    activeSession
      ? subSessions.filter((s) => !s.parentSession || s.parentSession === activeSession)
      : subSessions,
    [subSessions, activeSession],
  );

  return { subSessions, visibleSubSessions, loadedServerId, create, close, restart, rename, updateLocal, hydrateShared };
}
