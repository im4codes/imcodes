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
  useEffect(() => {
    if (!serverId) { setSubSessions([]); setLoadedServerId(null); return; }
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
  }, [serverId]);

  // Rebuild all when daemon connects (once per connection)
  useEffect(() => {
    if (!connected || !ws || subSessions.length === 0 || rebuiltRef.current) return;
    rebuiltRef.current = true;
    ws.subSessionRebuildAll(subSessions.map((s) => ({
      id: s.id,
      type: s.type,
      shellBin: s.shellBin,
      cwd: s.cwd,
      ccSessionId: s.ccSessionId,
      geminiSessionId: s.geminiSessionId,
      parentSession: s.parentSession,
      label: s.label,
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
            // Don't add if already exists
            if (prev.some((s) => s.id === m.id)) return prev;
            const now = Date.now();
            return [...prev, {
              id: m.id,
              serverId: '',
              type: m.sessionType || 'shell',
              sessionName: m.sessionName || `deck_sub_${m.id}`,
              cwd: m.cwd || null,
              label: m.label || null,
              parentSession: m.parentSession || null,
              createdAt: now,
              updatedAt: now,
              state: (m.state || 'running') as SubSession['state'],
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

      if (msg.type === 'timeline.event') {
        const ev = msg.event;
        if (ev.type !== 'session.state') return;
        state = String(ev.payload.state ?? '');
        sessionName = ev.sessionId;
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
      const ccSessionId = type === 'claude-code' ? crypto.randomUUID() : undefined;
      const description = extra?.description as string | undefined;
      const res = await apiCreate(serverId, { type, shellBin, cwd, label, ccSessionId, parentSession: activeSession ?? null, description });
      const sub: SubSession = {
        ...res.subSession,
        sessionName: res.sessionName,
        state: 'starting',
      };
      setSubSessions((prev) => [...prev, sub]);
      // Ask daemon to start it — for openclaw pass extra fields
      if (type === 'openclaw' && extra) {
        ws?.send({
          type: 'subsession.start',
          id: sub.id,
          sessionType: type,
          cwd,
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
