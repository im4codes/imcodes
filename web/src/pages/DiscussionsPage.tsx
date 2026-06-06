import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage, P2pWorkflowRequestScope } from '../ws-client.js';
import { P2pProgressCard } from '../components/P2pProgressCard.js';
import type { P2pProgressDiscussion } from '../components/P2pProgressCard.js';
import { FilePreviewPane } from '../components/FilePreviewPane.js';
import { P2P_WORKFLOW_MSG } from '@shared/p2p-workflow-messages.js';
import { OPENSPEC_AUTO_DELIVER_MSG, type OpenSpecAutoDeliverListRow, type OpenSpecAutoDeliverProjection } from '../openspec-auto-deliver.js';

interface P2pDiscussion {
  id: string;
  fileName: string;
  path?: string;
  preview: string;
  mtime: number;
}

interface Props {
  ws: WsClient | null;
  onBack?: () => void;
  initialSelectedId?: string | null;
  requestScope?: P2pWorkflowRequestScope;
  /** Live discussion state from app (progress, nodes). */
  liveDiscussions?: P2pProgressDiscussion[];
  onStopDiscussion?: (id: string) => void;
}

// Global marked config (breaks, gfm, target=_blank) is set in main.tsx

export function DiscussionsPage({ ws, initialSelectedId, requestScope, liveDiscussions = [], onStopDiscussion }: Props) {
  const { t } = useTranslation();
  const [progressHidden, setProgressHidden] = useState(false);
  const [listTab, setListTab] = useState<'auto' | 'team'>('team');
  const [discussions, setDiscussions] = useState<P2pDiscussion[]>([]);
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
  const [selectedAutoRunId, setSelectedAutoRunId] = useState<string | null>(null);
  const [autoDeliverRows, setAutoDeliverRows] = useState<OpenSpecAutoDeliverListRow[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [copyMenuId, setCopyMenuId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Track which id we last requested, to prevent stale response overwriting current selection
  const pendingReadIdRef = useRef<string | null>(null);
  const pendingReadRequestIdRef = useRef<string | null>(null);
  const pendingCopyRef = useRef<{ id: string; requestId: string } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollAnimFrameRef = useRef<number | null>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);

  const stopDetailScrollAnimation = useCallback(() => {
    if (scrollAnimFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimFrameRef.current);
      scrollAnimFrameRef.current = null;
    }
  }, []);

  const scrollDetailTo = useCallback((targetTop: number, mode: 'auto' | 'button' | 'follow') => {
    const el = detailScrollRef.current;
    if (!el) return;
    stopDetailScrollAnimation();
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const clampedTarget = Math.max(0, Math.min(targetTop, maxTop));
    const currentTop = el.scrollTop;
    const distance = clampedTarget - currentTop;
    if (Math.abs(distance) < 1) {
      el.scrollTop = clampedTarget;
      return;
    }

    const prefersReducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mobileViewport = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 768px)').matches;

    if (
      mode === 'auto'
      || prefersReducedMotion
      || (mobileViewport && mode === 'follow')
      || (mobileViewport && Math.abs(distance) > 4000)
    ) {
      el.scrollTop = clampedTarget;
      return;
    }

    const duration = mobileViewport ? 220 : mode === 'button' ? 320 : 220;
    const startAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startAt) / duration);
      const eased = 1 - ((1 - progress) ** 3);
      el.scrollTop = currentTop + (distance * eased);
      if (progress < 1) {
        scrollAnimFrameRef.current = requestAnimationFrame(tick);
      } else {
        el.scrollTop = clampedTarget;
        scrollAnimFrameRef.current = null;
      }
    };

    scrollAnimFrameRef.current = requestAnimationFrame(tick);
  }, [stopDetailScrollAnimation]);

  const scrollDetailToTop = useCallback((mode: 'auto' | 'button' | 'follow' = 'button') => {
    scrollDetailTo(0, mode);
  }, [scrollDetailTo]);

  const scrollDetailToBottom = useCallback((mode: 'auto' | 'button' | 'follow' = 'button') => {
    const el = detailScrollRef.current;
    if (!el) return;
    scrollDetailTo(el.scrollHeight, mode);
  }, [scrollDetailTo]);

  // Audit fix (DiscussionsPage spam-fetch loop) — stabilize the
  // request-scope identity by content. See the long comment on
  // `stableRequestScope` below for the rationale.
  const stableRequestScopeKey = useMemo(() => JSON.stringify(requestScope ?? null), [requestScope]);
  const stableRequestScope = useMemo(() => requestScope, [stableRequestScopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendReadDiscussion = useCallback((id: string): string | null => {
    return ws?.p2pReadDiscussion(id, stableRequestScope) ?? null;
  }, [stableRequestScope, ws]);

  const loadList = useCallback(() => {
    if (!ws) return;
    setLoading(true);
    ws.p2pListDiscussions(stableRequestScope);
  }, [stableRequestScope, ws]);

  useEffect(() => { loadList(); }, [loadList]);

  const loadAutoDeliverRows = useCallback(() => {
    if (!ws || !stableRequestScope?.sessionName) return;
    ws.send({
      type: OPENSPEC_AUTO_DELIVER_MSG.LIST_REQUEST,
      requestId: `openspec-auto-list-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionName: stableRequestScope.sessionName,
    });
  }, [stableRequestScope, ws]);

  useEffect(() => { loadAutoDeliverRows(); }, [loadAutoDeliverRows]);

  const upsertAutoDeliverRow = useCallback((row: OpenSpecAutoDeliverListRow) => {
    if (!row.runId) return;
    setAutoDeliverRows((current) => {
      const existing = current.find((entry) => entry.runId === row.runId);
      if (existing && existing.projectionVersion > row.projectionVersion) return current;
      const next = [row, ...current.filter((entry) => entry.runId !== row.runId)];
      return next
        .sort((a, b) => b.projectionVersion - a.projectionVersion)
        .slice(0, 20);
    });
  }, []);

  const rowFromProjection = useCallback((projection: OpenSpecAutoDeliverProjection): OpenSpecAutoDeliverListRow => ({
    projectionVersion: projection.projectionVersion,
    visibility: projection.visibility,
    runId: projection.runId,
    owningMainSessionName: projection.owningMainSessionName ?? '',
    status: projection.status,
    stage: projection.stage,
    viewMode: projection.visibility === 'conflict'
      ? 'conflict'
      : projection.terminal ? 'compactRecovery' : 'fullRunbar',
    ...(projection.visibility === 'full'
      ? {
        changeName: projection.changeName,
        presetId: projection.presetId,
        selectedTeamComboId: projection.selectedTeamComboId ?? undefined,
        targetImplementationSessionName: projection.targetImplementationSessionName,
        launchedFromSessionName: projection.launchedFromSessionName,
        elapsedMs: projection.elapsedMs,
        terminalReason: projection.terminalReason ?? undefined,
      }
      : {
        reason: projection.conflictReason ?? projection.reason,
      }),
  }), []);

  // Audit fix (spam-fetch loop) — even though `loadList` itself is
  // stable when `requestScope` has a stable identity, the
  // `RUN_UPDATE` handler below calls `loadList()` on every P2P run
  // update push from the daemon. With many runs updating in quick
  // succession (canvas projection at 5 Hz × N runs) this can still
  // saturate the bridge's per-socket pending cap. A small debounced
  // wrapper coalesces bursts into a single fetch.
  const loadListDebouncedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestListRefresh = useCallback(() => {
    if (loadListDebouncedTimerRef.current) clearTimeout(loadListDebouncedTimerRef.current);
    loadListDebouncedTimerRef.current = setTimeout(() => {
      loadListDebouncedTimerRef.current = null;
      loadList();
    }, 250);
  }, [loadList]);
  useEffect(() => () => {
    if (loadListDebouncedTimerRef.current) clearTimeout(loadListDebouncedTimerRef.current);
  }, []);

  const selectDiscussion = useCallback((id: string) => {
    setListTab('team');
    setSelectedAutoRunId(null);
    setSelected(id);
    setContent(null);
    setAutoFollow(true);
    setCopyMenuId(null);
    pendingReadIdRef.current = id;
    pendingReadRequestIdRef.current = sendReadDiscussion(id);
  }, [sendReadDiscussion]);

  const selectAutoDeliverRun = useCallback((runId: string) => {
    setListTab('auto');
    setSelected(null);
    setContent(null);
    setSelectedAutoRunId(runId);
  }, []);

  const markCopied = useCallback((id: string) => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedId(id);
    copiedTimerRef.current = setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
      copiedTimerRef.current = null;
    }, 1500);
  }, []);

  const copyText = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMenuId(null);
      markCopied(id);
    } catch {
      setCopyMenuId(null);
    }
  }, [markCopied]);

  const handleCopyPath = useCallback(async (discussion: P2pDiscussion) => {
    const text = discussion.path ?? discussion.fileName;
    if (!text) return;
    await copyText(discussion.id, text);
  }, [copyText]);

  const handleCopyContent = useCallback(async (discussion: P2pDiscussion) => {
    if (selected === discussion.id && content !== null) {
      await copyText(discussion.id, content);
      return;
    }
    const sentRequestId = sendReadDiscussion(discussion.id);
    if (!sentRequestId) return;
    pendingCopyRef.current = { id: discussion.id, requestId: sentRequestId };
    setCopyMenuId(null);
  }, [content, copyText, selected, sendReadDiscussion]);

  // Auto-refresh selected discussion content every 5s (like file browser preview)
  useEffect(() => {
    if (!selected || !ws) return;
    const timer = setInterval(() => {
      if (!pendingReadIdRef.current) {
        pendingReadIdRef.current = selected;
        pendingReadRequestIdRef.current = sendReadDiscussion(selected);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [selected, sendReadDiscussion, ws]);

  // Auto-select initialSelectedId: try immediately (even before list loads)
  const initialAppliedRef = useRef(false);
  useEffect(() => {
    if (initialAppliedRef.current || !initialSelectedId) return;
    // Try to match in list
    if (discussions.length > 0) {
      const match = discussions.find((d) => d.id === initialSelectedId || d.id.includes(initialSelectedId));
      if (match) {
        initialAppliedRef.current = true;
        selectDiscussion(match.id);
        return;
      }
    }
    // Even if not in list yet (active run), try to read directly
    if (selected === initialSelectedId && content === null && !pendingReadIdRef.current) {
      pendingReadIdRef.current = initialSelectedId;
      pendingReadRequestIdRef.current = sendReadDiscussion(initialSelectedId);
    }
  }, [discussions, initialSelectedId, selected, content, sendReadDiscussion, selectDiscussion]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === P2P_WORKFLOW_MSG.LIST_DISCUSSIONS_RESPONSE) {
        setDiscussions((msg.discussions ?? []) as P2pDiscussion[]);
        setLoading(false);
      }
      if (msg.type === OPENSPEC_AUTO_DELIVER_MSG.LIST_RESPONSE) {
        const rows = Array.isArray((msg as { rows?: unknown }).rows)
          ? (msg as { rows: OpenSpecAutoDeliverListRow[] }).rows
          : [];
        setAutoDeliverRows(rows);
        if (!selectedAutoRunId && rows[0]?.runId) setSelectedAutoRunId(rows[0].runId);
      }
      if (
        msg.type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK
        || msg.type === OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION
        || msg.type === OPENSPEC_AUTO_DELIVER_MSG.PROJECTION
        || msg.type === OPENSPEC_AUTO_DELIVER_MSG.CONFLICT_SUMMARY
        || msg.type === OPENSPEC_AUTO_DELIVER_MSG.TERMINAL
      ) {
        const projection = (msg as { projection?: OpenSpecAutoDeliverProjection | null }).projection;
        if (projection?.runId) {
          upsertAutoDeliverRow(rowFromProjection(projection));
          if (!selectedAutoRunId) setSelectedAutoRunId(projection.runId);
        }
      }
      if (msg.type === P2P_WORKFLOW_MSG.READ_DISCUSSION_RESPONSE) {
        const responseRequestId = msg.requestId;
        const pendingCopy = pendingCopyRef.current;
        if (pendingCopy && responseRequestId === pendingCopy.requestId) {
          pendingCopyRef.current = null;
          if (!msg.error && typeof msg.content === 'string') {
            void copyText(pendingCopy.id, msg.content);
          }
          return;
        }
        if (responseRequestId && pendingReadRequestIdRef.current && responseRequestId !== pendingReadRequestIdRef.current) return;
        // Only accept response matching the most recent request (prevent stale overwrite)
        const responseId = (msg as any).id as string | undefined;
        if (responseId && pendingReadIdRef.current && responseId !== pendingReadIdRef.current) return;
        pendingReadRequestIdRef.current = null;
        pendingReadIdRef.current = null;
        if (msg.error) {
          setContent(t('p2p.discussions.load_failed'));
        } else {
          setContent(msg.content as string);
        }
      }
      // Auto-refresh: when a P2P run updates and we're viewing that discussion, reload content
      if (msg.type === P2P_WORKFLOW_MSG.RUN_UPDATE) {
        const run = (msg as any).run;
        if (!run) return;
        // Refresh list to pick up new/updated discussions — debounced
        // so a burst of run updates doesn't saturate the bridge's
        // per-socket pending cap.
        requestListRefresh();
        // If we're viewing this discussion's file, reload content
        const runFileId = run.discussion_id ? String(run.discussion_id) : run.id;
        if (selected && (selected === runFileId || selected.includes(run.id))) {
          // Debounce: don't reload if we already have a pending read
          if (!pendingReadIdRef.current) {
            pendingReadIdRef.current = selected;
            pendingReadRequestIdRef.current = sendReadDiscussion(selected);
          }
        }
      }
    });
  }, [copyText, requestListRefresh, rowFromProjection, selected, selectedAutoRunId, sendReadDiscussion, t, upsertAutoDeliverRow, ws]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    stopDetailScrollAnimation();
  }, [stopDetailScrollAnimation]);

  useEffect(() => {
    if (!copyMenuId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.discussions-copy-wrap')) return;
      setCopyMenuId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [copyMenuId]);

  useEffect(() => {
    if (!selected || content === null || !autoFollow) return;
    requestAnimationFrame(() => {
      scrollDetailToBottom(content.length > 4000 ? 'auto' : 'follow');
    });
  }, [selected, content, autoFollow, scrollDetailToBottom]);

  const formatTime = (ts: number) => new Date(ts).toLocaleString();

  // Find matching live discussion for progress display
  const activeLive = useMemo(
    () => liveDiscussions.filter((d) => d.state !== 'done' && d.state !== 'failed'),
    [liveDiscussions],
  );
  const selectedDiscussion = useMemo(
    () => (selected ? discussions.find((d) => d.id === selected) ?? null : null),
    [discussions, selected],
  );
  const selectedAutoDeliverRow = useMemo(
    () => (selectedAutoRunId ? autoDeliverRows.find((row) => row.runId === selectedAutoRunId) ?? null : null),
    [autoDeliverRows, selectedAutoRunId],
  );

  return (
    <div class="discussions-page">
      {/* Active P2P progress cards at top */}
      {activeLive.length > 0 && (
        <div class="discussions-progress-strip">
          <div class="discussions-progress-strip-header">
            <div class="discussions-progress-strip-headcopy">
              <div class="discussions-progress-strip-title">
                {t('p2p.discussions.live_progress')} · {activeLive.length}
              </div>
            </div>
            <button
              class="discussions-progress-strip-toggle"
              onClick={() => setProgressHidden((v) => !v)}
            >
              {progressHidden ? t('p2p.discussions.show') : t('p2p.discussions.hide')}
            </button>
          </div>
          {!progressHidden && (
            <div class="discussions-progress-strip-scroll">
              <div class="discussions-progress-strip-inner">
                {activeLive.map((d) => (
                  <P2pProgressCard
                    key={d.id}
                    discussion={d}
                    onStopDiscussion={onStopDiscussion}
                    // Clicking a live progress card opens the
                    // associated discussion file in the right-hand
                    // detail pane (or full-screen on mobile). Without
                    // this, the bar at the top and the discussion
                    // list below were two unrelated UIs — users had
                    // to manually find the matching entry in the list
                    // by id, even though the live bar already knows
                    // the fileId. The mapping in
                    // `p2p-run-mapping.ts` puts `discussion_id` (=
                    // the discussion file's id) onto `fileId`, which
                    // matches the `id` of an entry in the
                    // `discussions` list rendered below.
                    onClick={d.fileId ? () => selectDiscussion(d.fileId!) : undefined}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div class="discussions-layout">
        <div class="discussions-list" style={initialSelectedId && selected ? { display: window.innerWidth < 768 ? 'none' : undefined } : undefined}>
          <div class="discussions-list-tabs">
            <button
              type="button"
              class={`discussions-list-tab${listTab === 'auto' ? ' active' : ''}`}
              onClick={() => setListTab('auto')}
            >
              {t('openspec.auto.list_title')}
            </button>
            <button
              type="button"
              class={`discussions-list-tab${listTab === 'team' ? ' active' : ''}`}
              onClick={() => setListTab('team')}
            >
              {t('p2p.discussions.title')}
            </button>
          </div>
          {listTab === 'auto' ? (
            <>
              {autoDeliverRows.length === 0 && <div class="discussions-empty">{t('openspec.auto.list_empty')}</div>}
              {autoDeliverRows.map((row) => (
                <div
                  key={row.runId}
                  class={`discussions-list-item${selectedAutoRunId === row.runId ? ' active' : ''}`}
                  onClick={() => selectAutoDeliverRun(row.runId)}
                >
                  <div class="discussions-list-topic">
                    {row.visibility === 'conflict' ? row.owningMainSessionName : (row.changeName ?? row.runId)}
                  </div>
                  <div class="discussions-list-meta">
                    <span style={{ color: '#64748b', fontSize: 11 }}>{row.stage}</span>
                    <span class="discussions-list-time">{row.status}</span>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              {loading && <div class="discussions-empty">{t('common.loading')}</div>}
              {!loading && discussions.length === 0 && <div class="discussions-empty">{t('p2p.discussions.empty')}</div>}
              {discussions.map((d) => (
                <div
                  key={d.id}
                  class={`discussions-list-item${selected === d.id ? ' active' : ''}`}
                  onClick={() => selectDiscussion(d.id)}
                >
                  <div class="discussions-list-topic">{d.preview}</div>
                  <div class="discussions-list-meta">
                    <span style={{ color: '#64748b', fontSize: 11 }}>{d.id}</span>
                    <span class="discussions-list-time">{formatTime(d.mtime)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div class={`discussions-detail${selected || selectedAutoRunId ? ' discussions-detail-fullscreen' : ''}`}>
          {selectedAutoDeliverRow && listTab === 'auto' && (
            <div class="discussions-nav-row">
              <button
                class="discussions-back-btn"
                onClick={() => setSelectedAutoRunId(null)}
              >
                ← {t('p2p.picker.back')}
              </button>
            </div>
          )}
          {selectedAutoDeliverRow && listTab === 'auto' && (
            <div class="discussions-detail-scroll">
              <div class="discussions-file-preview">
                <div class="openspec-auto-list-detail">
                  <div class="openspec-auto-kicker">{t('openspec.auto.list_title')}</div>
                  <h3>{selectedAutoDeliverRow.changeName ?? selectedAutoDeliverRow.owningMainSessionName ?? selectedAutoDeliverRow.runId}</h3>
                  <div class="openspec-auto-detail-grid">
                    <div class="openspec-auto-detail-row"><span>{t('openspec.auto.status_label')}</span><strong>{selectedAutoDeliverRow.status}</strong></div>
                    <div class="openspec-auto-detail-row"><span>{t('openspec.auto.stage_label')}</span><strong>{selectedAutoDeliverRow.stage}</strong></div>
                    <div class="openspec-auto-detail-row"><span>{t('openspec.auto.owning_session')}</span><strong>{selectedAutoDeliverRow.owningMainSessionName}</strong></div>
                    {selectedAutoDeliverRow.targetImplementationSessionName && (
                      <div class="openspec-auto-detail-row"><span>{t('openspec.auto.execution_session')}</span><strong>{selectedAutoDeliverRow.targetImplementationSessionName}</strong></div>
                    )}
                    {selectedAutoDeliverRow.selectedTeamComboId && (
                      <div class="openspec-auto-detail-row"><span>{t('openspec.auto.combo_id')}</span><strong>{selectedAutoDeliverRow.selectedTeamComboId}</strong></div>
                    )}
                    {selectedAutoDeliverRow.terminalReason && (
                      <div class="openspec-auto-detail-row"><span>{t('openspec.auto.terminal_reason')}</span><strong>{selectedAutoDeliverRow.terminalReason}</strong></div>
                    )}
                    {selectedAutoDeliverRow.reason && (
                      <div class="openspec-auto-detail-row"><span>{t('openspec.auto.conflict_summary')}</span><strong>{selectedAutoDeliverRow.reason}</strong></div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {listTab === 'auto' && !selectedAutoDeliverRow && (
            <div class="discussions-detail-scroll">
              <div class="discussions-empty">{t('openspec.auto.list_select')}</div>
            </div>
          )}
          {listTab === 'team' && (
            <>
          {selected && (
            <div class="discussions-nav-row">
              <button
                class="discussions-back-btn"
                onClick={() => { setSelected(null); setContent(null); setAutoFollow(true); }}
              >
                ← {t('p2p.picker.back')}
              </button>
              <div class="discussions-nav-controls">
                <label class="discussions-follow-toggle">
                  <input
                    type="checkbox"
                    checked={autoFollow}
                    onChange={(e) => setAutoFollow((e.target as HTMLInputElement).checked)}
                  />
                  <span>{t('p2p.discussions.auto_follow_latest')}</span>
                </label>
                {selectedDiscussion && (
                  <div class="discussions-copy-wrap">
                    <button
                      type="button"
                      class={`discussions-copy-btn discussions-scroll-btn-floating${copiedId === selectedDiscussion.id ? ' is-copied' : ''}`}
                      aria-label={copiedId === selectedDiscussion.id ? t('common.copied') : t('common.copy')}
                      title={copiedId === selectedDiscussion.id ? t('common.copied') : t('common.copy')}
                      onClick={() => setCopyMenuId((current) => (current === selectedDiscussion.id ? null : selectedDiscussion.id))}
                    >
                      ⧉
                    </button>
                    {copyMenuId === selectedDiscussion.id && (
                      <div class="discussions-copy-menu">
                        <button type="button" class="discussions-copy-menu-item" onClick={() => { void handleCopyPath(selectedDiscussion); }}>
                          {t('p2p.discussions.copy_path')}
                        </button>
                        <button type="button" class="discussions-copy-menu-item" onClick={() => { void handleCopyContent(selectedDiscussion); }}>
                          {t('p2p.discussions.copy_content')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div class="discussions-scroll-arrows">
                  <button
                    class="discussions-scroll-btn discussions-scroll-btn-floating"
                    onClick={() => {
                      setAutoFollow(false);
                      scrollDetailToTop('button');
                    }}
                    title={t('p2p.discussions.scroll_top')}
                  >
                    ↑
                  </button>
                  <button
                    class="discussions-scroll-btn discussions-scroll-btn-floating"
                    onClick={() => {
                      setAutoFollow(true);
                      scrollDetailToBottom('button');
                    }}
                    title={t('p2p.discussions.scroll_bottom')}
                  >
                    ↓
                  </button>
                </div>
              </div>
            </div>
          )}
          <div ref={detailScrollRef} class="discussions-detail-scroll">
            {!selected && (
              <div class="discussions-empty">{t('p2p.discussions.select')}</div>
            )}
            {selected && content === null && (
              <div class="discussions-empty">{t('common.loading')}</div>
            )}
            {selected && content !== null && (
              <div class="discussions-file-preview">
                <FilePreviewPane content={content} path={`${selected}.md`} />
              </div>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
