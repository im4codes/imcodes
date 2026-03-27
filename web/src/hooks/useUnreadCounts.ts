/**
 * useUnreadCounts — global WS listener that tracks per-session unread counts.
 *
 * Strategy: page-session approximation — counts start at 0 on mount and
 * accumulate from live WS events. No IndexedDB. Resets to 0 when a session
 * becomes active.
 *
 * localStorage key per session: `${serverId}:${sessionName}` → lastReadTs
 * (stored for future use if needed; badge counts are always in-memory only).
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';
import { isUserVisible } from '../util/isUserVisible.js';

/**
 * Hook that maintains an in-memory Map<sessionName, unreadCount>.
 *
 * @param sessions      List of session names to track.
 * @param activeSession Currently viewed session — its count is reset to 0.
 * @param ws            WsClient instance (may be null while connecting).
 * @param serverId      Used to namespace lastReadTs keys in localStorage.
 */
export function useUnreadCounts(
  sessions: string[],
  activeSession: string | null,
  ws: WsClient | null,
  serverId?: string | null,
): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map());

  // Keep a stable ref to activeSession so the message handler can read it
  // without being recreated on every activeSession change.
  const activeRef = useRef<string | null>(activeSession);
  activeRef.current = activeSession;

  // Reset count for the session that just became active.
  useEffect(() => {
    if (!activeSession) return;
    setCounts((prev) => {
      if ((prev.get(activeSession) ?? 0) === 0) return prev;
      const next = new Map(prev);
      next.set(activeSession, 0);
      return next;
    });
    // Persist lastReadTs to localStorage so it can be used later if needed.
    if (serverId) {
      try {
        localStorage.setItem(`${serverId}:${activeSession}:lastReadTs`, String(Date.now()));
      } catch { /* ignore quota errors */ }
    }
  }, [activeSession, serverId]);

  // Per-session last-seen event timestamp for dedup (skip replayed events on reconnect).
  const lastSeenTsRef = useRef(new Map<string, number>());

  // Listen to all WS timeline.event messages; increment count for non-active sessions.
  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type !== 'timeline.event') return;
      const event = msg.event;
      if (!isUserVisible(event)) return;
      const sessionName = event.sessionId;
      if (!sessionName) return;
      // Don't increment for the currently active session.
      if (sessionName === activeRef.current) return;
      // Dedup: skip events older than or equal to last-seen timestamp for this session.
      const eventTs = event.ts ?? 0;
      const lastTs = lastSeenTsRef.current.get(sessionName) ?? 0;
      if (eventTs > 0 && eventTs <= lastTs) return;
      if (eventTs > 0) lastSeenTsRef.current.set(sessionName, eventTs);
      setCounts((prev) => {
        const next = new Map(prev);
        next.set(sessionName, (next.get(sessionName) ?? 0) + 1);
        return next;
      });
    });
  }, [ws]);

  // When the sessions list changes, prune counts for removed sessions.
  useEffect(() => {
    const sessionSet = new Set(sessions);
    setCounts((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!sessionSet.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  return counts;
}
