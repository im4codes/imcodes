import type { CallbackTaskRecord } from '@shared/callback-types.js';

export type CachedRepoTabKey = 'issues' | 'prs' | 'branches' | 'commits' | 'actions';

export interface CachedRepoContext {
  provider?: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  currentBranch?: string;
  branches?: string[];
  cliInstalled?: boolean;
  lastRefresh?: number;
  status?: string;
  repoGeneration?: number;
  detectedAt?: number;
}

export interface CachedRepoTabState<T = any> {
  items: T[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  fetched: boolean;
}

export interface RepoPageMemoryCacheEntry {
  context: CachedRepoContext | null;
  tabs: Record<CachedRepoTabKey, CachedRepoTabState>;
  expandedKey: string | null;
  detailData: Array<[string, any]>;
  callbacks: CallbackTaskRecord[];
  callbackRuntimeEnabled: boolean;
  callbackLastCheckedAt?: number;
  callbackLastError?: string;
  updatedAt: number;
}

export const REPO_PAGE_CACHE_MAX_ENTRIES = 24;

const repoPageCache = new Map<string, RepoPageMemoryCacheEntry>();

function normalizeProjectDir(projectDir: string): string {
  const trimmed = projectDir.trim();
  if (trimmed === '/') return '/';
  return trimmed.replace(/[\\/]+$/, '');
}

export function makeRepoPageCacheKey(opts: {
  serverId?: string | null;
  sessionId?: string | null;
  scopeToSessionRoot?: boolean;
  projectDir: string;
}): string {
  const server = opts.serverId?.trim() || 'local';
  const session = opts.scopeToSessionRoot ? (opts.sessionId?.trim() || '') : '';
  return JSON.stringify([server, session, normalizeProjectDir(opts.projectDir)]);
}

function cloneTabs(tabs: Record<CachedRepoTabKey, CachedRepoTabState>): Record<CachedRepoTabKey, CachedRepoTabState> {
  const copyTab = (tab: CachedRepoTabState): CachedRepoTabState => ({
    items: [...tab.items],
    page: tab.page,
    hasMore: tab.hasMore,
    loading: false,
    refreshing: false,
    error: tab.error,
    fetched: tab.fetched,
  });
  return {
    issues: copyTab(tabs.issues),
    prs: copyTab(tabs.prs),
    branches: copyTab(tabs.branches),
    commits: copyTab(tabs.commits),
    actions: copyTab(tabs.actions),
  };
}

export function getRepoPageCache(key: string): RepoPageMemoryCacheEntry | null {
  const entry = repoPageCache.get(key);
  if (!entry) return null;
  repoPageCache.delete(key);
  repoPageCache.set(key, entry);
  return {
    context: entry.context ? { ...entry.context } : null,
    tabs: cloneTabs(entry.tabs),
    expandedKey: entry.expandedKey,
    detailData: entry.detailData.map(([k, v]) => [k, v]),
    callbacks: [...entry.callbacks],
    callbackRuntimeEnabled: entry.callbackRuntimeEnabled,
    callbackLastCheckedAt: entry.callbackLastCheckedAt,
    callbackLastError: entry.callbackLastError,
    updatedAt: entry.updatedAt,
  };
}

export function setRepoPageCache(key: string, entry: RepoPageMemoryCacheEntry): void {
  repoPageCache.delete(key);
  repoPageCache.set(key, {
    context: entry.context ? { ...entry.context } : null,
    tabs: cloneTabs(entry.tabs),
    expandedKey: entry.expandedKey,
    detailData: entry.detailData.map(([k, v]) => [k, v]),
    callbacks: [...entry.callbacks],
    callbackRuntimeEnabled: entry.callbackRuntimeEnabled,
    callbackLastCheckedAt: entry.callbackLastCheckedAt,
    callbackLastError: entry.callbackLastError,
    updatedAt: entry.updatedAt,
  });
  while (repoPageCache.size > REPO_PAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = repoPageCache.keys().next().value;
    if (oldestKey === undefined) break;
    repoPageCache.delete(oldestKey);
  }
}

export function clearRepoPageCache(): void {
  repoPageCache.clear();
}
