import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { ChatMarkdown } from '../components/ChatMarkdown.js';
import { REPO_MSG } from '@shared/repo-types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ws: WsClient;
  projectDir: string;
  onBack: () => void;
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
  return { items: [], page: 1, hasMore: false, loading: false, error: null, fetched: false };
}

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

export function RepoPage({ ws, projectDir, onBack }: Props) {
  const { t } = useTranslation();

  const [context, setContext] = useState<RepoContext | null>(null);
  const [detectLoading, setDetectLoading] = useState(true);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('issues');

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
  // Track detect requestId separately
  const detectReqRef = useRef<string | null>(null);

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
    } catch {
      setDetailState(prev => new Map(prev).set(key, 'error'));
    }
  }, [ws, projectDir, expandedKey, detailData]);

  // ── Detect on mount ──────────────────────────────────────────────────────

  const detectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback(() => {
    setDetectLoading(true);
    setDetectError(null);

    let rid: string;
    try {
      rid = ws.repoDetect(projectDir);
    } catch (err) {
      setDetectError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
      setDetectLoading(false);
      return;
    }

    detectReqRef.current = rid;
    pendingRef.current.add(rid);

    // Timeout: if no response within 10s, show error with debug info
    if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
    detectTimeoutRef.current = setTimeout(() => {
      if (detectReqRef.current === rid && pendingRef.current.has(rid)) {
        pendingRef.current.delete(rid);
        setDetectError(`Detect timeout — no response after 10s (requestId: ${rid.slice(0, 8)})`);
        setDetectLoading(false);
      }
    }, 10_000);
  }, [ws, projectDir]);

  useEffect(() => { doDetect(); return () => { if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current); }; }, [doDetect]);

  // ── Tab data fetching ────────────────────────────────────────────────────

  const fetchTab = useCallback((key: TabKey, page = 1, force = false) => {
    updateTab(key, { loading: true, error: null });
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
  }, [ws, projectDir, updateTab]);

  // Lazy-load: fetch tab data on first activation
  useEffect(() => {
    if (!context) return; // wait until detect completes
    const tab = tabs[activeTab];
    if (!tab.fetched && !tab.loading) {
      fetchTab(activeTab);
    }
  }, [activeTab, context, tabs, fetchTab]);

  // ── Message handler ──────────────────────────────────────────────────────

  useEffect(() => {
    return ws.onMessage((msg: ServerMessage) => {
      // Detect response
      if (msg.type === REPO_MSG.DETECT_RESPONSE) {
        if (msg.requestId !== detectReqRef.current) return;
        pendingRef.current.delete(msg.requestId);
        if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
        setContext(mapDetectToContext((msg as any).context ?? msg));
        setDetectLoading(false);
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
        // Could be detect error or tab error
        if (msg.requestId === detectReqRef.current) {
          if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
          setDetectError(msg.error);
          setDetectLoading(false);
        } else {
          // Find which tab had this request — set error on all loading tabs
          // (we track per-request, but simplify by checking which tab is loading)
          setTabs(prev => {
            const next = { ...prev };
            for (const key of Object.keys(next) as TabKey[]) {
              if (next[key].loading) {
                next[key] = { ...next[key], loading: false, error: msg.error, fetched: true };
              }
            }
            return next;
          });
        }
        return;
      }

      // Detail responses
      if (msg.type === REPO_MSG.COMMIT_DETAIL_RESPONSE) {
        const m = msg as any;
        setDetailData(prev => new Map(prev).set(`commits:${m.detail.sha}`, m.detail));
        setDetailState(prev => new Map(prev).set(`commits:${m.detail.sha}`, 'loaded'));
        return;
      }
      if (msg.type === REPO_MSG.PR_DETAIL_RESPONSE) {
        const m = msg as any;
        setDetailData(prev => new Map(prev).set(`prs:${m.detail.number}`, m.detail));
        setDetailState(prev => new Map(prev).set(`prs:${m.detail.number}`, 'loaded'));
        return;
      }
      if (msg.type === REPO_MSG.ISSUE_DETAIL_RESPONSE) {
        const m = msg as any;
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
        // Stale response check — projectDir must match
        if (m.projectDir !== projectDir) return;
        setTabs(prev => {
          const existing = prev[tabKey];
          const isLoadMore = m.page > 1;
          return {
            ...prev,
            [tabKey]: {
              items: isLoadMore ? [...existing.items, ...m.items] : m.items,
              page: m.page,
              hasMore: m.hasMore,
              loading: false,
              error: null,
              fetched: true,
            },
          };
        });
      }
    });
  }, [ws, projectDir]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    // Force refresh — bypass daemon cache to get fresh data from gh/glab CLI
    setDetectLoading(true);
    setDetectError(null);
    let rid: string;
    try {
      rid = ws.repoDetect(projectDir, { force: true });
    } catch (err) {
      setDetectError(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
      setDetectLoading(false);
      return;
    }
    detectReqRef.current = rid;
    pendingRef.current.add(rid);
    // Re-fetch active tab with force
    updateTab(activeTab, { fetched: false, items: [], page: 1, hasMore: false });
    fetchTab(activeTab, 1, true);
  }, [ws, projectDir, activeTab, updateTab, fetchTab]);

  const handleRefreshTab = useCallback((key: TabKey) => {
    setTabs(prev => ({ ...prev, [key]: emptyTab() }));
    fetchTab(key, 1, true);
  }, [fetchTab]);

  const handleLoadMore = useCallback(() => {
    const tab = tabs[activeTab];
    if (tab.loading || !tab.hasMore) return;
    fetchTab(activeTab, tab.page + 1);
  }, [activeTab, tabs, fetchTab]);

  const handleTabClick = useCallback((key: TabKey) => {
    setActiveTab(key);
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
    const actor = typeof item.actor === 'string' ? item.actor : item.actor?.login;
    const eventColor = item.event ? (EVENT_COLORS[item.event] ?? '#64748b') : undefined;
    return (
      <div key={item.id ?? item.runId} style={listItemStyle}>
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
          {commitMsg && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
              {commitMsg.split('\n')[0]}
            </span>
          )}
          {actor && (
            <span>{actor}</span>
          )}
          {duration != null && duration > 0 && (
            <span>{formatDuration(duration)}</span>
          )}
          {item.createdAt && (
            <span>{formatRelativeTs(item.createdAt)}</span>
          )}
        </div>
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
    // Show spinner while detect is in progress (tabs can't fetch without context)
    if (detectLoading) return renderSpinner();
    // Detect failed — show retry prompt (header already shows the error text)
    if (detectError) return (
      <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
        <div style={{ marginBottom: 12, color: '#f87171' }}>{detectError}</div>
        <div style={{ marginBottom: 12, fontSize: 11, color: '#475569' }}>{t('repo.retry')}</div>
        <button class="btn btn-sm" onClick={doDetect}>{t('repo.retry')}</button>
      </div>
    );
    const tab = tabs[key];
    if (tab.loading && !tab.fetched) return renderSpinner();
    if (tab.error) return renderError(tab.error, key);
    if (tab.fetched && tab.items.length === 0) return renderEmpty(key);
    if (!tab.fetched && !tab.loading) return renderSpinner(); // waiting for lazy load

    const renderer = RENDERERS[key];
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 12px 0' }}>
          <button
            class="repo-detail-retry"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={() => handleRefreshTab(key)}
            disabled={tab.loading}
          >
            {t('repo.refresh_tab')}
          </button>
        </div>
        {tab.items.map(renderer)}
        {tab.loading && (
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
      </div>
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
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid #1e293b',
        flexShrink: 0,
      }}>
        <button class="btn btn-sm" onClick={onBack} style={{ flexShrink: 0 }}>
          {t('repo.back')}
        </button>

        {detectLoading && (
          <span style={{ color: '#94a3b8', fontSize: 13 }}>{t('common.loading')}</span>
        )}

        {detectError && (
          <span style={{ color: '#f87171', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detectError}</span>
        )}

        {context && !detectLoading && (
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

        <button class="btn btn-sm" onClick={handleRefresh} style={{ flexShrink: 0 }}>
          {t('repo.refresh')}
        </button>

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
          <button
            key={key}
            onClick={() => handleTabClick(key)}
            style={{
              flex: 1, padding: '8px 0', fontSize: 13, fontWeight: 500,
              background: 'none', border: 'none', cursor: 'pointer',
              color: activeTab === key ? '#e2e8f0' : '#64748b',
              borderBottom: activeTab === key ? '2px solid #3b82f6' : '2px solid transparent',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {TAB_LABELS[key]}
            {tabs[key].loading && (
              <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8' }}>...</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {renderTabContent(activeTab)}
      </div>
    </div>
  );
}
