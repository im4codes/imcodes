import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren } from 'preact';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { ChatMarkdown } from '../components/ChatMarkdown.js';
import type { CallbackTaskRecord } from '@shared/callback-types.js';
import { REPO_CALLBACK_RECENT_HISTORY_LIMIT } from '@shared/repo-callback.js';
import { REPO_MSG } from '@shared/repo-types.js';
import { FS_SESSION_ROOT_PATH } from '../../../src/shared/transport/fs.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { forceRefreshSharedChangesForCheckout } from '../git-status-store.js';
import { ingestSessionRepoContext, getSessionRepoContext } from '../session-repo-context-store.js';
import {
  getRepoPageCache,
  makeRepoPageCacheKey,
  readSafeLocalStorageItem,
  REPO_PAGE_CACHE_FRESH_TTL_MS,
  setRepoPageCache,
  writeSafeLocalStorageItem,
} from '../repo-page-cache.js';
import { RepoCallbackModal, type RepoCallbackTargetOption } from '../components/RepoCallbackModal.js';
import { loadRepoCallbackPrefs } from '../repo-callback-prefs.js';

// ── Pull-to-refresh component ────────────────────────────────────────────

const PTR_THRESHOLD = 60; // px to pull before triggering

function PullToRefresh({ children, loading, onRefresh }: { children: ComponentChildren; loading: boolean; onRefresh: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const pulling = useRef(false);

  const onTouchStart = useCallback((e: TouchEvent) => {
    const el = containerRef.current;
    if (!el || el.scrollTop > 0 || loading) return;
    startY.current = e.touches[0].clientY;
    pulling.current = true;
  }, [loading]);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!pulling.current) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) {
      setPullDistance(Math.min(dy * 0.5, 100));
      if (dy > 10) e.preventDefault();
    } else {
      setPullDistance(0);
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!pulling.current) return;
    pulling.current = false;
    if (pullDistance >= PTR_THRESHOLD && !loading) {
      onRefresh();
    }
    setPullDistance(0);
  }, [pullDistance, loading, onRefresh]);

  return (
    <div
      ref={containerRef}
      class="repo-scroll"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {(pullDistance > 0 || loading) && (
        <div
          class="repo-ptr-banner"
          style={{
            transition: pulling.current ? 'none' : 'height 0.2s',
            height: loading ? 28 : pullDistance > 0 ? Math.min(pullDistance, 40) : 0,
          }}
        >
          {loading ? '↻ refreshing...' : pullDistance >= PTR_THRESHOLD ? '↑ release to refresh' : '↓ pull to refresh'}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ws: WsClient;
  sessionId?: string | null;
  projectDir: string;
  serverId?: string | null;
  callbackTargets?: RepoCallbackTargetOption[];
  onBack?: () => void;
  focusLatestAction?: { token: number; failedJobName?: string; failedStepName?: string } | null;
  /** Called when a CI/CD run completes (success/failure). */
  onCiEvent?: (run: { name: string; status: string; conclusion?: string; url: string; failedJobName?: string; failedStepName?: string }) => void;
  initialTab?: RepoPageTabKey;
  initialTabToken?: number;
  scopeToSessionRoot?: boolean;
  readOnly?: boolean;
}

export type RepoPageTabKey = 'issues' | 'prs' | 'branches' | 'commits' | 'actions';
type TabKey = RepoPageTabKey;

interface RepoContext {
  provider?: string; // 'github' | 'gitlab' | ...
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

interface TabState<T = any> {
  items: T[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  /** Foreground/manual refresh — shows refresh feedback while keeping items visible */
  refreshing: boolean;
  /** Silent background SWR/auto refresh — keeps UI visible without tab spinner */
  backgroundRefreshing?: boolean;
  error: string | null;
  fetched: boolean; // true once first fetch completed (for lazy load)
  fetchedAt?: number;
  pageLengths?: number[];
  truncated?: boolean;
  branchStale?: boolean;
  cursorBranch?: string;
  cursorRepoGeneration?: number;
}

interface TabRequestMeta {
  key: TabKey;
  page: number;
  force: boolean;
  seq: number;
  background?: boolean;
  branch?: string;
  repoGeneration?: number;
}

interface DetailRequestMeta {
  key: string;
  tab: 'actions' | 'commits' | 'prs' | 'issues';
  branch?: string;
  repoGeneration?: number;
}

type CheckoutFeedback =
  | { kind: 'success'; branch: string }
  | { kind: 'error'; error: string; branch?: string }
  | null;

/** Map daemon RepoContext shape ({ info: { platform, owner, repo }, status }) to page context. */
function mapDetectToContext(raw: any): RepoContext {
  if (!raw) return {};
  // Already in page shape (e.g. from old-style message or test mock)
  if (raw.provider !== undefined) {
    return {
      ...raw,
      currentBranch: raw.currentBranch ?? raw.info?.currentBranch,
      defaultBranch: raw.defaultBranch ?? raw.info?.defaultBranch,
      repoGeneration: raw.repoGeneration,
      detectedAt: raw.detectedAt,
    };
  }
  // Daemon shape: { status, info: { platform, owner, repo, defaultBranch }, cliVersion, cliAuth }
  const info = raw.info;
  return {
    provider: info?.platform,
    owner: info?.owner,
    repo: info?.repo,
    defaultBranch: info?.defaultBranch ?? raw.defaultBranch,
    currentBranch: info?.currentBranch ?? raw.currentBranch,
    cliInstalled: raw.status !== 'cli_missing',
    status: raw.status,
    repoGeneration: raw.repoGeneration,
    detectedAt: raw.detectedAt,
  };
}

function emptyTab<T = any>(): TabState<T> {
  return { items: [], page: 1, hasMore: false, loading: false, refreshing: false, backgroundRefreshing: false, error: null, fetched: false };
}

function isTimestampFresh(ts?: number | null): boolean {
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 && (Date.now() - ts) <= REPO_PAGE_CACHE_FRESH_TTL_MS;
}

function isTabStale(tab: TabState): boolean {
  return tab.fetched && (tab.truncated === true || !isTimestampFresh(tab.fetchedAt));
}

function getTabItemDedupeKey(tabKey: TabKey, item: any): string | null {
  if (!item) return null;
  if (tabKey === 'issues' || tabKey === 'prs') {
    if (item.number != null) return String(item.number);
    if (item.id != null) return String(item.id);
    return null;
  }
  if (tabKey === 'branches') {
    return typeof item === 'string' ? item : (typeof item.name === 'string' ? item.name : null);
  }
  if (tabKey === 'commits') {
    const sha = item.sha ?? item.oid ?? item.hash;
    return typeof sha === 'string' && sha ? sha : null;
  }
  if (item.id != null) return String(item.id);
  if (item.runId != null) return String(item.runId);
  return null;
}

function mergePaginatedItems(tabKey: TabKey, existingItems: any[], incomingItems: any[]): any[] {
  const merged = [...existingItems];
  const seen = new Set<string>();
  for (const item of existingItems) {
    const k = getTabItemDedupeKey(tabKey, item);
    if (k !== null) seen.add(k);
  }
  for (const item of incomingItems) {
    const k = getTabItemDedupeKey(tabKey, item);
    if (k !== null) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    merged.push(item);
  }
  return merged;
}

const MAX_SILENT_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

// ── Error classification ─────────────────────────────────────────────────────

type ErrorKind = 'cli_missing' | 'unauthorized' | 'rate_limited' | 'generic';

function classifyError(msg: string): ErrorKind {
  const lower = msg.toLowerCase();
  if (lower.includes('cli') && (lower.includes('not found') || lower.includes('missing') || lower.includes('install'))) return 'cli_missing';
  if (lower.includes('unauthorized') || lower.includes('auth') || lower.includes('401') || lower.includes('permission')) return 'unauthorized';
  if (lower.includes('rate') || lower.includes('429') || lower.includes('limit')) return 'rate_limited';
  return 'generic';
}

function isTransientWsSendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return message.includes('WebSocket not connected');
}

// ── Component ────────────────────────────────────────────────────────────────

export function RepoPage(props: Props) {
  const [callbackModalOpen, setCallbackModalOpen] = useState(false);
  const repoCacheKey = makeRepoPageCacheKey({
    serverId: props.serverId,
    sessionId: props.sessionId,
    scopeToSessionRoot: props.scopeToSessionRoot,
    projectDir: props.projectDir,
  });
  return (
    <RepoPageInner
      key={repoCacheKey}
      {...props}
      repoCacheKey={repoCacheKey}
      callbackModalOpen={callbackModalOpen}
      setCallbackModalOpen={setCallbackModalOpen}
    />
  );
}

function RepoPageInner({ ws, sessionId, projectDir, serverId, callbackTargets, focusLatestAction, onCiEvent, initialTab, initialTabToken, scopeToSessionRoot = false, readOnly = false, repoCacheKey, callbackModalOpen, setCallbackModalOpen }: Props & { repoCacheKey: string; callbackModalOpen: boolean; setCallbackModalOpen: (open: boolean) => void }) {
  const { t } = useTranslation();
  const requestProjectDir = scopeToSessionRoot ? FS_SESSION_ROOT_PATH : projectDir;
  const sessionScope = scopeToSessionRoot && sessionId ? { sessionName: sessionId } : {};
  const responseMatchesProject = useCallback(
    (responseProjectDir: unknown) => {
      if (scopeToSessionRoot) return true;
      if (responseProjectDir === projectDir) return true;
      if (typeof responseProjectDir !== 'string') return false;
      const normalize = (value: string) => {
        const trimmed = value.trim();
        if (trimmed === '/') return '/';
        return trimmed.replace(/[\\/]+$/, '');
      };
      return normalize(responseProjectDir) === normalize(projectDir);
    },
    [projectDir, scopeToSessionRoot],
  );

  const initialRepoCacheRef = useRef<ReturnType<typeof getRepoPageCache> | undefined>(undefined);
  if (initialRepoCacheRef.current === undefined) {
    initialRepoCacheRef.current = getRepoPageCache(repoCacheKey);
  }
  const initialRepoCache = initialRepoCacheRef.current;

  const [context, setContext] = useState<RepoContext | null>(() => initialRepoCache?.context ?? null);
  const [detectLoading, setDetectLoading] = useState(() => !initialRepoCache?.context);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (initialTab) return initialTab;
    const saved = readSafeLocalStorageItem('repo-active-tab');
    return saved && ['issues', 'prs', 'branches', 'commits', 'actions'].includes(saved) ? saved as TabKey : 'issues';
  });

  const [tabs, setTabs] = useState<Record<TabKey, TabState>>(() => (
    initialRepoCache?.tabs ?? {
      issues: emptyTab(),
      prs: emptyTab(),
      branches: emptyTab(),
      commits: emptyTab(),
      actions: emptyTab(),
    }
  ));

  // ── Expand/collapse detail state ──────────────────────────────────────
  const [expandedKey, setExpandedKey] = useState<string | null>(() => initialRepoCache?.expandedKey ?? null);
  const [detailData, setDetailData] = useState<Map<string, any>>(() => new Map(initialRepoCache?.detailData ?? []));
  const [detailState, setDetailState] = useState<Map<string, 'loading' | 'loaded' | 'error'>>(
    () => new Map((initialRepoCache?.detailData ?? []).map(([k]) => [k, 'loaded' as const])),
  );
  const [checkoutPendingBranch, setCheckoutPendingBranch] = useState<string | null>(null);
  const [checkoutFeedback, setCheckoutFeedback] = useState<CheckoutFeedback>(null);
  const [callbacks, setCallbacks] = useState<CallbackTaskRecord[]>(() => initialRepoCache?.callbacks ?? []);
  const [callbackRuntimeEnabled, setCallbackRuntimeEnabled] = useState(() => initialRepoCache?.callbackRuntimeEnabled ?? false);
  const [callbackChecking, setCallbackChecking] = useState(false);
  const [callbackLastCheckedAt, setCallbackLastCheckedAt] = useState<number | undefined>(() => initialRepoCache?.callbackLastCheckedAt);
  const [callbackLastError, setCallbackLastError] = useState<string | undefined>(() => initialRepoCache?.callbackLastError);

  // Track pending requestIds to discard stale responses
  const pendingRef = useRef<Set<string>>(new Set());
  const detailReqRef = useRef<Map<string, DetailRequestMeta>>(new Map());
  const tabReqRef = useRef<Map<string, TabRequestMeta>>(new Map());
  const detailDataRef = useRef<Map<string, any>>(new Map(initialRepoCache?.detailData ?? []));
  const detailStateRef = useRef<Map<string, 'loading' | 'loaded' | 'error'>>(
    new Map((initialRepoCache?.detailData ?? []).map(([k]) => [k, 'loaded' as const])),
  );
  // Track detect requestId separately
  const detectReqRef = useRef<{ id: string; force: boolean; preserveUi: boolean; background: boolean } | null>(null);
  const detectSeqRef = useRef(0);
  const checkoutReqRef = useRef<string | null>(null);
  const checkoutPendingBranchRef = useRef<string | null>(null);
  const processedCheckoutGenerationsRef = useRef<Set<number>>(new Set());
  const detectRetryCountRef = useRef(0);
  const detectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRetryCountRef = useRef<Map<string, number>>(new Map());
  const tabRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const detailRetryCountRef = useRef<Map<string, number>>(new Map());
  const detailRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const latestActionDetailRef = useRef<string | null>(null);
  const pendingCiFailureRef = useRef<Map<number, { id: number; name: string; status: string; conclusion?: string; url: string; updatedAt?: number }>>(new Map());
  const deliveredCiEventRef = useRef<Set<string>>(new Set());
  const lastFocusTokenRef = useRef<number | undefined>(undefined);
  const actionJobRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const callbackLiveStatusReceivedRef = useRef(false);
  const actionStepRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [focusedActionTargetKey, setFocusedActionTargetKey] = useState<string | null>(null);
  const [focusedActionTargetReplayClass, setFocusedActionTargetReplayClass] = useState<'repo-action-focus-a' | 'repo-action-focus-b'>('repo-action-focus-a');
  const contextRef = useRef<RepoContext | null>(initialRepoCache?.context ?? null);
  const contextFetchedAtRef = useRef<number | undefined>(initialRepoCache?.contextFetchedAt);
  const lastDetectAttemptRef = useRef<number>(0);
  const tabsRef = useRef(tabs);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const onCiEventRef = useRef(onCiEvent);
  onCiEventRef.current = onCiEvent;
  const tabLatestSeqRef = useRef<Map<TabKey, number>>(new Map());
  const lastRevalidateAttemptRef = useRef<Map<TabKey, number>>(new Map());
  const pendingLoadMoreAfterRebuildRef = useRef<Set<TabKey>>(new Set());
  const pendingForceInitialTabsRef = useRef(false);
  const fetchTabRef = useRef<((key: TabKey, page?: number, force?: boolean, opts?: { preserveUi?: boolean; background?: boolean }) => void) | null>(null);

  useEffect(() => {
    if (!initialTab) return;
    setActiveTab(initialTab);
    writeSafeLocalStorageItem('repo-active-tab', initialTab);
  }, [initialTab, initialTabToken]);

  useEffect(() => {
    contextRef.current = context;
  }, [context]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    detailStateRef.current = detailState;
  }, [detailState]);

  useEffect(() => {
    const hasAnyTab = (Object.values(tabs) as TabState[]).some((tab) => tab.fetched);
    if (!context && !hasAnyTab && detailData.size === 0 && callbacks.length === 0) return;
    setRepoPageCache(repoCacheKey, {
      context,
      contextFetchedAt: contextFetchedAtRef.current,
      tabs,
      expandedKey,
      detailData: [...detailData.entries()],
      callbacks,
      callbackRuntimeEnabled,
      callbackLastCheckedAt,
      callbackLastError,
      updatedAt: Date.now(),
    });
  }, [
    repoCacheKey,
    context,
    tabs,
    expandedKey,
    detailData,
    callbacks,
    callbackRuntimeEnabled,
    callbackLastCheckedAt,
    callbackLastError,
  ]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const updateTab = useCallback((key: TabKey, patch: Partial<TabState>) => {
    setTabs(prev => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      tabsRef.current = next;
      return next;
    });
  }, []);

  const getActiveBranch = useCallback(() => {
    const branch = contextRef.current?.currentBranch?.trim();
    return branch || undefined;
  }, []);

  const getActiveRepoGeneration = useCallback(() => {
    const generation = contextRef.current?.repoGeneration;
    return typeof generation === 'number' && Number.isFinite(generation) ? generation : undefined;
  }, []);

  const applyDetectContext = useCallback((rawContext: unknown, opts?: { skipBranchInvalidation?: boolean; background?: boolean }): boolean => {
    const accepted = ingestSessionRepoContext({ sessionId, projectDir, serverId, context: rawContext });
    const realDir = (rawContext as any)?.projectDir;
    if (typeof realDir === 'string' && realDir.trim() && realDir !== projectDir) {
      ingestSessionRepoContext({ sessionId, projectDir: realDir.trim(), serverId, context: rawContext });
    }
    if (!accepted) return false;
    const shared = getSessionRepoContext(sessionId, projectDir, serverId);
    const nextContext = mapDetectToContext(rawContext);
    if (shared?.currentBranch && !nextContext.currentBranch) nextContext.currentBranch = shared.currentBranch;
    if (typeof shared?.repoGeneration === 'number') nextContext.repoGeneration = shared.repoGeneration;
    if (typeof shared?.detectedAt === 'number') nextContext.detectedAt = shared.detectedAt;

    const prevContext = contextRef.current;
    const prevBranch = prevContext?.currentBranch?.trim() ?? '';
    const nextBranch = nextContext.currentBranch?.trim() ?? '';
    const prevGen = prevContext?.repoGeneration;
    const nextGen = nextContext.repoGeneration;
    const branchOrGenChanged = !opts?.skipBranchInvalidation
      && Boolean(prevContext)
      && (prevBranch !== nextBranch || (typeof prevGen === 'number' && typeof nextGen === 'number' && prevGen !== nextGen));

    contextFetchedAtRef.current = Date.now();
    contextRef.current = nextContext;
    setContext(nextContext);

    if (branchOrGenChanged) {
      for (const [requestId, meta] of tabReqRef.current) {
        if (meta.key === 'branches' || meta.key === 'commits') {
          pendingRef.current.delete(requestId);
          tabReqRef.current.delete(requestId);
        }
      }
      for (const key of ['branches', 'commits'] as const) {
        tabLatestSeqRef.current.set(key, (tabLatestSeqRef.current.get(key) ?? 0) + 1);
        lastRevalidateAttemptRef.current.delete(key);
        pendingLoadMoreAfterRebuildRef.current.delete(key);
        tabRetryCountRef.current.delete(key);
        const retryTimer = tabRetryTimersRef.current.get(key);
        if (retryTimer) clearTimeout(retryTimer);
        tabRetryTimersRef.current.delete(key);
      }
      for (const [requestId, meta] of detailReqRef.current) {
        if (meta.tab === 'commits') {
          pendingRef.current.delete(requestId);
          detailReqRef.current.delete(requestId);
        }
      }
      setExpandedKey((key) => key?.startsWith('commits:') ? null : key);
      detailDataRef.current = new Map([...detailDataRef.current].filter(([key]) => !key.startsWith('commits:')));
      setDetailData(prev => new Map([...prev].filter(([key]) => !key.startsWith('commits:'))));
      setDetailState(prev => new Map([...prev].filter(([key]) => !key.startsWith('commits:'))));

      const curActive = activeTabRef.current;
      const curBranches = tabsRef.current.branches;
      const curCommits = tabsRef.current.commits;
      setTabs(prev => {
        const next = {
          ...prev,
          branches: {
            ...prev.branches,
            fetchedAt: undefined,
            loading: false,
            refreshing: false,
            backgroundRefreshing: false,
            branchStale: true,
          },
          commits: {
            ...prev.commits,
            fetchedAt: undefined,
            loading: false,
            refreshing: false,
            backgroundRefreshing: false,
            branchStale: true,
          },
        };
        tabsRef.current = next;
        return next;
      });

      if (curActive === 'commits' || curActive === 'branches') {
        const existing = curActive === 'commits' ? curCommits : curBranches;
        const isForegroundRefresh = existing.refreshing || opts?.background === false;
        fetchTabRef.current?.(curActive, 1, true, {
          preserveUi: existing.fetched,
          background: existing.fetched ? !isForegroundRefresh : false,
        });
      }
    }
    return true;
  }, [projectDir, serverId, sessionId]);

  const isBranchScopedRequestStale = useCallback((meta: Pick<TabRequestMeta, 'key' | 'branch' | 'repoGeneration'>) => {
    if (meta.key !== 'branches' && meta.key !== 'commits') return false;
    const currentGeneration = getActiveRepoGeneration();
    if (typeof currentGeneration === 'number' && meta.repoGeneration !== currentGeneration) return true;
    if (meta.key === 'commits') {
      const activeBranch = getActiveBranch();
      if ((meta.branch ?? '') !== (activeBranch ?? '')) return true;
    }
    return false;
  }, [getActiveBranch, getActiveRepoGeneration]);

  const isCommitDetailRequestStale = useCallback((meta: DetailRequestMeta) => {
    if (meta.tab !== 'commits') return false;
    const currentGeneration = getActiveRepoGeneration();
    if (typeof currentGeneration === 'number' && meta.repoGeneration !== currentGeneration) return true;
    const activeBranch = getActiveBranch();
    return (meta.branch ?? '') !== (activeBranch ?? '');
  }, [getActiveBranch, getActiveRepoGeneration]);

  // ── Detail fetching (expand on click) ───────────────────────────────────

  const fetchDetail = useCallback((tab: 'commits' | 'prs' | 'issues', id: string | number) => {
    const key = `${tab}:${id}`;
    // Toggle collapse if already expanded
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    // Already loaded — just expand
    if (detailData.has(key) || detailStateRef.current.get(key) === 'loading') return;
    // Fetch
    setDetailState(prev => new Map(prev).set(key, 'loading'));
    try {
      let rid: string;
      const branch = tab === 'commits' ? getActiveBranch() : undefined;
      const repoGeneration = tab === 'commits' ? getActiveRepoGeneration() : undefined;
      if (tab === 'commits') {
        rid = ws.repoCommitDetail(requestProjectDir, id as string, sessionScope);
      } else if (tab === 'prs') {
        rid = ws.repoPRDetail(requestProjectDir, id as number, sessionScope);
      } else {
        rid = ws.repoIssueDetail(requestProjectDir, id as number, sessionScope);
      }
      pendingRef.current.add(rid);
      detailReqRef.current.set(rid, { key, tab, branch, repoGeneration });
    } catch {
      setDetailState(prev => new Map(prev).set(key, 'error'));
    }
  }, [ws, requestProjectDir, sessionId, expandedKey, detailData, getActiveBranch, getActiveRepoGeneration]);

  const fetchActionDetail = useCallback((runId: number, opts?: { force?: boolean }) => {
    const key = `actions:${runId}`;
    if (detailStateRef.current.get(key) === 'loading') return;
    setDetailState(prev => new Map(prev).set(key, 'loading'));
    try {
      const rid = ws.repoActionDetail(requestProjectDir, runId, { ...opts, ...sessionScope });
      pendingRef.current.add(rid);
      detailReqRef.current.set(rid, { key, tab: 'actions' });
    } catch {
      setDetailState(prev => new Map(prev).set(key, 'error'));
    }
  }, [ws, requestProjectDir, sessionId]);

  // ── Detect on mount ──────────────────────────────────────────────────────

  const detectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback((opts?: { preserveUi?: boolean; force?: boolean; background?: boolean; _isRetry?: boolean }) => {
    const preserveUi = opts?.preserveUi === true;
    const force = opts?.force === true;
    const background = opts?.background ?? preserveUi;
    const seq = ++detectSeqRef.current;
    if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
    detectTimeoutRef.current = null;
    if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
    detectRetryTimerRef.current = null;
    if (detectReqRef.current) {
      pendingRef.current.delete(detectReqRef.current.id);
      detectReqRef.current = null;
    }
    const currentContext = contextRef.current;
    if (!preserveUi || !currentContext) {
      setDetectLoading(true);
    }
    if (!opts?._isRetry) {
      detectRetryCountRef.current = 0;
    }
    if (!preserveUi) {
      setDetectError(null);
    }

    let rid: string;
    try {
      rid = ws.repoDetect(requestProjectDir, { ...(force ? { force: true } : {}), ...sessionScope });
    } catch (err) {
      const nextRetry = detectRetryCountRef.current + 1;
      if (isTransientWsSendError(err) && nextRetry <= MAX_SILENT_RETRIES) {
        detectRetryCountRef.current = nextRetry;
        detectRetryTimerRef.current = setTimeout(() => {
          detectRetryTimerRef.current = null;
          if (detectSeqRef.current !== seq) return;
          doDetect({ preserveUi: Boolean(preserveUi || contextRef.current), force, background, _isRetry: true });
        }, RETRY_DELAY_MS);
        if (!currentContext) {
          setDetectLoading(true);
          setDetectError(null);
        }
        return;
      }
      if (!currentContext) {
        setDetectError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        setDetectLoading(false);
      }
      return;
    }

    detectReqRef.current = { id: rid, force, preserveUi, background };
    pendingRef.current.add(rid);

    // Timeout: if no response within 10s, show error with debug info
    detectTimeoutRef.current = setTimeout(() => {
      if (detectReqRef.current?.id === rid && pendingRef.current.has(rid)) {
        pendingRef.current.delete(rid);
        detectReqRef.current = null;
        const nextRetry = detectRetryCountRef.current + 1;
        detectRetryCountRef.current = nextRetry;
        if (nextRetry <= MAX_SILENT_RETRIES) {
          if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
          detectRetryTimerRef.current = setTimeout(() => {
            detectRetryTimerRef.current = null;
            if (detectSeqRef.current !== seq) return;
            doDetect({ preserveUi: Boolean(preserveUi || contextRef.current), force, background, _isRetry: true });
          }, RETRY_DELAY_MS);
          if (!currentContext) {
            setDetectLoading(true);
            setDetectError(null);
          }
          return;
        }
        if (!currentContext) {
          setDetectError(`Detect timeout — no response after 10s (requestId: ${rid.slice(0, 8)})`);
          setDetectLoading(false);
        }
      }
    }, 10_000);
  }, [ws, requestProjectDir, sessionId]);

  useEffect(() => {
    if (!contextRef.current || !isTimestampFresh(contextFetchedAtRef.current)) {
      lastDetectAttemptRef.current = Date.now();
      doDetect({ preserveUi: Boolean(contextRef.current), background: Boolean(contextRef.current) });
    }
    return () => {
      detectSeqRef.current += 1;
      detectReqRef.current = null;
      checkoutReqRef.current = null;
      pendingRef.current.clear();
      tabReqRef.current.clear();
      detailReqRef.current.clear();
      if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
      if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
      for (const timer of tabRetryTimersRef.current.values()) clearTimeout(timer);
      tabRetryTimersRef.current.clear();
      for (const timer of detailRetryTimersRef.current.values()) clearTimeout(timer);
      detailRetryTimersRef.current.clear();
    };
  }, [doDetect]);

  // ── Tab data fetching ────────────────────────────────────────────────────

  const fetchTab = useCallback((key: TabKey, page = 1, force = false, opts?: { preserveUi?: boolean; background?: boolean; _isRetry?: boolean }) => {
    const seq = (tabLatestSeqRef.current.get(key) ?? 0) + 1;
    tabLatestSeqRef.current.set(key, seq);
    if (page === 1) {
      if (!opts?._isRetry) tabRetryCountRef.current.delete(key);
      for (const [reqId, existingMeta] of tabReqRef.current) {
        if (existingMeta.key === key) {
          pendingRef.current.delete(reqId);
          tabReqRef.current.delete(reqId);
        }
      }
      const pendingRetry = tabRetryTimersRef.current.get(key);
      if (pendingRetry) clearTimeout(pendingRetry);
      tabRetryTimersRef.current.delete(key);
    }
    const preserveUi = opts?.preserveUi === true;
    const background = opts?.background === true;
    const existingTab = tabsRef.current[key];
    const hasExistingData = preserveUi && existingTab.fetched;
    if (!preserveUi) {
      updateTab(key, { loading: true, refreshing: false, backgroundRefreshing: false, error: null });
    } else if (hasExistingData) {
      updateTab(key, background
        ? { loading: false, refreshing: false, backgroundRefreshing: true }
        : { loading: false, refreshing: true, backgroundRefreshing: false });
    } else {
      updateTab(key, { loading: true, refreshing: false, backgroundRefreshing: false });
    }
    let rid: string;
    try {
      const branch = key === 'commits' ? getActiveBranch() : undefined;
      switch (key) {
        case 'issues':
          rid = ws.repoListIssues(requestProjectDir, { page, ...(force ? { force: true } : {}), ...sessionScope });
          break;
        case 'prs':
          rid = ws.repoListPRs(requestProjectDir, { page, ...(force ? { force: true } : {}), ...sessionScope });
          break;
        case 'branches':
          rid = ws.repoListBranches(requestProjectDir, { ...(force ? { force: true } : {}), ...sessionScope });
          break;
        case 'commits':
          rid = ws.repoListCommits(requestProjectDir, { page, ...(branch ? { branch } : {}), ...(force ? { force: true } : {}), ...sessionScope });
          break;
        case 'actions':
          rid = ws.repoListActions(requestProjectDir, { page, ...(force ? { force: true } : {}), ...sessionScope });
          break;
      }
    } catch (err) {
      const latestTab = tabsRef.current[key];
      const hasCachedData = latestTab.fetched;
      const nextRetry = (tabRetryCountRef.current.get(key) ?? 0) + 1;
      if (isTransientWsSendError(err) && nextRetry <= MAX_SILENT_RETRIES) {
        tabRetryCountRef.current.set(key, nextRetry);
        const existingTimer = tabRetryTimersRef.current.get(key);
        if (existingTimer) clearTimeout(existingTimer);
        tabRetryTimersRef.current.set(key, setTimeout(() => {
          tabRetryTimersRef.current.delete(key);
          if (seq !== tabLatestSeqRef.current.get(key)) return;
          fetchTab(key, page, force, { preserveUi: hasCachedData || preserveUi, background, _isRetry: true });
        }, RETRY_DELAY_MS));
        updateTab(key, {
          loading: !hasCachedData,
          refreshing: Boolean(hasCachedData && !background),
          backgroundRefreshing: Boolean(hasCachedData && background),
          error: null,
        });
        return;
      }
      tabRetryCountRef.current.delete(key);
      const message = err instanceof Error ? err.message : String(err || 'Send failed');
      updateTab(key, {
        loading: false,
        refreshing: false,
        backgroundRefreshing: false,
        error: hasCachedData ? null : `Send failed: ${message}`,
        fetched: hasCachedData,
      });
      return;
    }
    pendingRef.current.add(rid);
    tabReqRef.current.set(rid, {
      key,
      page,
      force,
      seq,
      background,
      ...(key === 'commits' && getActiveBranch() ? { branch: getActiveBranch() } : {}),
      ...(getActiveRepoGeneration() !== undefined ? { repoGeneration: getActiveRepoGeneration() } : {}),
    });
  }, [ws, requestProjectDir, sessionId, updateTab, getActiveBranch, getActiveRepoGeneration]);
  fetchTabRef.current = fetchTab;

  // Lazy-load: fetch tab data on first activation, or silently refresh expired/truncated tab
  useEffect(() => {
    if (!context) return; // wait until detect completes
    const tab = tabs[activeTab];
    const forceAfterReconnect = pendingForceInitialTabsRef.current;
    if (!tab.fetched && !tab.loading && !tab.error) {
      if (forceAfterReconnect && activeTab !== 'actions') pendingForceInitialTabsRef.current = false;
      fetchTab(activeTab, 1, forceAfterReconnect);
    } else if (
      tab.fetched
      && isTabStale(tab)
      && !tab.refreshing
      && !tab.backgroundRefreshing
      && !tab.loading
      && !isTimestampFresh(lastRevalidateAttemptRef.current.get(activeTab))
    ) {
      lastRevalidateAttemptRef.current.set(activeTab, Date.now());
      fetchTab(activeTab, 1, false, { preserveUi: true, background: true });
    }
  }, [activeTab, context, tabs, fetchTab]);

  // Auto-fetch CI/CD on detect complete (so auto-refresh works even if tab not visited)
  useEffect(() => {
    if (!context) return;
    const actionsTab = tabs.actions;
    const forceAfterReconnect = pendingForceInitialTabsRef.current;
    if (!actionsTab.fetched && !actionsTab.loading && !actionsTab.error) {
      pendingForceInitialTabsRef.current = false;
      fetchTab('actions', 1, forceAfterReconnect);
    } else if (
      actionsTab.fetched
      && isTabStale(actionsTab)
      && !actionsTab.refreshing
      && !actionsTab.backgroundRefreshing
      && !actionsTab.loading
      && !isTimestampFresh(lastRevalidateAttemptRef.current.get('actions'))
    ) {
      lastRevalidateAttemptRef.current.set('actions', Date.now());
      fetchTab('actions', 1, false, { preserveUi: true, background: true });
    }
  }, [context, tabs.actions, fetchTab]);

  useEffect(() => {
    if (!focusLatestAction?.token || lastFocusTokenRef.current === focusLatestAction.token) return;
    lastFocusTokenRef.current = focusLatestAction.token;
    setActiveTab('actions');
    writeSafeLocalStorageItem('repo-active-tab', 'actions');
  }, [focusLatestAction]);

  useEffect(() => {
    if (scopeToSessionRoot) return;
    let cancelled = false;
    callbackLiveStatusReceivedRef.current = false;
    if (serverId && requestProjectDir) {
      void loadRepoCallbackPrefs(serverId, requestProjectDir)
        .then((loaded) => {
          if (cancelled || callbackLiveStatusReceivedRef.current) return;
          setCallbackRuntimeEnabled(Boolean(loaded.repoConfig.enabled));
        })
        .catch(() => {
          // Ignore until live CALLBACK_STATUS_RESPONSE arrives.
        });
    }
    try {
      ws.repoCallbackStatus?.(requestProjectDir);
    } catch {
      // Ignore while connecting; RECONNECTED handler refreshes once live.
    }
    return () => {
      cancelled = true;
    };
  }, [ws, serverId, requestProjectDir, scopeToSessionRoot]);

  // ── Message handler ──────────────────────────────────────────────────────

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      // WS reconnected — clear stale pending requests, re-detect
      if (msg.type === DAEMON_MSG.RECONNECTED || (msg.type === 'session.event' && (msg as any).event === 'connected')) {
        pendingRef.current.clear();
        detailReqRef.current.clear();
        tabReqRef.current.clear();
        detectSeqRef.current += 1;
        detectReqRef.current = null;
        checkoutReqRef.current = null;
        setCheckoutPendingBranch(null);
        checkoutPendingBranchRef.current = null;
        if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
        if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
        detectRetryTimerRef.current = null;
        detectRetryCountRef.current = 0;
        lastDetectAttemptRef.current = Date.now();
        lastRevalidateAttemptRef.current.clear();
        pendingLoadMoreAfterRebuildRef.current.clear();
        for (const key of ['issues', 'prs', 'branches', 'commits', 'actions'] as TabKey[]) {
          tabLatestSeqRef.current.set(key, (tabLatestSeqRef.current.get(key) ?? 0) + 1);
        }
        const prevTabs = tabsRef.current;
        const actionsWasInFlight = prevTabs.actions.loading || prevTabs.actions.refreshing || prevTabs.actions.backgroundRefreshing;
        const clearedTabs: Record<TabKey, TabState> = {
          issues: { ...prevTabs.issues, loading: false, refreshing: false, backgroundRefreshing: false },
          prs: { ...prevTabs.prs, loading: false, refreshing: false, backgroundRefreshing: false },
          branches: { ...prevTabs.branches, loading: false, refreshing: false, backgroundRefreshing: false },
          commits: { ...prevTabs.commits, loading: false, refreshing: false, backgroundRefreshing: false },
          actions: { ...prevTabs.actions, loading: false, refreshing: false, backgroundRefreshing: false },
        };
        tabsRef.current = clearedTabs;
        setTabs(clearedTabs);
        if (!scopeToSessionRoot) {
          try {
            ws.repoCallbackStatus?.(requestProjectDir);
          } catch {
            // ignore
          }
        }
        for (const timer of tabRetryTimersRef.current.values()) clearTimeout(timer);
        tabRetryTimersRef.current.clear();
        tabRetryCountRef.current.clear();
        for (const timer of detailRetryTimersRef.current.values()) clearTimeout(timer);
        detailRetryTimersRef.current.clear();
        detailRetryCountRef.current.clear();
        latestActionDetailRef.current = null;
        pendingCiFailureRef.current.clear();
        deliveredCiEventRef.current.clear();
        doDetect({ preserveUi: Boolean(contextRef.current), force: true, background: Boolean(contextRef.current) });
        const currentActiveTab = activeTabRef.current;
        if (contextRef.current) {
          const activeFetched = clearedTabs[currentActiveTab].fetched;
          fetchTab(currentActiveTab, 1, true, { preserveUi: activeFetched, background: activeFetched });
          if (currentActiveTab !== 'actions' && (clearedTabs.actions.fetched || actionsWasInFlight)) {
            fetchTab('actions', 1, true, { preserveUi: clearedTabs.actions.fetched, background: clearedTabs.actions.fetched });
          }
        } else {
          pendingForceInitialTabsRef.current = true;
        }
        return;
      }

      // Detect response
      if (msg.type === REPO_MSG.DETECT_RESPONSE) {
        if (msg.requestId !== detectReqRef.current?.id) return;
        const completedDetect = detectReqRef.current;
        detectReqRef.current = null;
        pendingRef.current.delete(msg.requestId);
        if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
        if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
        detectRetryTimerRef.current = null;
        detectRetryCountRef.current = 0;
        applyDetectContext((msg as any).context ?? msg, { background: completedDetect.background });
        setDetectLoading(false);
        setDetectError(null);
        return;
      }

      // Passive detect push — only accept if projectDir matches
      if (msg.type === REPO_MSG.DETECTED) {
        if (!responseMatchesProject(msg.projectDir)) return;
        applyDetectContext(msg.context, { background: true });
        return;
      }

      // Error response
      if (msg.type === REPO_MSG.ERROR) {
        if (!pendingRef.current.has(msg.requestId)) return;
        pendingRef.current.delete(msg.requestId);
        if (msg.requestId === checkoutReqRef.current) {
          checkoutReqRef.current = null;
          const pendingBranch = checkoutPendingBranchRef.current;
          checkoutPendingBranchRef.current = null;
          setCheckoutPendingBranch(null);
          setCheckoutFeedback({ kind: 'error', error: msg.error, branch: pendingBranch ?? undefined });
          return;
        }
        const detailMeta = detailReqRef.current.get(msg.requestId);
        if (detailMeta) {
          detailReqRef.current.delete(msg.requestId);
          const detailKey = detailMeta.key;
          const retryKey = detailKey;
          const existingDetail = detailDataRef.current.get(detailKey);
          const nextRetry = (detailRetryCountRef.current.get(retryKey) ?? 0) + 1;
          const latestAction = tabsRef.current.actions.items[0] as any;
          const isLatestActionDetail = detailKey === `actions:${latestAction?.id}`;
          const latestActionStatus = latestAction?.status;
          const runId = detailKey.startsWith('actions:') ? Number(detailKey.slice('actions:'.length)) : null;
          const canSilentRetry = detailKey.startsWith('actions:')
            && (isLatestActionDetail || !!existingDetail)
            && nextRetry <= MAX_SILENT_RETRIES
            && Number.isFinite(runId);

          if (canSilentRetry && runId != null) {
            detailRetryCountRef.current.set(retryKey, nextRetry);
            const existingTimer = detailRetryTimersRef.current.get(retryKey);
            if (existingTimer) clearTimeout(existingTimer);
            detailRetryTimersRef.current.set(retryKey, setTimeout(() => {
              detailRetryTimersRef.current.delete(retryKey);
              fetchActionDetail(runId, { force: latestActionStatus === 'running' || latestActionStatus === 'queued' || latestActionStatus === 'failure' });
            }, RETRY_DELAY_MS));
            setDetailState(prev => {
              const next = new Map(prev);
              if (existingDetail) next.set(detailKey, 'loaded');
              else next.set(detailKey, 'loading');
              return next;
            });
          } else {
            detailRetryCountRef.current.delete(retryKey);
            const existingTimer = detailRetryTimersRef.current.get(retryKey);
            if (existingTimer) clearTimeout(existingTimer);
            detailRetryTimersRef.current.delete(retryKey);
            setDetailState(prev => new Map(prev).set(detailKey, existingDetail ? 'loaded' : 'error'));
          }
          return;
        }
        // Could be detect error or tab error
        if (msg.requestId === detectReqRef.current?.id) {
          const failedDetect = detectReqRef.current;
          detectReqRef.current = null;
          const retrySeq = detectSeqRef.current;
          if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
          detectTimeoutRef.current = null;
          const nextRetry = detectRetryCountRef.current + 1;
          detectRetryCountRef.current = nextRetry;
          if (contextRef.current && nextRetry <= MAX_SILENT_RETRIES) {
            if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
            detectRetryTimerRef.current = setTimeout(() => {
              detectRetryTimerRef.current = null;
              if (detectSeqRef.current !== retrySeq) return;
              doDetect({ preserveUi: Boolean(failedDetect.preserveUi || contextRef.current), force: failedDetect.force, background: failedDetect.background, _isRetry: true });
            }, RETRY_DELAY_MS);
            setDetectLoading(false);
          } else if (!contextRef.current) {
            setDetectError(msg.error);
            setDetectLoading(false);
          } else {
            setDetectLoading(false);
          }
        } else {
          const meta = tabReqRef.current.get(msg.requestId);
          if (meta) {
            tabReqRef.current.delete(msg.requestId);
            if (meta.seq !== tabLatestSeqRef.current.get(meta.key)) return;
            const retryKey = meta.key;
            const nextRetry = (tabRetryCountRef.current.get(retryKey) ?? 0) + 1;
            const existingTab = tabsRef.current[meta.key];
            const hasExistingData = existingTab.fetched;
            if (hasExistingData && nextRetry <= MAX_SILENT_RETRIES) {
              tabRetryCountRef.current.set(retryKey, nextRetry);
              const existingTimer = tabRetryTimersRef.current.get(retryKey);
              if (existingTimer) clearTimeout(existingTimer);
              tabRetryTimersRef.current.set(retryKey, setTimeout(() => {
                tabRetryTimersRef.current.delete(retryKey);
                if (meta.seq !== tabLatestSeqRef.current.get(meta.key)) return;
                fetchTab(meta.key, meta.page, meta.force, { preserveUi: hasExistingData, background: meta.background, _isRetry: true });
              }, RETRY_DELAY_MS));
              updateTab(meta.key, { loading: false, refreshing: Boolean(hasExistingData && !meta.background), backgroundRefreshing: Boolean(hasExistingData && meta.background), error: msg.error });
            } else {
              tabRetryCountRef.current.delete(retryKey);
              const existingTimer = tabRetryTimersRef.current.get(retryKey);
              if (existingTimer) clearTimeout(existingTimer);
              tabRetryTimersRef.current.delete(retryKey);
              updateTab(meta.key, {
                loading: false,
                refreshing: false,
                backgroundRefreshing: false,
                error: hasExistingData ? null : msg.error,
                fetched: existingTab.fetched,
              });
            }
          }
        }
        return;
      }

      if (msg.type === REPO_MSG.CHECKOUT_BRANCH_RESPONSE) {
        const m = msg as any;
        if (!responseMatchesProject(m.projectDir)) return;
        if (!m.requestId || m.requestId !== checkoutReqRef.current) return;
        pendingRef.current.delete(m.requestId);
        checkoutReqRef.current = null;
        checkoutPendingBranchRef.current = null;
        setCheckoutPendingBranch(null);

        const previousContext = contextRef.current;
        applyDetectContext({
          status: previousContext?.status ?? 'ok',
          info: {
            platform: previousContext?.provider,
            owner: previousContext?.owner,
            repo: previousContext?.repo,
            defaultBranch: previousContext?.defaultBranch,
            currentBranch: m.currentBranch,
          },
          currentBranch: m.currentBranch,
          defaultBranch: previousContext?.defaultBranch,
          repoGeneration: m.repoGeneration,
          detectedAt: m.detectedAt,
        }, { skipBranchInvalidation: true });
        setCheckoutFeedback({ kind: 'success', branch: m.currentBranch });

        const generation = typeof m.repoGeneration === 'number' && Number.isFinite(m.repoGeneration)
          ? m.repoGeneration
          : null;
        if (generation == null || !processedCheckoutGenerationsRef.current.has(generation)) {
          if (generation != null) processedCheckoutGenerationsRef.current.add(generation);
          for (const [requestId, meta] of tabReqRef.current) {
            if (meta.key === 'branches' || meta.key === 'commits') {
              pendingRef.current.delete(requestId);
              tabReqRef.current.delete(requestId);
            }
          }
          for (const [requestId, meta] of detailReqRef.current) {
            if (meta.tab === 'commits') {
              pendingRef.current.delete(requestId);
              detailReqRef.current.delete(requestId);
            }
          }
          setExpandedKey((key) => key?.startsWith('commits:') ? null : key);
          detailDataRef.current = new Map([...detailDataRef.current].filter(([key]) => !key.startsWith('commits:')));
          setDetailData(prev => new Map([...prev].filter(([key]) => !key.startsWith('commits:'))));
          setDetailState(prev => new Map([...prev].filter(([key]) => !key.startsWith('commits:'))));
          setTabs(prev => ({
            ...prev,
            branches: emptyTab(),
            commits: emptyTab(),
          }));
          lastRevalidateAttemptRef.current.delete('branches');
          lastRevalidateAttemptRef.current.delete('commits');
          doDetect({ preserveUi: true, force: true });
          fetchTab('branches', 1, true);
          fetchTab('commits', 1, true);
          forceRefreshSharedChangesForCheckout(
            ws,
            requestProjectDir,
            generation ?? undefined,
            scopeToSessionRoot ? sessionId ?? undefined : undefined,
            serverId,
          );
        }
        return;
      }

      // Detail responses
      if (msg.type === REPO_MSG.ACTION_DETAIL_RESPONSE) {
        const m = msg as any;
        if (!responseMatchesProject(m.projectDir)) return;
        if (m.requestId) {
          const meta = detailReqRef.current.get(m.requestId);
          if (!meta || meta.tab !== 'actions') return;
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
        }
        detailRetryCountRef.current.delete(`actions:${m.detail.runId}`);
        const retryTimer = detailRetryTimersRef.current.get(`actions:${m.detail.runId}`);
        if (retryTimer) clearTimeout(retryTimer);
        detailRetryTimersRef.current.delete(`actions:${m.detail.runId}`);
        detailDataRef.current = new Map(detailDataRef.current).set(`actions:${m.detail.runId}`, m.detail);
        setDetailData(prev => new Map(prev).set(`actions:${m.detail.runId}`, m.detail));
        setDetailState(prev => new Map(prev).set(`actions:${m.detail.runId}`, 'loaded'));
        const pendingRun = pendingCiFailureRef.current.get(m.detail.runId);
        if (pendingRun) {
          pendingCiFailureRef.current.delete(m.detail.runId);
          emitCiEvent(pendingRun, m.detail);
        }
        return;
      }
      if (msg.type === REPO_MSG.COMMIT_DETAIL_RESPONSE) {
        const m = msg as any;
        if (!responseMatchesProject(m.projectDir)) return;
        if (!m.requestId) return;
        const meta = detailReqRef.current.get(m.requestId);
        if (!meta || meta.tab !== 'commits' || isCommitDetailRequestStale(meta)) {
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
          return;
        }
        pendingRef.current.delete(m.requestId);
        detailReqRef.current.delete(m.requestId);
        const key = meta.key;
        detailDataRef.current = new Map(detailDataRef.current).set(key, m.detail);
        setDetailData(prev => new Map(prev).set(key, m.detail));
        setDetailState(prev => new Map(prev).set(key, 'loaded'));
        return;
      }
      if (msg.type === REPO_MSG.PR_DETAIL_RESPONSE) {
        const m = msg as any;
        if (!responseMatchesProject(m.projectDir)) return;
        if (m.requestId) {
          const meta = detailReqRef.current.get(m.requestId);
          if (!meta || meta.tab !== 'prs') return;
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
        }
        detailDataRef.current = new Map(detailDataRef.current).set(`prs:${m.detail.number}`, m.detail);
        setDetailData(prev => new Map(prev).set(`prs:${m.detail.number}`, m.detail));
        setDetailState(prev => new Map(prev).set(`prs:${m.detail.number}`, 'loaded'));
        return;
      }
      if (msg.type === REPO_MSG.ISSUE_DETAIL_RESPONSE) {
        const m = msg as any;
        if (!responseMatchesProject(m.projectDir)) return;
        if (m.requestId) {
          const meta = detailReqRef.current.get(m.requestId);
          if (!meta || meta.tab !== 'issues') return;
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
        }
        detailDataRef.current = new Map(detailDataRef.current).set(`issues:${m.detail.number}`, m.detail);
        setDetailData(prev => new Map(prev).set(`issues:${m.detail.number}`, m.detail));
        setDetailState(prev => new Map(prev).set(`issues:${m.detail.number}`, 'loaded'));
        return;
      }

      if (msg.type === REPO_MSG.CALLBACK_STATUS_RESPONSE) {
        if (!responseMatchesProject(msg.projectDir)) return;
        callbackLiveStatusReceivedRef.current = true;
        setCallbacks(Array.isArray(msg.callbacks) ? msg.callbacks : []);
        setCallbackRuntimeEnabled(Boolean(msg.enabled));
        setCallbackChecking(Boolean(msg.checking));
        setCallbackLastCheckedAt(msg.lastCheckedAt);
        setCallbackLastError(msg.lastError);
        return;
      }
      if (msg.type === REPO_MSG.CALLBACK_EVENT) {
        if (!responseMatchesProject(msg.projectDir)) return;
        const incoming = msg.callback;
        setCallbacks((prev) => {
          const next = [incoming, ...prev.filter((item) => item.callbackId !== incoming.callbackId)];
          next.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
          return next.slice(0, REPO_CALLBACK_RECENT_HISTORY_LIMIT);
        });
        return;
      }

      // Tab responses
      const tabMap: Record<string, TabKey> = {
        [REPO_MSG.ISSUES_RESPONSE]: 'issues',
        [REPO_MSG.PRS_RESPONSE]: 'prs',
        [REPO_MSG.BRANCHES_RESPONSE]: 'branches',
        [REPO_MSG.COMMITS_RESPONSE]: 'commits',
        [REPO_MSG.ACTIONS_RESPONSE]: 'actions',
      };
      const tabKey = tabMap[msg.type];
      if (tabKey && 'requestId' in msg && 'projectDir' in msg) {
        const m = msg as any;
        if (!pendingRef.current.has(m.requestId)) return;
        const meta = tabReqRef.current.get(m.requestId);
        if (!meta || meta.key !== tabKey) {
          pendingRef.current.delete(m.requestId);
          tabReqRef.current.delete(m.requestId);
          return;
        }
        pendingRef.current.delete(m.requestId);
        tabReqRef.current.delete(m.requestId);
        tabRetryCountRef.current.delete(tabKey);
        const retryTimer = tabRetryTimersRef.current.get(tabKey);
        if (retryTimer) clearTimeout(retryTimer);
        tabRetryTimersRef.current.delete(tabKey);
        // Stale response check — projectDir, request generation, and branch scope must match
        if (!responseMatchesProject(m.projectDir)) return;
        if (meta.seq !== tabLatestSeqRef.current.get(tabKey)) return;
        if (isBranchScopedRequestStale(meta)) {
          if (tabKey === activeTabRef.current) {
            fetchTab(tabKey, 1, meta.force, { preserveUi: Boolean(tabsRef.current[tabKey]?.fetched), background: meta.background });
          } else {
            updateTab(tabKey, { loading: false, refreshing: false, backgroundRefreshing: false, fetchedAt: undefined });
          }
          return;
        }
        const isLoadMore = m.page > 1;
        const currentTabSnapshot = tabsRef.current[tabKey];
        if (isLoadMore && (currentTabSnapshot.branchStale || ((tabKey === 'commits' || tabKey === 'branches') && ((currentTabSnapshot.cursorBranch !== undefined && currentTabSnapshot.cursorBranch !== (meta.branch ?? '')) || (currentTabSnapshot.cursorRepoGeneration !== undefined && currentTabSnapshot.cursorRepoGeneration !== meta.repoGeneration))))) {
          fetchTab(tabKey, 1, meta.force, { preserveUi: Boolean(currentTabSnapshot.fetched), background: meta.background });
          return;
        }
        setTabs(prev => {
          const existing = prev[tabKey];
          // Detect newly completed CI/CD runs (was running/queued, now success/failure)
          if (tabKey === 'actions' && !isLoadMore && existing.fetched && onCiEventRef.current) {
            const oldStatuses = new Map(existing.items.map((r: any) => [r.id, r.status]));
            for (const run of m.items) {
              const prevStatus = oldStatuses.get(run.id);
              if (prevStatus && (prevStatus === 'running' || prevStatus === 'queued') && (run.status === 'success' || run.status === 'failure')) {
                if (run.status === 'failure') {
                  const detail = detailDataRef.current.get(`actions:${run.id}`);
                  if (detail) {
                    emitCiEvent(run, detail);
                  } else {
                    pendingCiFailureRef.current.set(run.id, run);
                  }
                } else {
                  emitCiEvent(run);
                }
              }
            }
          }
          const nextItems = isLoadMore
            ? mergePaginatedItems(tabKey, existing.items, m.items)
            : mergePaginatedItems(tabKey, [], m.items);
          const addedUniqueCount = isLoadMore ? (nextItems.length - existing.items.length) : nextItems.length;
          const nextPageLengths = isLoadMore
            ? [...(existing.pageLengths ?? [existing.items.length]), addedUniqueCount]
            : [nextItems.length];
          const next = {
            ...prev,
            [tabKey]: {
              items: nextItems,
              page: m.page,
              hasMore: m.hasMore,
              loading: false,
              refreshing: false,
              backgroundRefreshing: false,
              error: null,
              fetched: true,
              fetchedAt: Date.now(),
              pageLengths: nextPageLengths,
              truncated: false,
              branchStale: false,
              ...(meta.branch !== undefined ? { cursorBranch: meta.branch } : {}),
              ...(meta.repoGeneration !== undefined ? { cursorRepoGeneration: meta.repoGeneration } : {}),
            },
          };
          tabsRef.current = next;
          return next;
        });
        if (!isLoadMore && pendingLoadMoreAfterRebuildRef.current.has(tabKey)) {
          pendingLoadMoreAfterRebuildRef.current.delete(tabKey);
          if (m.hasMore) {
            fetchTab(tabKey, 2);
          }
        }
      }
    });
  }, [
    ws,
    projectDir,
    requestProjectDir,
    sessionId,
    scopeToSessionRoot,
    responseMatchesProject,
    doDetect,
    fetchActionDetail,
  ]);

  useEffect(() => {
    if (!tabs.actions.fetched || tabs.actions.items.length === 0) return;
    const latest = tabs.actions.items[0] as any;
    if (!latest?.id) return;
    if (latest.status !== 'running' && latest.status !== 'failure') return;
    const fingerprint = `${latest.id}:${latest.status}:${latest.updatedAt ?? 0}`;
    if (latestActionDetailRef.current === fingerprint) return;
    latestActionDetailRef.current = fingerprint;
    fetchActionDetail(latest.id, { force: latest.status === 'running' });
  }, [tabs.actions.fetched, tabs.actions.items, fetchActionDetail]);

  useEffect(() => {
    if (!focusLatestAction?.token || !tabs.actions.fetched || tabs.actions.items.length === 0) return;
    const latest = tabs.actions.items[0] as any;
    if (!latest?.id) return;
    const actionKey = `actions:${latest.id}`;
    setExpandedKey(actionKey);
    const detail = detailData.get(actionKey);
    const state = detailState.get(actionKey);
    if (!detail && state !== 'loading') {
      fetchActionDetail(latest.id, { force: true });
    }
  }, [focusLatestAction, tabs.actions.fetched, tabs.actions.items, detailData, detailState, fetchActionDetail]);

  useEffect(() => {
    if (!focusLatestAction?.token || !tabs.actions.fetched || tabs.actions.items.length === 0) return;
    const latest = tabs.actions.items[0] as any;
    if (!latest?.id) return;
    const actionKey = `actions:${latest.id}`;
    const detail = detailData.get(actionKey);
    if (!detail) return;

    const stepKey = focusLatestAction.failedJobName && focusLatestAction.failedStepName
      ? `${latest.id}:${focusLatestAction.failedJobName}:${focusLatestAction.failedStepName}`
      : null;
    const jobKey = focusLatestAction.failedJobName ? `${latest.id}:${focusLatestAction.failedJobName}` : null;

    const stepEl = stepKey ? actionStepRefs.current.get(stepKey) : null;
    const jobEl = jobKey ? actionJobRefs.current.get(jobKey) : null;
    const targetEl = stepEl ?? jobEl;
    const targetKey = stepKey && stepEl ? stepKey : jobKey && jobEl ? jobKey : null;
    if (!targetEl) return;

    setFocusedActionTargetKey(targetKey);
    setFocusedActionTargetReplayClass((current) => current === 'repo-action-focus-a' ? 'repo-action-focus-b' : 'repo-action-focus-a');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }, [focusLatestAction, tabs.actions.fetched, tabs.actions.items, detailData]);

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Silently refresh a tab in background — keep existing items visible without tab spinner. */
  const silentRefreshTab = useCallback((key: TabKey) => {
    fetchTab(key, 1, true, { preserveUi: true, background: true });
  }, [fetchTab]);

  const handleManualRefresh = useCallback(() => {
    lastDetectAttemptRef.current = Date.now();
    doDetect({ preserveUi: Boolean(contextRef.current), force: true, background: false });
    const curTab = activeTabRef.current;
    lastRevalidateAttemptRef.current.set(curTab, Date.now());
    fetchTab(curTab, 1, true, { preserveUi: Boolean(tabsRef.current[curTab]?.fetched) });
    if (!scopeToSessionRoot) {
      try {
        ws.repoCallbackStatus?.(requestProjectDir);
      } catch {
        // ignore transient send errors
      }
    }
  }, [doDetect, fetchTab, requestProjectDir, scopeToSessionRoot, ws]);

  const checkoutErrorMessage = useCallback((error: string) => {
    const keyByError: Record<string, string> = {
      dirty_worktree: 'repo.checkout_dirty_worktree',
      git_operation_in_progress: 'repo.checkout_git_operation_in_progress',
      invalid_checkout_target: 'repo.checkout_invalid_target',
      checkout_in_progress: 'repo.checkout_in_progress',
      repo_busy: 'repo.checkout_busy',
      branch_in_use: 'repo.checkout_branch_in_use',
      detached_head: 'repo.checkout_detached_head',
      not_a_git_repo: 'repo.checkout_not_a_git_repo',
      checkout_failed: 'repo.checkout_failed',
      cli_error: 'repo.checkout_failed',
    };
    return t(keyByError[error] ?? 'repo.checkout_failed');
  }, [t]);

  const handleCheckoutBranch = useCallback((branch: string) => {
    if (checkoutReqRef.current || checkoutPendingBranch) return;
    setCheckoutFeedback(null);
    setCheckoutPendingBranch(branch);
    checkoutPendingBranchRef.current = branch;
    try {
      const rid = ws.repoCheckoutBranch(requestProjectDir, branch, { sessionId });
      checkoutReqRef.current = rid;
      pendingRef.current.add(rid);
    } catch {
      checkoutReqRef.current = null;
      checkoutPendingBranchRef.current = null;
      setCheckoutPendingBranch(null);
      setCheckoutFeedback({ kind: 'error', error: 'checkout_failed', branch });
    }
  }, [checkoutPendingBranch, requestProjectDir, sessionId, ws]);

  // ── CI/CD auto-refresh: 10s when running, 30s otherwise (always active) ─
  useEffect(() => {
    if (!tabs.actions.fetched) return;
    const hasRunning = tabs.actions.items.some((r: any) => r.status === 'running' || r.status === 'queued');
    const interval = hasRunning ? 30_000 : 60_000;
    const timer = setInterval(() => {
      silentRefreshTab('actions');
    }, interval);
    return () => clearInterval(timer);
  }, [tabs.actions.items, tabs.actions.fetched, silentRefreshTab]);

  const handleLoadMore = useCallback(() => {
    const tab = tabs[activeTab];
    if (tab.loading || tab.branchStale || !tab.hasMore) return;
    if (tab.refreshing || tab.backgroundRefreshing) {
      pendingLoadMoreAfterRebuildRef.current.add(activeTab);
      return;
    }
    if (tab.truncated) {
      pendingLoadMoreAfterRebuildRef.current.add(activeTab);
      fetchTab(activeTab, 1, false, { preserveUi: true, background: true });
      return;
    }
    fetchTab(activeTab, tab.page + 1);
  }, [activeTab, tabs, fetchTab]);

  const handleTabClick = useCallback((key: TabKey) => {
    setActiveTab(key);
    writeSafeLocalStorageItem('repo-active-tab', key);
  }, []);

  // ── Render helpers ───────────────────────────────────────────────────────

  const formatTime = (ts: number) => new Date(ts).toLocaleString();

  const TAB_LABELS: Record<TabKey, string> = {
    issues: t('repo.tab_issues'),
    prs: t('repo.tab_prs'),
    branches: t('repo.tab_branches'),
    commits: t('repo.tab_commits'),
    actions: t('repo.tab_cicd'),
  };

  const shouldPreserveTabContent = (tab: TabState) => tab.fetched;

  const statusPillClass = (status: unknown, conclusion?: unknown): string => {
    if (status === 'in_progress' || status === 'running') return 'is-running';
    if (status === 'queued' || status === 'waiting' || status === 'pending') return 'is-queued';
    const raw = typeof conclusion === 'string' && conclusion ? conclusion : (typeof status === 'string' ? status : '');
    const val = raw.toLowerCase();
    if (val === 'open' || val === 'success') return 'is-open';
    if (val === 'merged') return 'is-merged';
    if (val === 'closed' || val === 'failure') return 'is-failure';
    if (val === 'cancelled') return 'is-cancelled';
    return '';
  };

  const renderDiffStats = (additions: number, deletions: number, filesCount: number, suffix?: ComponentChildren) => (
    <div class="repo-detail-stats">
      <span class="repo-stat-add">+{additions}</span>
      <span class="repo-stat-del">-{deletions}</span>
      <span class="repo-stat-files">{filesCount} {t('repo.files')}</span>
      {suffix}
    </div>
  );

  const renderError = (error: string, tabKey: TabKey) => {
    const kind = classifyError(error);
    return (
      <div class="repo-state-box is-error">
        <div class="repo-state-title">{error}</div>
        {kind === 'cli_missing' && (
          <div class="repo-state-hint">
            {t('repo.error_cli_missing_hint')}{' '}
            <a href="https://cli.github.com" target="_blank" rel="noopener">
              cli.github.com
            </a>
          </div>
        )}
        {kind === 'unauthorized' && (
          <div class="repo-state-hint">
            {t('repo.error_unauthorized_hint')}
            <code>gh auth login</code>
          </div>
        )}
        {(kind === 'rate_limited' || kind === 'generic') && (
          <button
            class="repo-detail-retry"
            style={{ marginTop: 10 }}
            onClick={() => {
              updateTab(tabKey, { error: null, fetched: false });
              fetchTab(tabKey);
            }}
          >
            {t('repo.retry')}
          </button>
        )}
      </div>
    );
  };

  const renderEmpty = (tabKey: TabKey) => (
    <div class="repo-state-box">
      {t(`repo.empty_${tabKey}`)}
    </div>
  );

  const renderSpinner = () => (
    <div class="repo-state-box">
      {t('common.loading')}
    </div>
  );

  const renderIssueItem = (item: any) => {
    const issueKey = `issues:${item.number}`;
    const isExpanded = expandedKey === issueKey;
    return (
      <div key={item.number ?? item.id} class={`repo-card-wrap${isExpanded ? ' is-expanded' : ''}`}>
        <div class="repo-card repo-card-interactive" onClick={() => fetchDetail('issues', item.number)}>
          <div class="repo-card-row">
            <span class={`repo-status-pill ${statusPillClass(item.state)}`}>
              {item.state?.toUpperCase()}
            </span>
            <span class="repo-num-chip">#{item.number}</span>
            <span class="repo-card-title">{item.title}</span>
          </div>
          {item.labels?.length > 0 && (
            <div class="repo-labels-row">
              {item.labels.map((l: any) => (
                <span key={l.name ?? l} class="repo-label-chip">
                  {typeof l === 'string' ? l : l.name}
                </span>
              ))}
            </div>
          )}
          <div class="repo-card-meta">
            <span>{item.author ?? item.user?.login}</span>
            {item.createdAt && <span>· {formatTime(new Date(item.createdAt).getTime())}</span>}
          </div>
        </div>
        {renderDetailPanel('issues', item.number)}
      </div>
    );
  };

  const renderPrItem = (item: any) => {
    const prKey = `prs:${item.number}`;
    const isExpanded = expandedKey === prKey;
    return (
      <div key={item.number ?? item.id} class={`repo-card-wrap${isExpanded ? ' is-expanded' : ''}`}>
        <div class="repo-card repo-card-interactive" onClick={() => fetchDetail('prs', item.number)}>
          <div class="repo-card-row">
            <span class={`repo-status-pill ${statusPillClass(item.state)}`}>
              {item.state?.toUpperCase()}
            </span>
            <span class="repo-num-chip">#{item.number}</span>
            <span class="repo-card-title">{item.title}</span>
          </div>
          {item.head && (
            <div class="repo-branch-flow">
              <code class="repo-mono-chip">{item.head}</code>
              <span class="repo-branch-arrow">→</span>
              <code class="repo-mono-chip">{item.base}</code>
            </div>
          )}
          <div class="repo-card-meta">
            <span>{item.author ?? item.user?.login}</span>
            {item.createdAt && <span>· {formatTime(new Date(item.createdAt).getTime())}</span>}
          </div>
        </div>
        {renderDetailPanel('prs', item.number)}
      </div>
    );
  };

  const renderBranchItem = (item: any) => {
    const name = typeof item === 'string' ? item : item.name;
    const isCurrent = typeof item !== 'string' && item.isCurrent;
    const isDefault = typeof item !== 'string' && item.isDefault;
    const localPresent = typeof item !== 'string' ? item.localPresent !== false && (item.localPresent || !item.remotePresent) : true;
    const remotePresent = typeof item !== 'string' && item.remotePresent;
    const checkoutable = typeof item !== 'string' && item.checkoutable === true;
    const disabledReason = typeof item !== 'string'
      ? item.checkoutBlockedReason || (!localPresent ? 'invalid_checkout_target' : null)
      : null;
    const isPending = checkoutPendingBranch === name;
    const canSwitch = !readOnly && checkoutable && !isCurrent && !checkoutPendingBranch;
    const disabledTitle = !canSwitch && !isCurrent
      ? disabledReason === 'invalid_checkout_target' && !localPresent
        ? t('repo.checkout_remote_only_disabled')
        : disabledReason
          ? checkoutErrorMessage(disabledReason)
          : undefined
      : undefined;

    return (
      <div key={name} class={`repo-card-wrap${isCurrent ? ' is-current' : ''}`}>
        <div class="repo-card">
          <div class="repo-card-row">
            <code class="repo-branch-name">{name}</code>
            {isCurrent && (
              <span class="repo-status-pill is-current">
                {t('repo.current_branch')}
              </span>
            )}
            {isDefault && (
              <span class="repo-chip-pill is-default">
                {t('repo.default_branch')}
              </span>
            )}
            {localPresent && (
              <span title={t('repo.branch_local_label')} class="repo-chip-pill is-local">{t('repo.branch_local_short')}</span>
            )}
            {remotePresent && (
              <span title={t('repo.branch_remote_label')} class="repo-chip-pill is-remote">{t('repo.branch_remote_short')}</span>
            )}
            <span style={{ flex: 1 }} />
            {isCurrent || readOnly ? null : (
              <button
                class="repo-switch-btn"
                disabled={!canSwitch}
                title={isPending ? t('repo.checkout_pending', { branch: name }) : disabledTitle ?? t('repo.checkout_switch_to', { branch: name })}
                aria-label={isPending ? t('repo.checkout_pending', { branch: name }) : t('repo.checkout_switch_to', { branch: name })}
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  handleCheckoutBranch(name);
                }}
              >
                {isPending ? t('repo.checkout_switching') : t('repo.checkout_switch')}
              </button>
            )}
          </div>
          {disabledTitle && (
            <div class="repo-branch-note">
              {disabledTitle}
            </div>
          )}
          {typeof item !== 'string' && (item.lastCommitDate || item.lastCommit) && (
            <div class="repo-card-meta">
              {item.lastCommitDate ? formatTime(item.lastCommitDate) : item.lastCommit}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderCommitItem = (item: any) => {
    const sha = item.sha ?? item.oid ?? item.hash ?? '';
    const fullMsg: string = item.message ?? item.title ?? '';
    const firstLine = fullMsg.split('\n')[0];
    const body = fullMsg.includes('\n') ? fullMsg.slice(fullMsg.indexOf('\n') + 1).replace(/^\n+/, '') : '';
    const commitKey = `commits:${sha}`;
    const isExpanded = expandedKey === commitKey;
    const filesDetail = detailData.get(commitKey);
    const filesState = detailState.get(commitKey);

    const requestCommitDetail = () => {
      if (filesDetail || detailStateRef.current.get(commitKey) === 'loading') return;
      setDetailState(prev => new Map(prev).set(commitKey, 'loading'));
      try {
        const rid = ws.repoCommitDetail(requestProjectDir, sha, sessionScope);
        pendingRef.current.add(rid);
        detailReqRef.current.set(rid, {
          key: commitKey,
          tab: 'commits',
          branch: getActiveBranch(),
          repoGeneration: getActiveRepoGeneration(),
        });
      } catch {
        setDetailState(prev => new Map(prev).set(commitKey, 'error'));
      }
    };

    const handleClick = () => {
      if (isExpanded && filesDetail) {
        setExpandedKey(null);
        return;
      }
      setExpandedKey(commitKey);
      if (!filesDetail && filesState !== 'loading') requestCommitDetail();
    };

    const handleShowFiles = (e: MouseEvent) => {
      e.stopPropagation();
      requestCommitDetail();
    };

    return (
      <div key={sha} class={`repo-card-wrap${isExpanded ? ' is-expanded' : ''}`}>
        <div class="repo-card repo-card-interactive" onClick={handleClick}>
          <div class="repo-card-row">
            <code class="repo-sha-chip">
              {sha.slice(0, 7)}
            </code>
            <span class="repo-card-title">
              {firstLine}
            </span>
          </div>
          <div class="repo-card-meta">
            <span>{item.author?.name ?? item.author ?? ''}</span>
            {item.date && <span>· {formatTime(new Date(item.date).getTime())}</span>}
          </div>
        </div>
        {isExpanded && (
          <div class="repo-detail-panel">
            {body && <pre class="repo-detail-body">{body}</pre>}
            {filesDetail ? (
              <>
                {renderDiffStats(filesDetail.stats.additions, filesDetail.stats.deletions, filesDetail.stats.filesChanged)}
                <div class="repo-detail-files">
                  {filesDetail.files.map((f: any) => (
                    <div key={f.filename} class="repo-detail-file">
                      <span class="repo-file-name">{f.filename}</span>
                      {f.additions !== undefined && (
                        <span class="repo-file-stats">
                          <span class="repo-stat-add">+{f.additions}</span>
                          <span class="repo-stat-del">-{f.deletions}</span>
                        </span>
                      )}
                    </div>
                  ))}
                  {filesDetail.hasMoreFiles && <div class="repo-detail-more">{t('repo.more_files')}</div>}
                </div>
              </>
            ) : filesState === 'loading' ? (
              <div class="repo-detail-loading">{t('repo.detail_loading')}</div>
            ) : filesState === 'error' ? (
              <div class="repo-detail-error">
                {t('repo.detail_error')}
                <button class="repo-detail-retry" onClick={handleShowFiles}>{t('repo.detail_retry')}</button>
              </div>
            ) : (
              <button
                class="repo-detail-retry"
                style={{ marginTop: body ? 4 : 0 }}
                onClick={handleShowFiles}
              >
                {t('repo.show_changed_files')}
              </button>
            )}
            {item.url && <a href={item.url} target="_blank" rel="noopener" class="repo-detail-link">{t('repo.view_on_platform')}</a>}
          </div>
        )}
      </div>
    );
  };

  const formatDuration = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  // ── Detail renderers ─────────────────────────────────────────────────

  const formatRelativeTs = (ts: number): string => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const isLikelyTestStep = (name: string | null | undefined): boolean => {
    if (!name) return false;
    return /\b(test|tests|spec|specs|e2e|integration|unit|jest|vitest|playwright|cypress|coverage)\b/i.test(name);
  };

  function extractFailedLocation(detail: any): { failedJobName?: string; failedStepName?: string } {
    const jobs = Array.isArray(detail?.jobs) ? detail.jobs : [];
    for (const job of jobs) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const failedStep = steps.find((step: any) => step?.status === 'failure' || step?.conclusion === 'failure');
      if (failedStep) return { failedJobName: job?.name, failedStepName: failedStep?.name };
      if (job?.status === 'failure' || job?.conclusion === 'failure') return { failedJobName: job?.name };
    }
    return {};
  }

  function emitCiEvent(run: { id: number; name: string; status: string; conclusion?: string; url: string; updatedAt?: number }, detail?: any): void {
    const cb = onCiEventRef.current;
    if (!cb) return;
    const key = `${run.id}:${run.status}:${run.updatedAt ?? 0}`;
    if (deliveredCiEventRef.current.has(key)) return;
    deliveredCiEventRef.current.add(key);
    const failure = run.status === 'failure' ? extractFailedLocation(detail) : {};
    cb({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      ...failure,
    });
  }

  function renderCommitDetail(detail: any) {
    return (
      <div class="repo-detail-panel">
        {detail.body && <pre class="repo-detail-body">{detail.body}</pre>}
        {renderDiffStats(detail.stats.additions, detail.stats.deletions, detail.stats.filesChanged)}
        <div class="repo-detail-files">
          {detail.files.map((f: any) => (
            <div key={f.filename} class="repo-detail-file">
              <span class="repo-file-name">{f.filename}</span>
              {f.additions !== undefined && (
                <span class="repo-file-stats">
                  <span class="repo-stat-add">+{f.additions}</span>
                  <span class="repo-stat-del">-{f.deletions}</span>
                </span>
              )}
            </div>
          ))}
          {detail.hasMoreFiles && <div class="repo-detail-more">{t('repo.more_files')}</div>}
        </div>
        {detail.url && <a href={detail.url} target="_blank" rel="noopener" class="repo-detail-link">{t('repo.view_on_platform')}</a>}
      </div>
    );
  }

  function renderPRDetail(detail: any) {
    const reviewColor = detail.reviewDecision === 'APPROVED' ? '#4ade80' : detail.reviewDecision === 'CHANGES_REQUESTED' ? '#ef4444' : '#f59e0b';
    const checksColor = detail.checksStatus === 'success' ? '#4ade80' : detail.checksStatus === 'failure' ? '#ef4444' : detail.checksStatus === 'pending' ? '#f59e0b' : '#6b7280';
    return (
      <div class="repo-detail-panel">
        {detail.body && (
          <div class="repo-detail-markdown">
            <ChatMarkdown text={detail.body} />
            {detail.bodyTruncated && <div class="repo-detail-truncated">{t('repo.body_truncated')}</div>}
          </div>
        )}
        <div class="repo-detail-badges">
          {detail.reviewDecision && <span class="repo-badge" style={{ borderColor: reviewColor, color: reviewColor }}>{detail.reviewDecision}</span>}
          {detail.checksStatus !== 'none' && <span class="repo-badge" style={{ borderColor: checksColor, color: checksColor }}>{t(`repo.checks_${detail.checksStatus}`)}</span>}
          {detail.mergeable === true && <span class="repo-badge" style={{ borderColor: '#4ade80', color: '#4ade80' }}>{t('repo.mergeable')}</span>}
          {detail.mergeable === false && <span class="repo-badge" style={{ borderColor: '#ef4444', color: '#ef4444' }}>{t('repo.conflicts')}</span>}
        </div>
        {renderDiffStats(
          detail.additions,
          detail.deletions,
          detail.changedFiles,
          <span>· {detail.comments} {t('repo.comments_count')}</span>,
        )}
        <a href={detail.url} target="_blank" rel="noopener" class="repo-detail-link">{t('repo.view_on_platform')}</a>
      </div>
    );
  }

  function renderIssueDetail(detail: any) {
    return (
      <div class="repo-detail-panel">
        {detail.body && (
          <div class="repo-detail-markdown">
            <ChatMarkdown text={detail.body} />
            {detail.bodyTruncated && <div class="repo-detail-truncated">{t('repo.body_truncated')}</div>}
          </div>
        )}
        {detail.comments && detail.comments.length > 0 ? (
          <div class="repo-detail-comments">
            <div class="repo-detail-comments-header">{t('repo.comments_header', { count: detail.comments.length })}</div>
            {detail.comments.map((c: any, i: number) => (
              <div key={i} class="repo-detail-comment">
                <div class="repo-comment-meta">
                  <strong>{c.author}</strong>
                  <span class="repo-comment-time">{formatRelativeTs(c.createdAt)}</span>
                </div>
                <div class="repo-detail-markdown">
                  <ChatMarkdown text={c.body} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div class="repo-detail-no-comments">{t('repo.no_comments')}</div>
        )}
      </div>
    );
  }

  const renderDetailPanel = (tab: 'commits' | 'prs' | 'issues', id: string | number) => {
    const key = `${tab}:${id}`;
    if (expandedKey !== key) return null;
    const state = detailState.get(key);
    if (state === 'loading') return <div class="repo-detail-loading">{t('repo.detail_loading')}</div>;
    if (state === 'error') return (
      <div class="repo-detail-error">
        {t('repo.detail_error')}
        <button class="repo-detail-retry" onClick={(e: MouseEvent) => { e.stopPropagation(); setDetailState(prev => { const n = new Map(prev); n.delete(key); return n; }); setDetailData(prev => { const n = new Map(prev); n.delete(key); return n; }); fetchDetail(tab, id); }}>
          {t('repo.detail_retry')}
        </button>
      </div>
    );
    const detail = detailData.get(key);
    if (!detail) return null;
    if (tab === 'commits') return renderCommitDetail(detail);
    if (tab === 'prs') return renderPRDetail(detail);
    return renderIssueDetail(detail);
  };

  const actionStatusColor = (status: string, conclusion: string | null | undefined) => {
    if (status === 'in_progress' || status === 'running') return '#f59e0b';
    if (status === 'queued' || status === 'waiting' || status === 'pending') return '#94a3b8';
    if (conclusion === 'success') return '#4ade80';
    if (conclusion === 'failure') return '#ef4444';
    if (conclusion === 'cancelled') return '#6b7280';
    return '#94a3b8';
  };

  const actionStatusLabel = (status: unknown, conclusion: unknown) => {
    if (status === 'in_progress' || status === 'running') return 'RUNNING';
    if (status === 'queued' || status === 'waiting' || status === 'pending') return 'QUEUED';
    if (typeof conclusion === 'string' && conclusion) return conclusion.toUpperCase();
    if (typeof status === 'string') return status.toUpperCase();
    return '';
  };

  const renderJobStatusIcon = (status: string, conclusion: string | null | undefined) => {
    const color = actionStatusColor(status, conclusion);
    const label = actionStatusLabel(status, conclusion);
    if (status === 'running' || status === 'in_progress') {
      return (
        <span
          aria-label={label}
          title={label}
          class="repo-job-spinner"
          style={{
            border: `2px solid ${color}33`,
            borderTopColor: color,
          }}
        />
      );
    }

    return (
      <span
        aria-label={label}
        title={label}
        class="repo-job-dot"
        style={{ background: color }}
      />
    );
  };

  const EVENT_COLORS: Record<string, string> = {
    push: '#3b82f6',
    pull_request: '#a78bfa',
    schedule: '#f59e0b',
    workflow_dispatch: '#14b8a6',
  };

  const renderActionItem = (item: any) => {
    const color = actionStatusColor(item.status, item.conclusion);
    const duration = item.duration != null
      ? item.duration * 1000
      : (item.updatedAt && item.createdAt ? item.updatedAt - item.createdAt : null);
    const branch = item.branch ?? item.headBranch;
    const commitMsg = item.commitMessage ?? item.headCommit?.message;
    const fullCommitMsg = item.headCommitMessage ?? commitMsg;
    const actor = typeof item.actor === 'string' ? item.actor : item.actor?.login;
    const eventColor = item.event ? (EVENT_COLORS[item.event] ?? '#64748b') : undefined;
    const actionKey = `actions:${item.id}`;
    const isExpanded = expandedKey === actionKey;
    const actionDetail = detailData.get(actionKey);
    const actionDetailState = detailState.get(actionKey);
    const isLatestAction = tabs.actions.items[0]?.id === item.id;
    const showCollapsedJobSummary = isLatestAction && (item.status === 'running' || item.status === 'failure');
    const visibleJobs = showCollapsedJobSummary && Array.isArray(actionDetail?.jobs) ? actionDetail.jobs : [];
    const isPulsing = item.status === 'running' || item.status === 'in_progress' || item.status === 'queued';
    return (
      <div key={item.id ?? item.runId} class={`repo-card-wrap${isExpanded ? ' is-expanded' : ''}`}>
        <div
          class="repo-card repo-card-interactive"
          onClick={() => {
            if (isExpanded) {
              setExpandedKey(null);
              return;
            }
            setExpandedKey(actionKey);
            if (!actionDetail && actionDetailState !== 'loading') {
              fetchActionDetail(item.id, { force: item.status === 'running' || item.status === 'queued' });
            }
          }}
        >
          <div class="repo-card-row">
            <span class={`repo-status-dot${isPulsing ? ' is-pulsing' : ''}`} style={{ background: color, color }} />
            <span class={`repo-status-pill ${statusPillClass(item.status, item.conclusion)}`}>
              {actionStatusLabel(item.status, item.conclusion)}
            </span>
            <span class="repo-card-title">
              {item.name ?? item.workflowName ?? ''}
            </span>
            {item.runNumber && (
              <span class="repo-num-chip">#{item.runNumber}</span>
            )}
            {item.event && (
              <span
                class="repo-event-chip"
                style={{
                  background: `${eventColor}20`,
                  color: eventColor,
                  borderColor: `${eventColor}44`,
                }}
              >
                {item.event}
              </span>
            )}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                class="repo-inline-link"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                {t('repo.actions_view')}
              </a>
            )}
          </div>
          <div class="repo-card-meta">
            {branch && <code class="repo-mono-chip">{branch}</code>}
            {item.commitSha && <code class="repo-sha-chip">{item.commitSha}</code>}
            {actor && <span>{actor}</span>}
            {duration != null && duration > 0 && <span>⏱ {formatDuration(duration)}</span>}
            {(item.status === 'running' || item.status === 'queued') && item.createdAt && (
              <span style={{ color: '#f59e0b' }}>⏱ {formatDuration(Date.now() - item.createdAt)}</span>
            )}
            {item.runAttempt && item.runAttempt > 1 && (
              <span style={{ color: '#f59e0b' }}>attempt #{item.runAttempt}</span>
            )}
            {item.createdAt && <span>{formatTime(item.createdAt)} ({formatRelativeTs(item.createdAt)})</span>}
          </div>
          {commitMsg && (
            <div class="repo-action-commit-msg">
              {commitMsg}
            </div>
          )}
          {!isExpanded && visibleJobs.length > 0 && (
            <div class="repo-job-pills">
              {visibleJobs.map((job: any) => {
                const jobColor = actionStatusColor(job.status, job.conclusion);
                return (
                  <span
                    key={job.id}
                    title={`${job.name} · ${actionStatusLabel(job.status, job.conclusion)}`}
                    class="repo-job-pill"
                    style={{ borderColor: `${jobColor}44` }}
                  >
                    {renderJobStatusIcon(job.status, job.conclusion)}
                    <span class="repo-job-pill-name">{job.name}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {isExpanded && (
          <div class="repo-detail-panel">
            {item.workflowPath && (
              <div class="repo-detail-workflow-path">
                {item.workflowPath}
              </div>
            )}
            {fullCommitMsg && (
              <pre class="repo-detail-body">{fullCommitMsg}</pre>
            )}
            <div class="repo-action-meta-grid">
              {item.conclusion && <span>Conclusion: <strong style={{ color }}>{item.conclusion}</strong></span>}
              {item.event && <span>Trigger: <strong>{item.event}</strong></span>}
              {duration != null && duration > 0 && <span>Duration: <strong>{formatDuration(duration)}</strong></span>}
              {item.runAttempt && <span>Attempt: <strong>#{item.runAttempt}</strong></span>}
              {item.createdAt && <span>Started: <strong>{formatTime(item.createdAt)}</strong></span>}
              {item.updatedAt && item.status !== 'queued' && <span>Updated: <strong>{formatTime(item.updatedAt)}</strong></span>}
            </div>
            {actionDetailState === 'loading' && (
              <div class="repo-detail-loading">{t('repo.detail_loading')}</div>
            )}
            {actionDetailState === 'error' && (
              <div class="repo-detail-error">
                {t('repo.detail_error')}
                <button
                  class="repo-detail-retry"
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    fetchActionDetail(item.id, { force: true });
                  }}
                >
                  {t('repo.detail_retry')}
                </button>
              </div>
            )}
            {actionDetail?.jobs?.length > 0 && (
              <div class="repo-action-jobs">
                {actionDetail.jobs.map((job: any) => {
                  const jobColor = actionStatusColor(job.status, job.conclusion);
                  const steps = Array.isArray(job.steps) ? job.steps.filter((step: any) => step?.name) : [];
                  const jobFocusKey = `${item.id}:${job.name}`;
                  const isJobFocused = focusedActionTargetKey === jobFocusKey;
                  return (
                    <div
                      key={job.id}
                      class={`repo-action-job${isJobFocused ? ` ${focusedActionTargetReplayClass}` : ''}`}
                      ref={(el) => {
                        if (el) actionJobRefs.current.set(jobFocusKey, el);
                        else actionJobRefs.current.delete(jobFocusKey);
                      }}
                      style={{
                        ['--repo-action-focus-color' as string]: jobColor,
                      }}
                    >
                      <div class="repo-action-job-head">
                        <span class="repo-status-dot" style={{ background: jobColor, color: jobColor }} />
                        <span class={`repo-status-pill ${statusPillClass(job.status, job.conclusion)}`}>{actionStatusLabel(job.status, job.conclusion)}</span>
                        <span class="repo-action-job-name">{job.name}</span>
                        {job.url && (
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="repo-inline-link"
                            onClick={(e: MouseEvent) => e.stopPropagation()}
                          >
                            {t('repo.actions_view')}
                          </a>
                        )}
                      </div>
                      {steps.length > 0 && (
                        <div class="repo-action-steps">
                          {steps.map((step: any) => {
                            const stepColor = actionStatusColor(step.status, step.conclusion);
                            const isTestStep = isLikelyTestStep(step.name);
                            const stepFocusKey = `${item.id}:${job.name}:${step.name}`;
                            const isStepFocused = focusedActionTargetKey === stepFocusKey;
                            return (
                              <div
                                key={`${job.id}:${step.number}`}
                                class={`repo-action-step${isTestStep ? ' repo-action-step-test' : ''}${isStepFocused ? ` ${focusedActionTargetReplayClass}` : ''}`}
                                ref={(el) => {
                                  if (el) actionStepRefs.current.set(stepFocusKey, el);
                                  else actionStepRefs.current.delete(stepFocusKey);
                                }}
                                style={{
                                  ['--repo-action-focus-color' as string]: stepColor,
                                }}
                              >
                                <span class="repo-job-dot" style={{ width: 6, height: 6, background: stepColor }} />
                                <span style={{ fontSize: 10, fontWeight: 600, color: stepColor, flexShrink: 0 }}>{actionStatusLabel(step.status, step.conclusion)}</span>
                                <span class="repo-action-step-name">
                                  {isTestStep ? `🧪 ${step.name}` : step.name}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener" class="repo-detail-link">{t('repo.view_on_platform')}</a>
            )}
          </div>
        )}
      </div>
    );
  };

  const RENDERERS: Record<TabKey, (item: any) => any> = {
    issues: renderIssueItem,
    prs: renderPrItem,
    branches: renderBranchItem,
    commits: renderCommitItem,
    actions: renderActionItem,
  };

  const renderTabContent = (key: TabKey) => {
    const tab = tabs[key];
    // Show spinner only on initial detect (no context yet)
    if (detectLoading && !context && !shouldPreserveTabContent(tab)) return renderSpinner();
    // Detect failed AND we have no previous data — show retry prompt
    if (detectError && !context && !shouldPreserveTabContent(tab)) return (
      <div class="repo-state-box is-error">
        <div class="repo-state-title">{detectError}</div>
        <button class="repo-detail-retry" onClick={() => doDetect()}>{t('repo.retry')}</button>
      </div>
    );
    // If detect is re-running but we have cached data, show tabs normally
    if (tab.loading && !tab.fetched) return renderSpinner();
    if (tab.error && !shouldPreserveTabContent(tab)) return renderError(tab.error, key);
    if (tab.fetched && tab.items.length === 0) return renderEmpty(key);
    if (!tab.fetched && !tab.loading) return renderSpinner(); // waiting for lazy load

    const renderer = RENDERERS[key];
    return (
      <PullToRefresh loading={tab.loading && !tab.refreshing} onRefresh={() => silentRefreshTab(key)}>
        <div class="repo-list">
          {tab.items.map(renderer)}
        </div>
        {tab.loading && !tab.refreshing && (
          <div style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            {t('common.loading')}
          </div>
        )}
        {!tab.loading && tab.hasMore && (
          <button
            class="repo-load-more-btn"
            disabled={Boolean(tab.branchStale)}
            onClick={handleLoadMore}
          >
            {t('repo.load_more')}
          </button>
        )}
      </PullToRefresh>
    );
  };

  // ── Main render ──────────────────────────────────────────────────────────

  const hasRunningActions = tabs.actions.items.some((r: any) => r.status === 'running' || r.status === 'in_progress' || r.status === 'queued');

  return (
    <div class="repo-page">
      {/* Header bar */}
      <div class="repo-header">
        {detectLoading && !context && (
          <span class="repo-header-loading">{t('common.loading')}</span>
        )}

        {detectError && !context && (
          <span class="repo-header-error">{detectError}</span>
        )}

        {context && (
          <div class="repo-header-identity">
            {context.provider && (
              <span class={`repo-provider-badge${context.provider === 'gitlab' ? ' is-gitlab' : ''}`}>
                {context.provider}
              </span>
            )}
            <span class="repo-title">
              {context.owner && context.repo ? `${context.owner}/${context.repo}` : projectDir}
            </span>
            {context.defaultBranch && (
              <code class="repo-branch-chip">
                {context.defaultBranch}
              </code>
            )}
            {context.cliInstalled === false && (
              <span class="repo-cli-missing">
                {t('repo.cli_not_installed')}
              </span>
            )}
          </div>
        )}

        <div class="repo-header-actions">
          {context?.lastRefresh && (
            <span class="repo-refresh-time">
              {formatTime(context.lastRefresh)}
            </span>
          )}

          <button
            type="button"
            class={`btn btn-sm repo-refresh-btn${tabs[activeTab].refreshing ? ' is-refreshing' : ''}`}
            title={t('repo.refresh')}
            aria-label={t('repo.refresh')}
            disabled={!context && detectLoading}
            onClick={handleManualRefresh}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>

          {!scopeToSessionRoot && (
            <button
              type="button"
              class="btn btn-sm repo-callback-trigger"
              onClick={() => setCallbackModalOpen(true)}
            >
              <span
                class="repo-callback-dot"
                style={{
                  background: callbackLastError ? '#ef4444' : callbackRuntimeEnabled ? '#22c55e' : '#64748b',
                }}
              />
              <span>{t('repo.callback_button')}</span>
              {(() => {
                const activeCount = callbacks.filter((cb) => cb.status === 'pending' || cb.status === 'in_progress').length;
                const failedCount = callbacks.filter((cb) => cb.status === 'failed').length;
                const badgeCount = failedCount > 0 ? failedCount : activeCount;
                if (badgeCount === 0) return null;
                return (
                  <span class={`repo-callback-badge${failedCount > 0 ? ' is-failed' : ''}`}>
                    {badgeCount}
                  </span>
                );
              })()}
            </button>
          )}
        </div>
      </div>

      {checkoutFeedback && (
        <div
          role={checkoutFeedback.kind === 'error' ? 'alert' : 'status'}
          class={`repo-feedback-banner${checkoutFeedback.kind === 'error' ? ' is-error' : ''}`}
        >
          {checkoutFeedback.kind === 'error'
            ? checkoutErrorMessage(checkoutFeedback.error)
            : t('repo.checkout_success', { branch: checkoutFeedback.branch })}
        </div>
      )}

      {/* Tab bar */}
      <div class="repo-tabs" role="tablist">
        {(['issues', 'prs', 'branches', 'commits', 'actions'] as TabKey[]).map(key => {
          const tabError = tabs[key].error;
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => handleTabClick(key)}
              title={tabError || undefined}
              class={`repo-tab${isActive ? ' is-active' : ''}`}
            >
              <span>{TAB_LABELS[key]}</span>
              {key === 'actions' && hasRunningActions && !tabError && (
                <span class="repo-tab-live-dot" aria-hidden="true" />
              )}
              {tabError && (
                <span
                  class="repo-tab-error-badge"
                  aria-label={`${TAB_LABELS[key]} error`}
                >
                  !
                </span>
              )}
              {(tabs[key].loading || tabs[key].refreshing) && (
                <span class="repo-tab-spinner">↻</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div class="repo-content">
        {renderTabContent(activeTab)}
      </div>

      {!scopeToSessionRoot && (
        <RepoCallbackModal
          open={callbackModalOpen}
          onClose={() => setCallbackModalOpen(false)}
          ws={ws}
          serverId={serverId}
          projectDir={projectDir}
          currentSessionName={sessionId}
          readOnly={readOnly}
          callbackTargets={callbackTargets}
          callbacks={callbacks}
          runtimeEnabled={callbackRuntimeEnabled}
          checking={callbackChecking}
          lastCheckedAt={callbackLastCheckedAt}
          lastError={callbackLastError}
          onConfigSaved={(cfg) => setCallbackRuntimeEnabled(cfg.enabled)}
        />
      )}
    </div>
  );
}
