import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren } from 'preact';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { ChatMarkdown } from '../components/ChatMarkdown.js';
import { REPO_MSG } from '@shared/repo-types.js';

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
      style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {(pullDistance > 0 || loading) && (
        <div style={{
          textAlign: 'center', padding: '8px 0', fontSize: 11, color: '#64748b',
          transition: pulling.current ? 'none' : 'height 0.2s',
          height: loading ? 28 : pullDistance > 0 ? Math.min(pullDistance, 40) : 0,
          overflow: 'hidden', lineHeight: '28px',
        }}>
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
  projectDir: string;
  onBack?: () => void;
  focusLatestAction?: { token: number; failedJobName?: string; failedStepName?: string } | null;
  /** Called when a CI/CD run completes (success/failure). */
  onCiEvent?: (run: { name: string; status: string; conclusion?: string; url: string; failedJobName?: string; failedStepName?: string }) => void;
}

type TabKey = 'issues' | 'prs' | 'branches' | 'commits' | 'actions';

interface RepoContext {
  provider?: string; // 'github' | 'gitlab' | ...
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  branches?: string[];
  cliInstalled?: boolean;
  lastRefresh?: number;
}

interface TabState<T = any> {
  items: T[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  /** Silent background refresh — no loading indicator, just a small spinner */
  refreshing: boolean;
  error: string | null;
  fetched: boolean; // true once first fetch completed (for lazy load)
}

/** Map daemon RepoContext shape ({ info: { platform, owner, repo }, status }) to page context. */
function mapDetectToContext(raw: any): RepoContext {
  if (!raw) return {};
  // Already in page shape (e.g. from old-style message or test mock)
  if (raw.provider !== undefined) return raw;
  // Daemon shape: { status, info: { platform, owner, repo, defaultBranch }, cliVersion, cliAuth }
  const info = raw.info;
  return {
    provider: info?.platform,
    owner: info?.owner,
    repo: info?.repo,
    defaultBranch: info?.defaultBranch ?? raw.defaultBranch,
    cliInstalled: raw.status !== 'cli_missing',
  };
}

function emptyTab<T = any>(): TabState<T> {
  return { items: [], page: 1, hasMore: false, loading: false, refreshing: false, error: null, fetched: false };
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

// ── Component ────────────────────────────────────────────────────────────────

export function RepoPage({ ws, projectDir, focusLatestAction, onCiEvent }: Props) {
  const { t } = useTranslation();

  const [context, setContext] = useState<RepoContext | null>(null);
  const [detectLoading, setDetectLoading] = useState(true);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const saved = localStorage.getItem('repo-active-tab');
    return saved && ['issues', 'prs', 'branches', 'commits', 'actions'].includes(saved) ? saved as TabKey : 'issues';
  });

  const [tabs, setTabs] = useState<Record<TabKey, TabState>>({
    issues: emptyTab(),
    prs: emptyTab(),
    branches: emptyTab(),
    commits: emptyTab(),
    actions: emptyTab(),
  });

  // ── Expand/collapse detail state ──────────────────────────────────────
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<Map<string, any>>(new Map());
  const [detailState, setDetailState] = useState<Map<string, 'loading' | 'loaded' | 'error'>>(new Map());

  // Track pending requestIds to discard stale responses
  const pendingRef = useRef<Set<string>>(new Set());
  const detailReqRef = useRef<Map<string, string>>(new Map());
  const tabReqRef = useRef<Map<string, { key: TabKey; page: number; force: boolean }>>(new Map());
  const detailDataRef = useRef<Map<string, any>>(new Map());
  // Track detect requestId separately
  const detectReqRef = useRef<string | null>(null);
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
  const actionStepRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [focusedActionTargetKey, setFocusedActionTargetKey] = useState<string | null>(null);
  const contextRef = useRef<RepoContext | null>(null);

  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const updateTab = useCallback((key: TabKey, patch: Partial<TabState>) => {
    setTabs(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

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
    if (detailData.has(key)) return;
    // Fetch
    setDetailState(prev => new Map(prev).set(key, 'loading'));
    try {
      let rid: string;
      if (tab === 'commits') {
        rid = ws.repoCommitDetail(projectDir, id as string);
      } else if (tab === 'prs') {
        rid = ws.repoPRDetail(projectDir, id as number);
      } else {
        rid = ws.repoIssueDetail(projectDir, id as number);
      }
      pendingRef.current.add(rid);
      detailReqRef.current.set(rid, key);
    } catch {
      setDetailState(prev => new Map(prev).set(key, 'error'));
    }
  }, [ws, projectDir, expandedKey, detailData]);

  const fetchActionDetail = useCallback((runId: number, opts?: { force?: boolean }) => {
    const key = `actions:${runId}`;
    if (detailState.get(key) === 'loading') return;
    setDetailState(prev => new Map(prev).set(key, 'loading'));
    try {
      const rid = ws.repoActionDetail(projectDir, runId, opts);
      pendingRef.current.add(rid);
      detailReqRef.current.set(rid, key);
    } catch {
      setDetailState(prev => new Map(prev).set(key, 'error'));
    }
  }, [ws, projectDir, detailState]);

  // ── Detect on mount ──────────────────────────────────────────────────────

  const detectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback((opts?: { preserveUi?: boolean }) => {
    const preserveUi = opts?.preserveUi === true;
    const currentContext = contextRef.current;
    if (!preserveUi || !currentContext) {
      setDetectLoading(true);
    }
    if (!preserveUi) {
      setDetectError(null);
      detectRetryCountRef.current = 0;
    }

    let rid: string;
    try {
      rid = ws.repoDetect(projectDir);
    } catch (err) {
      if (!currentContext) {
        setDetectError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        setDetectLoading(false);
      }
      return;
    }

    detectReqRef.current = rid;
    pendingRef.current.add(rid);

    // Timeout: if no response within 10s, show error with debug info
    if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
    detectTimeoutRef.current = setTimeout(() => {
      if (detectReqRef.current === rid && pendingRef.current.has(rid)) {
        pendingRef.current.delete(rid);
        const nextRetry = detectRetryCountRef.current + 1;
        detectRetryCountRef.current = nextRetry;
        if (currentContext && nextRetry <= MAX_SILENT_RETRIES) {
          if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
          detectRetryTimerRef.current = setTimeout(() => doDetect({ preserveUi: true }), RETRY_DELAY_MS);
          return;
        }
        if (!currentContext) {
          setDetectError(`Detect timeout — no response after 10s (requestId: ${rid.slice(0, 8)})`);
          setDetectLoading(false);
        }
      }
    }, 10_000);
  }, [ws, projectDir]);

  useEffect(() => {
    contextRef.current = null;
    setContext(null);
    setDetectLoading(true);
    setDetectError(null);
    for (const requestId of detailReqRef.current.keys()) {
      pendingRef.current.delete(requestId);
    }
    setExpandedKey(null);
    setDetailData(new Map());
    setDetailState(new Map());
    setFocusedActionTargetKey(null);
    detailDataRef.current = new Map();
    detailReqRef.current.clear();
    tabReqRef.current.clear();
    latestActionDetailRef.current = null;
    detectRetryCountRef.current = 0;
    if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
    detectRetryTimerRef.current = null;
    for (const timer of tabRetryTimersRef.current.values()) clearTimeout(timer);
    tabRetryTimersRef.current.clear();
    tabRetryCountRef.current.clear();
    pendingCiFailureRef.current.clear();
    deliveredCiEventRef.current.clear();
    actionJobRefs.current.clear();
    actionStepRefs.current.clear();
    for (const timer of detailRetryTimersRef.current.values()) clearTimeout(timer);
    detailRetryTimersRef.current.clear();
    detailRetryCountRef.current.clear();
  }, [projectDir]);

  useEffect(() => {
    doDetect();
    return () => {
      if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
      if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
      for (const timer of tabRetryTimersRef.current.values()) clearTimeout(timer);
      tabRetryTimersRef.current.clear();
      for (const timer of detailRetryTimersRef.current.values()) clearTimeout(timer);
      detailRetryTimersRef.current.clear();
    };
  }, [doDetect]);

  // ── Tab data fetching ────────────────────────────────────────────────────

  const fetchTab = useCallback((key: TabKey, page = 1, force = false, opts?: { preserveUi?: boolean }) => {
    const preserveUi = opts?.preserveUi === true;
    if (!preserveUi) {
      updateTab(key, { loading: true, error: null });
      if (page === 1) tabRetryCountRef.current.delete(key);
    } else {
      updateTab(key, { loading: true });
    }
    let rid: string;
    switch (key) {
      case 'issues':
        rid = ws.repoListIssues(projectDir, { page, ...(force ? { force: true } : {}) });
        break;
      case 'prs':
        rid = ws.repoListPRs(projectDir, { page, ...(force ? { force: true } : {}) });
        break;
      case 'branches':
        rid = ws.repoListBranches(projectDir);
        break;
      case 'commits':
        rid = ws.repoListCommits(projectDir, { page });
        break;
      case 'actions':
        rid = ws.repoListActions(projectDir, { page, ...(force ? { force: true } : {}) });
        break;
    }
    pendingRef.current.add(rid);
    tabReqRef.current.set(rid, { key, page, force });
  }, [ws, projectDir, updateTab]);

  // Lazy-load: fetch tab data on first activation
  useEffect(() => {
    if (!context) return; // wait until detect completes
    const tab = tabs[activeTab];
    if (!tab.fetched && !tab.loading) {
      fetchTab(activeTab);
    }
  }, [activeTab, context, tabs, fetchTab]);

  // Auto-fetch CI/CD on detect complete (so auto-refresh works even if tab not visited)
  useEffect(() => {
    if (!context || tabs.actions.fetched || tabs.actions.loading) return;
    fetchTab('actions');
  }, [context, tabs.actions.fetched, tabs.actions.loading, fetchTab]);

  useEffect(() => {
    if (!focusLatestAction?.token || lastFocusTokenRef.current === focusLatestAction.token) return;
    lastFocusTokenRef.current = focusLatestAction.token;
    setActiveTab('actions');
    localStorage.setItem('repo-active-tab', 'actions');
  }, [focusLatestAction]);

  // ── Message handler ──────────────────────────────────────────────────────

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      // WS reconnected — clear stale pending requests, re-detect
      if (msg.type === 'daemon.reconnected' || (msg.type === 'session.event' && (msg as any).event === 'connected')) {
        pendingRef.current.clear();
        detailReqRef.current.clear();
        tabReqRef.current.clear();
        detectReqRef.current = null;
        latestActionDetailRef.current = null;
        pendingCiFailureRef.current.clear();
        deliveredCiEventRef.current.clear();
        doDetect({ preserveUi: true });
        return;
      }

      // Detect response
      if (msg.type === REPO_MSG.DETECT_RESPONSE) {
        if (msg.requestId !== detectReqRef.current) return;
        pendingRef.current.delete(msg.requestId);
        if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
        if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
        detectRetryTimerRef.current = null;
        detectRetryCountRef.current = 0;
        setContext(mapDetectToContext((msg as any).context ?? msg));
        setDetectLoading(false);
        setDetectError(null);
        return;
      }

      // Passive detect push — only accept if projectDir matches
      if (msg.type === REPO_MSG.DETECTED) {
        if (msg.projectDir !== projectDir) return;
        setContext(prev => ({ ...prev, ...mapDetectToContext(msg.context) }));
        return;
      }

      // Error response
      if (msg.type === REPO_MSG.ERROR) {
        if (!pendingRef.current.has(msg.requestId)) return;
        pendingRef.current.delete(msg.requestId);
        const detailKey = detailReqRef.current.get(msg.requestId);
        if (detailKey) {
          detailReqRef.current.delete(msg.requestId);
          const retryKey = detailKey;
          const existingDetail = detailDataRef.current.get(detailKey);
          const nextRetry = (detailRetryCountRef.current.get(retryKey) ?? 0) + 1;
          const latestAction = tabs.actions.items[0] as any;
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
        if (msg.requestId === detectReqRef.current) {
          if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
          const nextRetry = detectRetryCountRef.current + 1;
          detectRetryCountRef.current = nextRetry;
          if (context && nextRetry <= MAX_SILENT_RETRIES) {
            if (detectRetryTimerRef.current) clearTimeout(detectRetryTimerRef.current);
            detectRetryTimerRef.current = setTimeout(() => doDetect({ preserveUi: true }), RETRY_DELAY_MS);
          } else if (!context) {
            setDetectError(msg.error);
            setDetectLoading(false);
          }
        } else {
          const meta = tabReqRef.current.get(msg.requestId);
          if (meta) {
            tabReqRef.current.delete(msg.requestId);
            const retryKey = meta.key;
            const nextRetry = (tabRetryCountRef.current.get(retryKey) ?? 0) + 1;
            const existingTab = tabs[meta.key];
            const hasExistingData = existingTab.fetched;
            if (hasExistingData && nextRetry <= MAX_SILENT_RETRIES) {
              tabRetryCountRef.current.set(retryKey, nextRetry);
              const existingTimer = tabRetryTimersRef.current.get(retryKey);
              if (existingTimer) clearTimeout(existingTimer);
              tabRetryTimersRef.current.set(retryKey, setTimeout(() => {
                tabRetryTimersRef.current.delete(retryKey);
                fetchTab(meta.key, meta.page, meta.force, { preserveUi: hasExistingData });
              }, RETRY_DELAY_MS));
              updateTab(meta.key, { loading: false, refreshing: false, error: msg.error });
            } else {
              tabRetryCountRef.current.delete(retryKey);
              const existingTimer = tabRetryTimersRef.current.get(retryKey);
              if (existingTimer) clearTimeout(existingTimer);
              tabRetryTimersRef.current.delete(retryKey);
              updateTab(meta.key, {
                loading: false,
                refreshing: false,
                error: hasExistingData ? null : msg.error,
                fetched: existingTab.fetched || !hasExistingData,
              });
            }
          }
        }
        return;
      }

      // Detail responses
      if (msg.type === REPO_MSG.ACTION_DETAIL_RESPONSE) {
        const m = msg as any;
        if (m.projectDir !== projectDir) return;
        if (m.requestId) {
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
        if (m.projectDir !== projectDir) return;
        if (m.requestId) {
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
        }
        detailDataRef.current = new Map(detailDataRef.current).set(`commits:${m.detail.sha}`, m.detail);
        setDetailData(prev => new Map(prev).set(`commits:${m.detail.sha}`, m.detail));
        setDetailState(prev => new Map(prev).set(`commits:${m.detail.sha}`, 'loaded'));
        return;
      }
      if (msg.type === REPO_MSG.PR_DETAIL_RESPONSE) {
        const m = msg as any;
        if (m.projectDir !== projectDir) return;
        if (m.requestId) {
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
        if (m.projectDir !== projectDir) return;
        if (m.requestId) {
          pendingRef.current.delete(m.requestId);
          detailReqRef.current.delete(m.requestId);
        }
        detailDataRef.current = new Map(detailDataRef.current).set(`issues:${m.detail.number}`, m.detail);
        setDetailData(prev => new Map(prev).set(`issues:${m.detail.number}`, m.detail));
        setDetailState(prev => new Map(prev).set(`issues:${m.detail.number}`, 'loaded'));
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
        pendingRef.current.delete(m.requestId);
        tabReqRef.current.delete(m.requestId);
        tabRetryCountRef.current.delete(tabKey);
        const retryTimer = tabRetryTimersRef.current.get(tabKey);
        if (retryTimer) clearTimeout(retryTimer);
        tabRetryTimersRef.current.delete(tabKey);
        // Stale response check — projectDir must match
        if (m.projectDir !== projectDir) return;
        setTabs(prev => {
          const existing = prev[tabKey];
          const isLoadMore = m.page > 1;
          // Detect newly completed CI/CD runs (was running/queued, now success/failure)
          if (tabKey === 'actions' && !isLoadMore && existing.fetched && onCiEvent) {
            const oldStatuses = new Map(existing.items.map((r: any) => [r.id, r.status]));
            for (const run of m.items) {
              const prev = oldStatuses.get(run.id);
              if (prev && (prev === 'running' || prev === 'queued') && (run.status === 'success' || run.status === 'failure')) {
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
          return {
            ...prev,
            [tabKey]: {
              items: isLoadMore ? [...existing.items, ...m.items] : m.items,
              page: m.page,
              hasMore: m.hasMore,
              loading: false,
              refreshing: false,
              error: null,
              fetched: true,
            },
          };
        });
      }
    });
  }, [ws, projectDir, doDetect, onCiEvent, tabs.actions.items, fetchActionDetail]);

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
    window.setTimeout(() => {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    const clearId = window.setTimeout(() => setFocusedActionTargetKey((current) => current === targetKey ? null : current), 4000);
    return () => window.clearTimeout(clearId);
  }, [focusLatestAction, tabs.actions.fetched, tabs.actions.items, detailData]);

  // ── Actions ──────────────────────────────────────────────────────────────

  /** Silently refresh a tab — keep existing items visible while loading. */
  const silentRefreshTab = useCallback((key: TabKey) => {
    updateTab(key, { refreshing: true });
    fetchTab(key, 1, true);
  }, [fetchTab, updateTab]);

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
    if (tab.loading || !tab.hasMore) return;
    fetchTab(activeTab, tab.page + 1);
  }, [activeTab, tabs, fetchTab]);

  const handleTabClick = useCallback((key: TabKey) => {
    setActiveTab(key);
    localStorage.setItem('repo-active-tab', key);
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

  const shouldPreserveTabContent = (tab: TabState) => tab.items.length > 0;

  const renderError = (error: string, tabKey: TabKey) => {
    const kind = classifyError(error);
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#f87171' }}>
        <div style={{ marginBottom: 8, fontSize: 14 }}>{error}</div>
        {kind === 'cli_missing' && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {t('repo.error_cli_missing_hint')}{' '}
            <a href="https://cli.github.com" target="_blank" rel="noopener" style={{ color: '#60a5fa' }}>
              cli.github.com
            </a>
          </div>
        )}
        {kind === 'unauthorized' && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            {t('repo.error_unauthorized_hint')}
            <code style={{ background: '#1e293b', padding: '2px 6px', borderRadius: 4, marginLeft: 4 }}>
              gh auth login
            </code>
          </div>
        )}
        {kind === 'rate_limited' && (
          <button
            class="btn btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => {
              updateTab(tabKey, { error: null, fetched: false });
              fetchTab(tabKey);
            }}
          >
            {t('repo.retry')}
          </button>
        )}
        {kind === 'generic' && (
          <button
            class="btn btn-sm"
            style={{ marginTop: 8 }}
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
    <div style={{ padding: 32, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
      {t(`repo.empty_${tabKey}`)}
    </div>
  );

  const renderSpinner = () => (
    <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
      {t('common.loading')}
    </div>
  );

  const renderIssueItem = (item: any) => (
    <div key={item.number ?? item.id}>
      <div style={{ ...listItemStyle, cursor: 'pointer' }} onClick={() => fetchDetail('issues', item.number)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: item.state === 'open' ? '#4ade80' : '#f87171', fontSize: 11, fontWeight: 600 }}>
            {item.state?.toUpperCase()}
          </span>
          <span style={{ fontWeight: 500, color: '#e2e8f0', fontSize: 13 }}>#{item.number}</span>
          <span style={{ color: '#cbd5e1', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title}
          </span>
        </div>
        {item.labels?.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {item.labels.map((l: any) => (
              <span key={l.name ?? l} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 9999, background: '#334155', color: '#94a3b8' }}>
                {typeof l === 'string' ? l : l.name}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          {item.author ?? item.user?.login} {item.createdAt ? `· ${formatTime(new Date(item.createdAt).getTime())}` : ''}
        </div>
      </div>
      {renderDetailPanel('issues', item.number)}
    </div>
  );

  const renderPrItem = (item: any) => (
    <div key={item.number ?? item.id}>
      <div style={{ ...listItemStyle, cursor: 'pointer' }} onClick={() => fetchDetail('prs', item.number)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            color: item.state === 'open' ? '#4ade80' : item.state === 'merged' ? '#a78bfa' : '#f87171',
            fontSize: 11, fontWeight: 600,
          }}>
            {item.state?.toUpperCase()}
          </span>
          <span style={{ fontWeight: 500, color: '#e2e8f0', fontSize: 13 }}>#{item.number}</span>
          <span style={{ color: '#cbd5e1', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title}
          </span>
        </div>
        {item.head && (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            <code style={{ background: '#1e293b', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>{item.head}</code>
            {' → '}
            <code style={{ background: '#1e293b', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>{item.base}</code>
          </div>
        )}
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          {item.author ?? item.user?.login} {item.createdAt ? `· ${formatTime(new Date(item.createdAt).getTime())}` : ''}
        </div>
      </div>
      {renderDetailPanel('prs', item.number)}
    </div>
  );

  const renderBranchItem = (item: any) => (
    <div key={item.name ?? item} style={listItemStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code style={{ color: '#e2e8f0', fontSize: 13 }}>{typeof item === 'string' ? item : item.name}</code>
        {(typeof item !== 'string' && item.current) && (
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 9999, background: '#166534', color: '#4ade80' }}>
            {t('repo.current_branch')}
          </span>
        )}
      </div>
      {typeof item !== 'string' && item.lastCommit && (
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          {item.lastCommit}
        </div>
      )}
    </div>
  );

  const renderCommitItem = (item: any) => {
    const sha = item.sha ?? item.oid ?? item.hash ?? '';
    const fullMsg: string = item.message ?? item.title ?? '';
    const firstLine = fullMsg.split('\n')[0];
    const body = fullMsg.includes('\n') ? fullMsg.slice(fullMsg.indexOf('\n') + 1).replace(/^\n+/, '') : '';
    const commitKey = `commits:${sha}`;
    const isExpanded = expandedKey === commitKey;
    const filesDetail = detailData.get(commitKey);
    const filesState = detailState.get(commitKey);

    const handleClick = () => {
      // Toggle expand/collapse
      setExpandedKey(isExpanded ? null : commitKey);
    };

    const handleShowFiles = (e: MouseEvent) => {
      e.stopPropagation();
      if (filesDetail) return; // already loaded
      // Fetch detail for stats + files
      setDetailState(prev => new Map(prev).set(commitKey, 'loading'));
      try {
        const rid = ws.repoCommitDetail(projectDir, sha);
        pendingRef.current.add(rid);
      } catch {
        setDetailState(prev => new Map(prev).set(commitKey, 'error'));
      }
    };

    return (
      <div key={sha}>
        <div style={{ ...listItemStyle, cursor: 'pointer' }} onClick={handleClick}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ color: '#60a5fa', fontSize: 11, flexShrink: 0 }}>
              {sha.slice(0, 7)}
            </code>
            <span style={{ color: '#cbd5e1', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {firstLine}
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            {item.author?.name ?? item.author ?? ''} {item.date ? `· ${formatTime(new Date(item.date).getTime())}` : ''}
          </div>
        </div>
        {isExpanded && (
          <div class="repo-detail-panel">
            {body && <pre class="repo-detail-body">{body}</pre>}
            {/* Show files button / loaded files */}
            {filesDetail ? (
              <>
                <div class="repo-detail-stats">
                  <span style={{ color: '#4ade80' }}>+{filesDetail.stats.additions}</span>
                  {' '}
                  <span style={{ color: '#ef4444' }}>-{filesDetail.stats.deletions}</span>
                  {' '}
                  <span style={{ color: '#94a3b8' }}>{filesDetail.stats.filesChanged} {t('repo.files')}</span>
                </div>
                <div class="repo-detail-files">
                  {filesDetail.files.map((f: any) => (
                    <div key={f.filename} class="repo-detail-file">
                      <span class="repo-file-name">{f.filename}</span>
                      {f.additions !== undefined && (
                        <span class="repo-file-stats">
                          <span style={{ color: '#4ade80' }}>+{f.additions}</span>
                          <span style={{ color: '#ef4444' }}>-{f.deletions}</span>
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
    if (!onCiEvent) return;
    const key = `${run.id}:${run.status}:${run.updatedAt ?? 0}`;
    if (deliveredCiEventRef.current.has(key)) return;
    deliveredCiEventRef.current.add(key);
    const failure = run.status === 'failure' ? extractFailedLocation(detail) : {};
    onCiEvent({
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
        <div class="repo-detail-stats">
          <span style={{ color: '#4ade80' }}>+{detail.stats.additions}</span>
          {' '}
          <span style={{ color: '#ef4444' }}>-{detail.stats.deletions}</span>
          {' '}
          <span style={{ color: '#94a3b8' }}>{detail.stats.filesChanged} {t('repo.files')}</span>
        </div>
        <div class="repo-detail-files">
          {detail.files.map((f: any) => (
            <div key={f.filename} class="repo-detail-file">
              <span class="repo-file-name">{f.filename}</span>
              {f.additions !== undefined && (
                <span class="repo-file-stats">
                  <span style={{ color: '#4ade80' }}>+{f.additions}</span>
                  <span style={{ color: '#ef4444' }}>-{f.deletions}</span>
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
        <div class="repo-detail-stats">
          <span style={{ color: '#4ade80' }}>+{detail.additions}</span>{' '}
          <span style={{ color: '#ef4444' }}>-{detail.deletions}</span>{' '}
          <span style={{ color: '#94a3b8' }}>{detail.changedFiles} {t('repo.files')}</span>
          {' · '}{detail.comments} {t('repo.comments_count')}
        </div>
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

  const actionStatusLabel = (status: string, conclusion: string | null | undefined) => {
    if (status === 'in_progress' || status === 'running') return 'RUNNING';
    if (status === 'queued' || status === 'waiting' || status === 'pending') return 'QUEUED';
    if (conclusion) return conclusion.toUpperCase();
    return status?.toUpperCase() ?? '';
  };

  const renderJobStatusIcon = (status: string, conclusion: string | null | undefined) => {
    const color = actionStatusColor(status, conclusion);
    const label = actionStatusLabel(status, conclusion);
    if (status === 'running' || status === 'in_progress') {
      return (
        <span
          aria-label={label}
          title={label}
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: `2px solid ${color}33`,
            borderTopColor: color,
            display: 'inline-block',
            flexShrink: 0,
            animation: 'repo-spin 0.8s linear infinite',
          }}
        />
      );
    }

    return (
      <span
        aria-label={label}
        title={label}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
          flexShrink: 0,
        }}
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
    return (
      <div key={item.id ?? item.runId}>
        <div
          style={{ ...listItemStyle, cursor: 'pointer' }}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
              display: 'inline-block',
            }} />
            <span style={{ fontSize: 11, fontWeight: 600, color, flexShrink: 0 }}>
              {actionStatusLabel(item.status, item.conclusion)}
            </span>
            <span style={{ color: '#cbd5e1', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name ?? item.workflowName ?? ''}
            </span>
            {item.runNumber && (
              <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>#{item.runNumber}</span>
            )}
            {item.event && (
              <span style={{
                fontSize: 9, padding: '1px 6px', borderRadius: 9999,
                background: `${eventColor}20`, color: eventColor, flexShrink: 0, fontWeight: 500,
              }}>
                {item.event}
              </span>
            )}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, color: '#60a5fa', flexShrink: 0, textDecoration: 'none' }}
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                {t('repo.actions_view')}
              </a>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {branch && (
              <code style={{ background: '#1e293b', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>
                {branch}
              </code>
            )}
            {item.commitSha && (
              <code style={{ background: '#1e293b', padding: '1px 4px', borderRadius: 3, fontSize: 10, color: '#94a3b8' }}>
                {item.commitSha}
              </code>
            )}
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
          {/* Commit message summary — max 2 lines */}
          {commitMsg && (
            <div style={{ fontSize: 11, color: '#475569', marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {commitMsg}
            </div>
          )}
          {!isExpanded && visibleJobs.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {visibleJobs.map((job: any) => {
                const jobColor = actionStatusColor(job.status, job.conclusion);
                return (
                  <span
                    key={job.id}
                    title={`${job.name} · ${actionStatusLabel(job.status, job.conclusion)}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      maxWidth: 220,
                      padding: '2px 8px',
                      borderRadius: 9999,
                      border: `1px solid ${jobColor}40`,
                      background: 'rgba(15,23,42,0.45)',
                      color: '#cbd5e1',
                      fontSize: 10,
                    }}
                  >
                    {renderJobStatusIcon(job.status, job.conclusion)}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {isExpanded && (
          <div class="repo-detail-panel">
            {item.workflowPath && (
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
                {item.workflowPath}
              </div>
            )}
            {fullCommitMsg && (
              <pre class="repo-detail-body">{fullCommitMsg}</pre>
            )}
            <div style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {actionDetail.jobs.map((job: any) => {
                  const jobColor = actionStatusColor(job.status, job.conclusion);
                  const steps = Array.isArray(job.steps) ? job.steps.filter((step: any) => step?.name) : [];
                  const jobFocusKey = `${item.id}:${job.name}`;
                  const isJobFocused = focusedActionTargetKey === jobFocusKey;
                  return (
                    <div
                      key={job.id}
                      ref={(el) => {
                        if (el) actionJobRefs.current.set(jobFocusKey, el);
                        else actionJobRefs.current.delete(jobFocusKey);
                      }}
                      style={{
                        border: isJobFocused ? `1px solid ${jobColor}` : '1px solid rgba(148,163,184,0.18)',
                        borderRadius: 8,
                        padding: '8px 10px',
                        background: isJobFocused ? 'rgba(59,130,246,0.10)' : 'rgba(15,23,42,0.45)',
                        boxShadow: isJobFocused ? '0 0 0 1px rgba(59,130,246,0.30), 0 0 18px rgba(59,130,246,0.18)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: jobColor, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: jobColor }}>{actionStatusLabel(job.status, job.conclusion)}</span>
                        <span style={{ color: '#cbd5e1', fontSize: 12, flex: 1 }}>{job.name}</span>
                        {job.url && (
                          <a
                            href={job.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 11, color: '#60a5fa', textDecoration: 'none' }}
                            onClick={(e: MouseEvent) => e.stopPropagation()}
                          >
                            {t('repo.actions_view')}
                          </a>
                        )}
                      </div>
                      {steps.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {steps.map((step: any) => {
                            const stepColor = actionStatusColor(step.status, step.conclusion);
                            const isTestStep = isLikelyTestStep(step.name);
                            const stepFocusKey = `${item.id}:${job.name}:${step.name}`;
                            const isStepFocused = focusedActionTargetKey === stepFocusKey;
                            return (
                              <div
                                key={`${job.id}:${step.number}`}
                                ref={(el) => {
                                  if (el) actionStepRefs.current.set(stepFocusKey, el);
                                  else actionStepRefs.current.delete(stepFocusKey);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  paddingLeft: 16,
                                  paddingTop: 3,
                                  paddingBottom: 3,
                                  paddingRight: 8,
                                  borderRadius: 6,
                                  background: isStepFocused ? 'rgba(239,68,68,0.16)' : isTestStep ? 'rgba(59,130,246,0.10)' : 'transparent',
                                  boxShadow: isStepFocused ? '0 0 0 1px rgba(239,68,68,0.35), 0 0 14px rgba(239,68,68,0.18)' : 'none',
                                }}
                              >
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: stepColor, flexShrink: 0, display: 'inline-block' }} />
                                <span style={{ fontSize: 10, fontWeight: 600, color: stepColor, flexShrink: 0 }}>{actionStatusLabel(step.status, step.conclusion)}</span>
                                <span style={{ fontSize: 11, color: isTestStep ? '#bfdbfe' : '#94a3b8', fontWeight: isTestStep ? 600 : 400, flex: 1 }}>
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
      <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
        <div style={{ marginBottom: 12, color: '#f87171' }}>{detectError}</div>
        <div style={{ marginBottom: 12, fontSize: 11, color: '#475569' }}>{t('repo.retry')}</div>
        <button class="btn btn-sm" onClick={() => doDetect()}>{t('repo.retry')}</button>
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
        {tab.items.map(renderer)}
        {tab.loading && !tab.refreshing && (
          <div style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            {t('common.loading')}
          </div>
        )}
        {!tab.loading && tab.hasMore && (
          <button
            class="btn btn-sm"
            style={{ display: 'block', margin: '12px auto' }}
            onClick={handleLoadMore}
          >
            {t('repo.load_more')}
          </button>
        )}
      </PullToRefresh>
    );
  };

  // ── Styles ───────────────────────────────────────────────────────────────

  const listItemStyle: Record<string, any> = {
    padding: '10px 16px',
    borderBottom: '1px solid #1e293b',
    cursor: 'default',
  };

  // ── Main render ──────────────────────────────────────────────────────────

  return (
    <div class="repo-page">
      <style>{'@keyframes repo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid #1e293b',
        flexShrink: 0,
      }}>
        {detectLoading && !context && (
          <span style={{ color: '#94a3b8', fontSize: 13 }}>{t('common.loading')}</span>
        )}

        {detectError && !context && (
          <span style={{ color: '#f87171', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detectError}</span>
        )}

        {context && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12, overflow: 'hidden' }}>
            {context.provider && (
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 9999,
                background: context.provider === 'github' ? '#1e3a5f' : '#3b2d6b',
                color: context.provider === 'github' ? '#60a5fa' : '#a78bfa',
                textTransform: 'uppercase', flexShrink: 0,
              }}>
                {context.provider}
              </span>
            )}
            <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {context.owner && context.repo ? `${context.owner}/${context.repo}` : projectDir}
            </span>
            {context.defaultBranch && (
              <code style={{ fontSize: 11, color: '#64748b', background: '#1e293b', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>
                {context.defaultBranch}
              </code>
            )}
            {context.cliInstalled === false && (
              <span style={{ fontSize: 11, color: '#f87171', flexShrink: 0 }}>
                {t('repo.cli_not_installed')}
              </span>
            )}
          </div>
        )}

        {context?.lastRefresh && (
          <span style={{ fontSize: 10, color: '#475569', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {formatTime(context.lastRefresh)}
          </span>
        )}
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', borderBottom: '1px solid #1e293b', flexShrink: 0,
      }}>
        {(['issues', 'prs', 'branches', 'commits', 'actions'] as TabKey[]).map(key => (
          (() => {
            const tabError = tabs[key].error;
            return (
          <button
            key={key}
            onClick={() => handleTabClick(key)}
            title={tabError || undefined}
            style={{
              flex: 1, padding: '8px 0', fontSize: 13, fontWeight: 500,
              background: 'none', border: 'none', cursor: 'pointer',
              color: activeTab === key ? '#e2e8f0' : '#64748b',
              borderBottom: activeTab === key ? '2px solid #3b82f6' : '2px solid transparent',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {TAB_LABELS[key]}
            {tabError && (
              <span
                style={{ marginLeft: 6, fontSize: 11, color: '#ef4444', fontWeight: 700 }}
                aria-label={`${TAB_LABELS[key]} error`}
              >
                !
              </span>
            )}
            {(tabs[key].loading || tabs[key].refreshing) && (
              <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8', display: 'inline-block', animation: 'spin 1s linear infinite' }}>↻</span>
            )}
          </button>
            );
          })()
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {renderTabContent(activeTab)}
      </div>
    </div>
  );
}
