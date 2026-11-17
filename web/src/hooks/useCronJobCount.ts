import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { RESOURCE_TOPICS } from '@shared/resource-events.js';
import { apiFetch } from '../api.js';
import { useResourceEvent } from './useResourceEvent.js';
import type { WsClient } from '../ws-client.js';

export const CRON_SHOW_ALL_STORAGE_KEY = 'rcc_cron_show_all';
export const CRON_SCOPE_CHANGE_EVENT = 'rcc:cron-scope-changed';

export interface CronListScopeOptions {
  serverId?: string | null;
  projectName?: string | null;
  sharedSessionName?: string;
  sharedScope?: boolean;
  showAllServers?: boolean;
}

export interface UseCronJobCountOptions {
  enabled?: boolean;
  serverId: string | null | undefined;
  projectName: string | null | undefined;
  ws: WsClient | null;
  connected?: boolean;
  sharedSessionName?: string;
  sharedScope?: boolean;
}

export function readCronShowAllPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CRON_SHOW_ALL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function buildCronListUrl(opts: CronListScopeOptions): string | null {
  const serverId = opts.serverId?.trim() || '';
  if (!serverId) return null;

  const sharedSessionName = opts.sharedSessionName?.trim() || '';
  const sharedScope = Boolean(opts.sharedScope);
  const effectiveShowAllServers = !sharedScope && !sharedSessionName && Boolean(opts.showAllServers);
  const wholeServerSharedScope = sharedScope && !sharedSessionName;
  const projectName = opts.projectName?.trim() || '';

  if (!effectiveShowAllServers && !wholeServerSharedScope && !projectName) {
    return null;
  }

  const query = effectiveShowAllServers
    ? ''
    : wholeServerSharedScope
      ? `serverId=${encodeURIComponent(serverId)}`
      : `serverId=${encodeURIComponent(serverId)}&projectName=${encodeURIComponent(projectName)}`;

  const base = `/api/cron?${query}`;
  if (!sharedSessionName) return base;
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}sessionName=${encodeURIComponent(sharedSessionName)}`;
}

/**
 * Tracks the active cron job count for the current CronManager scope without
 * surfacing background errors or flickering during live updates.
 */
export function useCronJobCount({
  enabled = true,
  serverId,
  projectName,
  ws,
  connected = false,
  sharedSessionName,
  sharedScope = false,
}: UseCronJobCountOptions): number {
  const [showAllServers, setShowAllServers] = useState(readCronShowAllPref);
  const [count, setCount] = useState(0);
  const requestIdRef = useRef(0);
  const prevUrlRef = useRef<string | null>(null);
  const prevConnectedRef = useRef(connected);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncShowAll = () => setShowAllServers(readCronShowAllPref());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === CRON_SHOW_ALL_STORAGE_KEY) {
        syncShowAll();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(CRON_SCOPE_CHANGE_EVENT, syncShowAll);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CRON_SCOPE_CHANGE_EVENT, syncShowAll);
    };
  }, []);

  const url = enabled
    ? buildCronListUrl({
        serverId,
        projectName,
        sharedSessionName,
        sharedScope,
        showAllServers,
      })
    : null;

  const refresh = useCallback(async () => {
    if (!url) return;
    const requestId = ++requestIdRef.current;
    try {
      const res = await apiFetch<{ jobs?: unknown[] }>(url);
      if (requestId !== requestIdRef.current) return;
      const nextCount = Array.isArray(res?.jobs) ? res.jobs.length : 0;
      setCount(nextCount);
    } catch {
      // Background count fetch fails silently without touching UI error state.
    }
  }, [url]);

  useEffect(() => {
    requestIdRef.current += 1;
    if (!url) {
      prevUrlRef.current = null;
      setCount(0);
      return;
    }
    if (prevUrlRef.current !== null && prevUrlRef.current !== url) {
      setCount(0);
    }
    prevUrlRef.current = url;
    void refresh();
  }, [url, refresh]);

  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = connected;
    if (!wasConnected && connected && url) {
      void refresh();
    }
  }, [connected, url, refresh]);

  useResourceEvent(enabled ? ws : null, RESOURCE_TOPICS.cron, () => {
    if (url) void refresh();
  });

  useEffect(() => {
    if (!url || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, refresh]);

  return count;
}
