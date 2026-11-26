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
  fetchedAt?: number;
  pageLengths?: number[];
  truncated?: boolean;
  cursorBranch?: string;
  cursorRepoGeneration?: number;
}

export interface RepoPageMemoryCacheEntry {
  context: CachedRepoContext | null;
  contextFetchedAt?: number;
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
export const REPO_PAGE_CACHE_FRESH_TTL_MS = 60_000;
export const REPO_PAGE_CACHE_STORAGE_KEY = 'imcodes_repo_page_cache_v1';

const REPO_PAGE_CACHE_STORAGE_VERSION = 1;
const REPO_PAGE_CACHE_MAX_ITEMS_PER_TAB = 50;
const REPO_PAGE_CACHE_MAX_DETAIL_ENTRIES = 20;
const REPO_PAGE_CACHE_MAX_ENTRY_DETAIL_BYTES = 32 * 1024;
const TAB_KEYS: readonly CachedRepoTabKey[] = ['issues', 'prs', 'branches', 'commits', 'actions'];

const repoPageCache = new Map<string, RepoPageMemoryCacheEntry>();
let storageHydrated = false;

function readStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readSafeLocalStorageItem(key: string): string | null {
  const storage = readStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSafeLocalStorageItem(key: string, value: string): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Degrade gracefully when storage is disabled or quota is exceeded.
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalStringOrNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string' || isFiniteNumber(value);
}

function isValidLabel(label: unknown): boolean {
  return typeof label === 'string' || (isPlainObject(label) && typeof label.name === 'string');
}

function sanitizeContext(raw: unknown): CachedRepoContext | null {
  if (!isPlainObject(raw)) return null;
  if (
    !isOptionalString(raw.provider)
    || !isOptionalString(raw.owner)
    || !isOptionalString(raw.repo)
    || !isOptionalString(raw.defaultBranch)
    || !isOptionalString(raw.currentBranch)
    || !isOptionalString(raw.status)
    || (raw.cliInstalled !== undefined && typeof raw.cliInstalled !== 'boolean')
    || (raw.branches !== undefined && (!Array.isArray(raw.branches) || !raw.branches.every((b) => typeof b === 'string')))
  ) {
    return null;
  }
  const ctx: CachedRepoContext = {};
  if (typeof raw.provider === 'string') ctx.provider = raw.provider;
  if (typeof raw.owner === 'string') ctx.owner = raw.owner;
  if (typeof raw.repo === 'string') ctx.repo = raw.repo;
  if (typeof raw.defaultBranch === 'string') ctx.defaultBranch = raw.defaultBranch;
  if (typeof raw.currentBranch === 'string') ctx.currentBranch = raw.currentBranch;
  if (typeof raw.status === 'string') ctx.status = raw.status;
  if (typeof raw.cliInstalled === 'boolean') ctx.cliInstalled = raw.cliInstalled;
  if (Array.isArray(raw.branches)) ctx.branches = [...raw.branches];
  if (isFiniteNumber(raw.lastRefresh)) ctx.lastRefresh = raw.lastRefresh;
  if (isFiniteNumber(raw.repoGeneration)) ctx.repoGeneration = raw.repoGeneration;
  if (isFiniteNumber(raw.detectedAt)) ctx.detectedAt = raw.detectedAt;
  return ctx;
}

function isValidTabItem(tabKey: CachedRepoTabKey, item: unknown): boolean {
  switch (tabKey) {
    case 'issues':
      return isPlainObject(item)
        && (isFiniteNumber(item.number) || isFiniteNumber(item.id) || (typeof item.id === 'string' && item.id.length > 0))
        && isOptionalString(item.title)
        && isOptionalString(item.state)
        && isOptionalString(item.author)
        && (item.user === undefined || item.user === null || (isPlainObject(item.user) && isOptionalString(item.user.login)))
        && isOptionalStringOrNumber(item.createdAt)
        && (item.labels === undefined || (Array.isArray(item.labels) && item.labels.every(isValidLabel)));
    case 'prs':
      return isPlainObject(item)
        && (isFiniteNumber(item.number) || isFiniteNumber(item.id) || (typeof item.id === 'string' && item.id.length > 0))
        && isOptionalString(item.title)
        && isOptionalString(item.state)
        && isOptionalString(item.head)
        && isOptionalString(item.base)
        && isOptionalString(item.author)
        && (item.user === undefined || item.user === null || (isPlainObject(item.user) && isOptionalString(item.user.login)))
        && isOptionalStringOrNumber(item.createdAt)
        && (item.labels === undefined || (Array.isArray(item.labels) && item.labels.every(isValidLabel)));
    case 'branches':
      return (typeof item === 'string' && item.length > 0)
        || (
          isPlainObject(item)
          && typeof item.name === 'string'
          && item.name.length > 0
          && isOptionalString(item.checkoutBlockedReason)
          && isOptionalStringOrNumber(item.lastCommitDate)
          && isOptionalString(item.lastCommit)
        );
    case 'commits': {
      if (!isPlainObject(item)) return false;
      const sha = item.sha ?? item.oid ?? item.hash;
      return typeof sha === 'string' && sha.length > 0
        && isOptionalString(item.message)
        && isOptionalString(item.title)
        && (item.author === undefined || item.author === null || typeof item.author === 'string' || (isPlainObject(item.author) && isOptionalString(item.author.name)))
        && isOptionalStringOrNumber(item.date);
    }
    case 'actions':
      return isPlainObject(item)
        && (isFiniteNumber(item.id) || (typeof item.id === 'string' && item.id.length > 0) || isFiniteNumber(item.runId) || (typeof item.runId === 'string' && item.runId.length > 0))
        && typeof item.status === 'string'
        && isOptionalString(item.conclusion)
        && isOptionalString(item.name)
        && isOptionalString(item.workflowName)
        && isOptionalString(item.branch)
        && isOptionalString(item.headBranch)
        && isOptionalString(item.commitMessage)
        && isOptionalString(item.headCommitMessage)
        && isOptionalString(item.event)
        && isOptionalString(item.url)
        && (item.headCommit === undefined || item.headCommit === null || (isPlainObject(item.headCommit) && isOptionalString(item.headCommit.message)))
        && (item.actor === undefined || item.actor === null || typeof item.actor === 'string' || (isPlainObject(item.actor) && isOptionalString(item.actor.login)))
        && isOptionalStringOrNumber(item.duration)
        && isOptionalStringOrNumber(item.runNumber)
        && isOptionalStringOrNumber(item.createdAt)
        && isOptionalStringOrNumber(item.updatedAt);
  }
}

function isValidDetailEntry(key: string, detail: unknown): boolean {
  if (!isPlainObject(detail)) return false;
  if (key.startsWith('commits:')) {
    return isOptionalString(detail.body)
      && isOptionalString(detail.url)
      && isPlainObject(detail.stats)
      && isFiniteNumber(detail.stats.additions)
      && isFiniteNumber(detail.stats.deletions)
      && isFiniteNumber(detail.stats.filesChanged)
      && Array.isArray(detail.files)
      && detail.files.every((f) => isPlainObject(f) && typeof f.filename === 'string' && (f.additions === undefined || isFiniteNumber(f.additions)) && (f.deletions === undefined || isFiniteNumber(f.deletions)));
  }
  if (key.startsWith('prs:')) {
    return isFiniteNumber(detail.additions)
      && isFiniteNumber(detail.deletions)
      && isFiniteNumber(detail.changedFiles)
      && isOptionalString(detail.body)
      && isOptionalString(detail.reviewDecision)
      && isOptionalString(detail.checksStatus)
      && isOptionalString(detail.url);
  }
  if (key.startsWith('issues:')) {
    return isOptionalString(detail.body)
      && (detail.comments === undefined
        || (Array.isArray(detail.comments) && detail.comments.every((c) => isPlainObject(c) && typeof c.body === 'string' && isOptionalString(c.author) && isOptionalStringOrNumber(c.createdAt))));
  }
  if (key.startsWith('actions:')) {
    return detail.jobs === undefined
      || (Array.isArray(detail.jobs) && detail.jobs.every((j) => (
        isPlainObject(j)
        && typeof j.name === 'string'
        && typeof j.status === 'string'
        && isOptionalString(j.conclusion)
        && (j.steps === undefined || (Array.isArray(j.steps) && j.steps.every((st) => isPlainObject(st) && typeof st.name === 'string' && typeof st.status === 'string' && isOptionalString(st.conclusion))))
      )));
  }
  return false;
}

function sanitizeCallbacks(raw: unknown): CallbackTaskRecord[] {
  if (!Array.isArray(raw)) return [];
  const valid: CallbackTaskRecord[] = [];
  for (const item of raw) {
    if (isPlainObject(item) && typeof item.callbackId === 'string' && typeof item.status === 'string') {
      valid.push(item as CallbackTaskRecord);
    }
  }
  return valid;
}

function emptyCachedTab(): CachedRepoTabState {
  return {
    items: [],
    page: 1,
    hasMore: false,
    loading: false,
    refreshing: false,
    error: null,
    fetched: false,
  };
}

function cloneTab(tabKey: CachedRepoTabKey, tab: Partial<CachedRepoTabState> | undefined): CachedRepoTabState {
  if (!isPlainObject(tab) || !Array.isArray(tab.items)) return emptyCachedTab();
  for (const item of tab.items) {
    if (!isValidTabItem(tabKey, item)) {
      return emptyCachedTab();
    }
  }
  const pageLengths = Array.isArray(tab.pageLengths)
    && tab.pageLengths.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    ? [...tab.pageLengths]
    : undefined;
  return {
    items: [...tab.items],
    page: isFiniteNumber(tab.page) && tab.page >= 1 ? tab.page : 1,
    hasMore: Boolean(tab.hasMore),
    loading: false,
    refreshing: false,
    error: null,
    fetched: Boolean(tab.fetched),
    ...(isFiniteNumber(tab.fetchedAt) ? { fetchedAt: tab.fetchedAt } : {}),
    ...(pageLengths ? { pageLengths } : {}),
    ...(tab.truncated === true ? { truncated: true } : {}),
    ...(typeof tab.cursorBranch === 'string' ? { cursorBranch: tab.cursorBranch } : {}),
    ...(isFiniteNumber(tab.cursorRepoGeneration) ? { cursorRepoGeneration: tab.cursorRepoGeneration } : {}),
  };
}

function cloneTabs(tabs: Partial<Record<CachedRepoTabKey, Partial<CachedRepoTabState>>> | undefined): Record<CachedRepoTabKey, CachedRepoTabState> {
  return {
    issues: cloneTab('issues', tabs?.issues),
    prs: cloneTab('prs', tabs?.prs),
    branches: cloneTab('branches', tabs?.branches),
    commits: cloneTab('commits', tabs?.commits),
    actions: cloneTab('actions', tabs?.actions),
  };
}

function cloneDetailPairs(raw: unknown): Array<[string, any]> {
  if (!Array.isArray(raw)) return [];
  const pairs: Array<[string, any]> = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string' && isValidDetailEntry(item[0], item[1])) {
      pairs.push([item[0], item[1]]);
    }
  }
  return pairs;
}

function cloneEntry(entry: Partial<RepoPageMemoryCacheEntry>): RepoPageMemoryCacheEntry {
  const detailData = cloneDetailPairs(entry.detailData);
  const expandedKey = typeof entry.expandedKey === 'string' ? entry.expandedKey : null;
  return {
    context: sanitizeContext(entry.context),
    ...(isFiniteNumber(entry.contextFetchedAt) ? { contextFetchedAt: entry.contextFetchedAt } : {}),
    tabs: cloneTabs(entry.tabs),
    expandedKey,
    detailData,
    callbacks: sanitizeCallbacks(entry.callbacks),
    callbackRuntimeEnabled: Boolean(entry.callbackRuntimeEnabled),
    ...(isFiniteNumber(entry.callbackLastCheckedAt) ? { callbackLastCheckedAt: entry.callbackLastCheckedAt } : {}),
    ...(typeof entry.callbackLastError === 'string' ? { callbackLastError: entry.callbackLastError } : {}),
    updatedAt: isFiniteNumber(entry.updatedAt) ? entry.updatedAt : 0,
  };
}

function boundDetailDataForStorage(detailData: Array<[string, any]>, expandedKey: string | null): Array<[string, any]> {
  if (detailData.length === 0) return [];
  // Prioritize the currently expanded detail and newest entries when capping detail count/bytes.
  const ordered = expandedKey
    ? [
        ...detailData.filter(([k]) => k !== expandedKey),
        ...detailData.filter(([k]) => k === expandedKey),
      ]
    : [...detailData];
  const capped = ordered.slice(-REPO_PAGE_CACHE_MAX_DETAIL_ENTRIES);
  const kept: Array<[string, any]> = [];
  let totalBytes = 2; // "[]"
  for (let i = capped.length - 1; i >= 0; i--) {
    const pair = capped[i];
    try {
      const serialized = JSON.stringify(pair);
      if (!serialized) continue;
      const addedBytes = serialized.length + (kept.length > 0 ? 1 : 0);
      if (totalBytes + addedBytes > REPO_PAGE_CACHE_MAX_ENTRY_DETAIL_BYTES) continue;
      kept.unshift(pair);
      totalBytes += addedBytes;
    } catch {
      // Skip non-serializable detail payloads cleanly.
    }
  }
  return kept;
}

function boundEntryForStorage(entry: RepoPageMemoryCacheEntry): RepoPageMemoryCacheEntry {
  const cloned = cloneEntry(entry);
  for (const key of TAB_KEYS) {
    const tab = cloned.tabs[key];
    if (tab.items.length > REPO_PAGE_CACHE_MAX_ITEMS_PER_TAB) {
      if (key === 'branches') {
        tab.items = tab.items.slice(0, REPO_PAGE_CACHE_MAX_ITEMS_PER_TAB);
        tab.page = 1;
        tab.hasMore = false;
        tab.truncated = true;
        delete tab.pageLengths;
        continue;
      }
      const lengths = tab.pageLengths;
      const lengthsMatch = Array.isArray(lengths)
        && lengths.length > 0
        && lengths.reduce((sum, n) => sum + n, 0) === tab.items.length;
      if (lengthsMatch) {
        let keptPages = 0;
        let keptItems = 0;
        for (const len of lengths) {
          if (keptItems + len > REPO_PAGE_CACHE_MAX_ITEMS_PER_TAB) break;
          keptItems += len;
          keptPages += 1;
        }
        if (keptPages >= 1 && keptItems > 0) {
          tab.items = tab.items.slice(0, keptItems);
          tab.page = keptPages;
          tab.hasMore = true;
          tab.pageLengths = lengths.slice(0, keptPages);
          delete tab.truncated;
          continue;
        }
      }
      // Page 1 alone exceeded cap or page boundaries unknown: store bounded preview cleanly.
      tab.items = tab.items.slice(0, REPO_PAGE_CACHE_MAX_ITEMS_PER_TAB);
      tab.page = 1;
      tab.hasMore = true;
      tab.truncated = true;
      delete tab.pageLengths;
    }
  }
  cloned.detailData = boundDetailDataForStorage(cloned.detailData, cloned.expandedKey);
  return cloned;
}

function trimMemoryLru(): void {
  while (repoPageCache.size > REPO_PAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = repoPageCache.keys().next().value;
    if (oldestKey === undefined) break;
    repoPageCache.delete(oldestKey);
  }
}

function ensureHydrated(): void {
  if (storageHydrated) return;
  storageHydrated = true;
  const raw = readSafeLocalStorageItem(REPO_PAGE_CACHE_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (
      !isPlainObject(parsed)
      || parsed.v !== REPO_PAGE_CACHE_STORAGE_VERSION
      || !Array.isArray(parsed.entries)
    ) {
      return;
    }
    for (const item of parsed.entries) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const [key, value] = item;
      if (typeof key !== 'string' || !isPlainObject(value)) continue;
      repoPageCache.delete(key);
      repoPageCache.set(key, cloneEntry(value as Partial<RepoPageMemoryCacheEntry>));
    }
    trimMemoryLru();
  } catch {
    // Ignore corrupt or unreadable persisted cache; memory cache starts clean.
  }
}

function persistToStorage(): void {
  const storage = readStorage();
  if (!storage) return;
  const entries: Array<[string, RepoPageMemoryCacheEntry]> = [];
  for (const [key, entry] of repoPageCache.entries()) {
    entries.push([key, boundEntryForStorage(entry)]);
  }
  while (entries.length > 0) {
    try {
      storage.setItem(
        REPO_PAGE_CACHE_STORAGE_KEY,
        JSON.stringify({ v: REPO_PAGE_CACHE_STORAGE_VERSION, entries }),
      );
      return;
    } catch {
      // Evict oldest entry on storage quota exhaustion and retry.
      entries.shift();
    }
  }
  try {
    storage.removeItem(REPO_PAGE_CACHE_STORAGE_KEY);
  } catch {
    // Graceful fallback: keep working in-memory cache even if storage fails completely.
  }
}

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

export function getRepoPageCache(key: string): RepoPageMemoryCacheEntry | null {
  ensureHydrated();
  const entry = repoPageCache.get(key);
  if (!entry) return null;
  repoPageCache.delete(key);
  repoPageCache.set(key, entry);
  return cloneEntry(entry);
}

export function setRepoPageCache(key: string, entry: RepoPageMemoryCacheEntry): void {
  ensureHydrated();
  repoPageCache.delete(key);
  repoPageCache.set(key, cloneEntry(entry));
  trimMemoryLru();
  persistToStorage();
}

export function clearRepoPageCache(): void {
  repoPageCache.clear();
  storageHydrated = true;
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.removeItem(REPO_PAGE_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage errors during cache reset.
  }
}

export function __resetRepoPageCacheMemoryForTests(): void {
  repoPageCache.clear();
  storageHydrated = false;
}
