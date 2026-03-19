/**
 * useSubSessions — loads sub-session list from PG, handles create/close,
 * and triggers daemon rebuild on connect.
 */
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
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
  }, [serverId, connected]);

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
  ): Promise<SubSession | null> => {
    if (!serverId) return null;
    try {
      const ccSessionId = type === 'claude-code' ? crypto.randomUUID() : undefined;
      const res = await apiCreate(serverId, { type, shellBin, cwd, label, ccSessionId, parentSession: activeSession ?? null });
      const sub: SubSession = {
        ...res.subSession,
        sessionName: res.sessionName,
        state: 'starting',
      };
      setSubSessions((prev) => [...prev, sub]);
      // Ask daemon to start it
      ws?.subSessionStart(sub.id, type, shellBin, cwd, ccSessionId, activeSession);
      return sub;
    } catch {
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
    // Stop old session
    ws.subSessionStop(sub.sessionName);
    // Close old in PG
    await patchSubSession(serverId, id, { closedAt: Date.now() }).catch(() => {});
    // Remove from state
    setSubSessions((prev) => prev.filter((s) => s.id !== id));
    // Create new with same params
    await create(sub.type, sub.shellBin ?? undefined, sub.cwd ?? undefined, sub.label ?? undefined);
  }, [serverId, ws, subSessions, create]);

  const rename = useCallback(async (id: string, label: string) => {
    if (!serverId) return;
    await patchSubSession(serverId, id, { label }).catch(() => {});
    setSubSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, label } : s,
    ));
  }, [serverId]);

  // Filter sub-sessions by active main session (show only those belonging to it).
  // Sub-sessions with no parentSession (null) are always visible — they were created
  // before the parentSession feature or from a context without an active session.
  const visibleSubSessions = activeSession
    ? subSessions.filter((s) => !s.parentSession || s.parentSession === activeSession)
    : subSessions;

  return { subSessions, visibleSubSessions, loadedServerId, create, close, restart, rename };
}
