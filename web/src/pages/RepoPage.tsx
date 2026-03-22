import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Props {
  ws: WsClient;
  projectDir: string;
  onBack: () => void;
}

type TabKey = 'issues' | 'prs' | 'branches' | 'commits';

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
  });

  // Track pending requestIds to discard stale responses
  const pendingRef = useRef<Set<string>>(new Set());
  // Track detect requestId separately
  const detectReqRef = useRef<string | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const updateTab = useCallback((key: TabKey, patch: Partial<TabState>) => {
    setTabs(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

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

  const fetchTab = useCallback((key: TabKey, page = 1) => {
    updateTab(key, { loading: true, error: null });
    let rid: string;
    switch (key) {
      case 'issues':
        rid = ws.repoListIssues(projectDir, { page });
        break;
      case 'prs':
        rid = ws.repoListPRs(projectDir, { page });
        break;
      case 'branches':
        rid = ws.repoListBranches(projectDir);
        break;
      case 'commits':
        rid = ws.repoListCommits(projectDir, { page });
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
      if (msg.type === 'repo.detect_response') {
        if (msg.requestId !== detectReqRef.current) return;
        pendingRef.current.delete(msg.requestId);
        if (detectTimeoutRef.current) clearTimeout(detectTimeoutRef.current);
        setContext(mapDetectToContext((msg as any).context ?? msg));
        setDetectLoading(false);
        return;
      }

      // Passive detect push — only accept if projectDir matches
      if (msg.type === 'repo.detected') {
        if (msg.projectDir !== projectDir) return;
        setContext(prev => ({ ...prev, ...mapDetectToContext(msg.context) }));
        return;
      }

      // Error response
      if (msg.type === 'repo.error') {
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

      // Tab responses
      const tabMap: Record<string, TabKey> = {
        'repo.issues_response': 'issues',
        'repo.prs_response': 'prs',
        'repo.branches_response': 'branches',
        'repo.commits_response': 'commits',
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
    doDetect();
    // Re-fetch active tab
    updateTab(activeTab, { fetched: false, items: [], page: 1, hasMore: false });
    fetchTab(activeTab);
  }, [doDetect, activeTab, updateTab, fetchTab]);

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
    <div key={item.number ?? item.id} style={listItemStyle}>
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
  );

  const renderPrItem = (item: any) => (
    <div key={item.number ?? item.id} style={listItemStyle}>
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

  const renderCommitItem = (item: any) => (
    <div key={item.sha ?? item.oid ?? item.hash} style={listItemStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code style={{ color: '#60a5fa', fontSize: 11, flexShrink: 0 }}>
          {(item.sha ?? item.oid ?? item.hash ?? '').slice(0, 7)}
        </code>
        <span style={{ color: '#cbd5e1', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.message ?? item.title}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
        {item.author?.name ?? item.author ?? ''} {item.date ? `· ${formatTime(new Date(item.date).getTime())}` : ''}
      </div>
    </div>
  );

  const RENDERERS: Record<TabKey, (item: any) => any> = {
    issues: renderIssueItem,
    prs: renderPrItem,
    branches: renderBranchItem,
    commits: renderCommitItem,
  };

  const renderTabContent = (key: TabKey) => {
    // Show spinner while detect is in progress (tabs can't fetch without context)
    if (detectLoading) return renderSpinner();
    // Detect failed — show retry prompt (header already shows the error text)
    if (detectError) return (
      <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
        <div style={{ marginBottom: 12, color: '#f87171' }}>{detectError}</div>
        <div style={{ marginBottom: 12, fontSize: 11, color: '#475569', wordBreak: 'break-all' }}>projectDir: {projectDir}</div>
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
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: '#0f172a', color: '#e2e8f0',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      paddingTop: 'env(safe-area-inset-top)',
    }}>
      {/* Debug banner — remove after fixing repo detection */}
      <div style={{ background: '#1e293b', padding: '4px 12px', fontSize: 10, color: '#64748b', borderBottom: '1px solid #334155' }}>
        detect: {detectLoading ? 'loading' : detectError ? `error: ${detectError}` : context ? 'ok' : 'idle'} | dir: {projectDir?.slice(-30)} | reqId: {detectReqRef.current?.slice(0, 8) ?? 'none'}
      </div>
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
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <span style={{ color: '#f87171', fontSize: 13 }}>{detectError}</span>
            <span style={{ color: '#475569', fontSize: 10, marginLeft: 8 }}>{projectDir}</span>
          </div>
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
        {(['issues', 'prs', 'branches', 'commits'] as TabKey[]).map(key => (
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
