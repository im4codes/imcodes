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

export interface SubSession extends SubSessionData {
  sessionName: string;
  /** runtime state from daemon */
  state: 'running' | 'idle' | 'stopped' | 'starting' | 'unknown';
}

function toSessionName(id: string): string {
  return `deck_sub_${id}`;
}

export function useSubSessions(
  serverId: string | null,
  ws: WsClient | null,
  connected: boolean,
  activeSession?: string | null,
) {
  const [subSessions, setSubSessions] = useState<SubSession[]>([]);
  const [loadedServerId, setLoadedServerId] = useState<string | null>(null);
  const rebuiltRef = useRef(false);

  // Load from PG — retries indefinitely with backoff until successful.
  // Re-triggers when serverId changes or WS connection state changes (which
  // signals the API key / network may now be ready).
  const loadGenRef = useRef(0);
  const loadedGenRef = useRef(0);
  useEffect(() => {
    if (!serverId) { setSubSessions([]); setLoadedServerId(null); return; }
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
          setSubSessions(list.map((s) => ({
            ...s,
            sessionName: toSessionName(s.id),
            state: 'unknown' as const,
          })));
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
  }, [serverId, connected]);

  // Rebuild all when daemon connects (once per connection)
  useEffect(() => {
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
  }, [connected, ws, subSessions]);

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
              updated[existingIdx] = { ...updated[existingIdx],
                ...(m.state != null && { state: m.state as SubSession['state'] }),
                ...(m.cwd != null && { cwd: m.cwd }),
                ...(m.label != null && { label: m.label }),
                ...(m.modelDisplay != null && { modelDisplay: m.modelDisplay }),
                ...(m.requestedModel !== undefined && { requestedModel: m.requestedModel }),
                ...(m.activeModel !== undefined && { activeModel: m.activeModel }),
                ...(m.planLabel != null && { planLabel: m.planLabel }),
                ...(m.quotaLabel != null && { quotaLabel: m.quotaLabel }),
                ...(m.quotaUsageLabel != null && { quotaUsageLabel: m.quotaUsageLabel }),
                ...(m.quotaMeta !== undefined && { quotaMeta: m.quotaMeta }),
                ...(m.effort != null && { effort: m.effort }),
                ...(m.transportConfig !== undefined && { transportConfig: m.transportConfig }),
                ...(m.qwenModel != null && { qwenModel: m.qwenModel }),
                ...(m.qwenAuthType != null && { qwenAuthType: m.qwenAuthType }),
                ...(m.qwenAvailableModels != null && { qwenAvailableModels: m.qwenAvailableModels }),
                updatedAt: Date.now(),
              };
              return updated;
            }
            const now = Date.now();
            return [...prev, {
              id: m.id,
              serverId: '',
              type: m.sessionType || 'shell',
              sessionName: m.sessionName || `deck_sub_${m.id}`,
              runtimeType: m.runtimeType ?? (m.sessionType === 'qwen' || m.sessionType === 'openclaw' ? 'transport' : null),
              providerId: m.providerId ?? null,
              providerSessionId: m.providerSessionId ?? null,
              cwd: m.cwd || null,
              label: m.label || null,
              parentSession: m.parentSession || null,
              createdAt: now,
              updatedAt: now,
              state: (m.state || 'idle') as SubSession['state'],
              qwenModel: m.qwenModel ?? null,
              requestedModel: m.requestedModel ?? null,
              activeModel: m.activeModel ?? m.modelDisplay ?? null,
              qwenAuthType: m.qwenAuthType ?? null,
              qwenAvailableModels: m.qwenAvailableModels ?? null,
              modelDisplay: m.modelDisplay ?? null,
              planLabel: m.planLabel ?? null,
              quotaLabel: m.quotaLabel ?? null,
              quotaUsageLabel: m.quotaUsageLabel ?? null,
              quotaMeta: m.quotaMeta ?? null,
              effort: m.effort ?? null,
              transportConfig: m.transportConfig ?? null,
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
            return { ...s,
              ...(m.state ? { state: m.state as SubSession['state'] } : {}),
              ...(m.cwd !== undefined ? { cwd: m.cwd } : {}),
              ...(m.label !== undefined ? { label: m.label } : {}),
              ...(m.qwenModel !== undefined ? { qwenModel: m.qwenModel } : {}),
              ...(m.requestedModel !== undefined ? { requestedModel: m.requestedModel } : {}),
              ...(m.activeModel !== undefined ? { activeModel: m.activeModel } : {}),
              ...(m.modelDisplay !== undefined ? { modelDisplay: m.modelDisplay } : {}),
              ...(m.planLabel !== undefined ? { planLabel: m.planLabel } : {}),
              ...(m.quotaLabel !== undefined ? { quotaLabel: m.quotaLabel } : {}),
              ...(m.quotaUsageLabel !== undefined ? { quotaUsageLabel: m.quotaUsageLabel } : {}),
              ...(m.quotaMeta !== undefined ? { quotaMeta: m.quotaMeta } : {}),
              ...(m.effort !== undefined ? { effort: m.effort } : {}),
              ...(m.transportConfig !== undefined ? { transportConfig: m.transportConfig } : {}),
            };
          }));
        }
        return;
      }

      if (msg.type === 'timeline.event') {
        const ev = msg.event;
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
      if (state !== 'idle' && state !== 'running') return;
      setSubSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionName === sessionName);
        if (idx === -1) return prev;
        if (prev[idx].state === state) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], state: state as SubSession['state'] };
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
        const prefix = type === 'claude-code' ? 'CC' : type === 'codex' ? 'Cx' : type === 'gemini' ? 'Gm' : type === 'qwen' ? 'Qw' : type === 'openclaw' ? 'OC' : type;
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
        runtimeType: res.subSession.runtimeType ?? (type === 'openclaw' || type === 'qwen' ? 'transport' : 'process'),
        providerId: res.subSession.providerId ?? (type === 'openclaw' || type === 'qwen' ? type : null),
        state: 'starting',
        requestedModel: res.subSession.requestedModel ?? requestedModel ?? null,
        activeModel: res.subSession.activeModel ?? requestedModel ?? null,
        effort: (extra?.thinking as SubSession['effort'] | undefined) ?? res.subSession.effort ?? null,
        transportConfig: res.subSession.transportConfig ?? transportConfig ?? null,
      };
      setSubSessions((prev) => [...prev, sub]);
      // Ask daemon to start it — transport providers may need extra fields
      if ((type === 'openclaw' || type === 'qwen') && extra) {
        ws?.send({
          type: 'subsession.start',
          id: sub.id,
          sessionType: type,
          cwd,
          parentSession: activeSession,
          ...extra,
        });
      } else if (extra?.ccPreset || extra?.ccInitPrompt || extra?.thinking) {
        // CC with preset — send as raw message to include extra fields
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
  }, [serverId, ws, activeSession]);

  const close = useCallback(async (id: string) => {
    if (!serverId) return;
    const sub = subSessions.find((s) => s.id === id);
    if (!sub) return;
    // Stop the tmux session
    ws?.subSessionStop(sub.sessionName);
    // Mark closed in PG
    await patchSubSession(serverId, id, { closedAt: Date.now() }).catch(() => {});
    // Remove from local state
    setSubSessions((prev) => prev.filter((s) => s.id !== id));
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
    // Sync label to daemon session store
    const sessionName = `deck_sub_${id}`;
    ws?.subSessionRename(sessionName, label);
  }, [serverId, ws]);

  /** Update local state for a sub-session (does NOT write to DB — caller handles that). */
  const updateLocal = useCallback((id: string, fields: Partial<Pick<SubSession, 'label' | 'description' | 'cwd'>>) => {
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

  return { subSessions, visibleSubSessions, loadedServerId, create, close, restart, rename, updateLocal };
}
