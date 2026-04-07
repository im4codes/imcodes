import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { P2pProgressCard } from '../components/P2pProgressCard.js';
import type { P2pProgressDiscussion } from '../components/P2pProgressCard.js';
import { FilePreviewPane } from '../components/FilePreviewPane.js';

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
  /** Live discussion state from app (progress, nodes). */
  liveDiscussions?: P2pProgressDiscussion[];
  onStopDiscussion?: (id: string) => void;
}

// Global marked config (breaks, gfm, target=_blank) is set in main.tsx

export function DiscussionsPage({ ws, initialSelectedId, liveDiscussions = [], onStopDiscussion }: Props) {
  const { t } = useTranslation();
  const [progressHidden, setProgressHidden] = useState(false);
  const [discussions, setDiscussions] = useState<P2pDiscussion[]>([]);
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
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

  const sendReadDiscussion = useCallback((id: string, requestId: string) => {
    ws?.send({ type: 'p2p.read_discussion', id, requestId });
  }, [ws]);

  const loadList = useCallback(() => {
    if (!ws) return;
    setLoading(true);
    ws.send({ type: 'p2p.list_discussions' });
  }, [ws]);

  useEffect(() => { loadList(); }, [loadList]);

  const selectDiscussion = useCallback((id: string) => {
    setSelected(id);
    setContent(null);
    setAutoFollow(true);
    setCopyMenuId(null);
    pendingReadIdRef.current = id;
    pendingReadRequestIdRef.current = crypto.randomUUID();
    sendReadDiscussion(id, pendingReadRequestIdRef.current);
  }, [sendReadDiscussion]);

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
    const requestId = crypto.randomUUID();
    pendingCopyRef.current = { id: discussion.id, requestId };
    setCopyMenuId(null);
    sendReadDiscussion(discussion.id, requestId);
  }, [content, copyText, selected, sendReadDiscussion]);

  // Auto-refresh selected discussion content every 5s (like file browser preview)
  useEffect(() => {
    if (!selected || !ws) return;
    const timer = setInterval(() => {
      if (!pendingReadIdRef.current) {
        pendingReadIdRef.current = selected;
        pendingReadRequestIdRef.current = crypto.randomUUID();
        sendReadDiscussion(selected, pendingReadRequestIdRef.current);
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
      pendingReadRequestIdRef.current = crypto.randomUUID();
      sendReadDiscussion(initialSelectedId, pendingReadRequestIdRef.current);
    }
  }, [discussions, initialSelectedId, selected, content, sendReadDiscussion, selectDiscussion]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === 'p2p.list_discussions_response') {
        setDiscussions((msg.discussions ?? []) as P2pDiscussion[]);
        setLoading(false);
      }
      if (msg.type === 'p2p.read_discussion_response') {
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
      if (msg.type === 'p2p.run_update') {
        const run = (msg as any).run;
        if (!run) return;
        // Refresh list to pick up new/updated discussions
        loadList();
        // If we're viewing this discussion's file, reload content
        const runFileId = run.discussion_id ? String(run.discussion_id) : run.id;
        if (selected && (selected === runFileId || selected.includes(run.id))) {
          // Debounce: don't reload if we already have a pending read
          if (!pendingReadIdRef.current) {
            pendingReadIdRef.current = selected;
            pendingReadRequestIdRef.current = crypto.randomUUID();
            sendReadDiscussion(selected, pendingReadRequestIdRef.current);
          }
        }
      }
    });
  }, [copyText, loadList, selected, sendReadDiscussion, t, ws]);

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
  const activeLive = liveDiscussions.filter((d) => d.state !== 'done' && d.state !== 'failed');

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
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div class="discussions-layout">
        <div class="discussions-list" style={initialSelectedId && selected ? { display: window.innerWidth < 768 ? 'none' : undefined } : undefined}>
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
                <div class="discussions-list-actions">
                  <div class="discussions-copy-wrap" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      class={`discussions-copy-btn${copiedId === d.id ? ' is-copied' : ''}`}
                      aria-label={copiedId === d.id ? t('common.copied') : t('common.copy')}
                      title={copiedId === d.id ? t('common.copied') : t('common.copy')}
                      onClick={() => setCopyMenuId((current) => (current === d.id ? null : d.id))}
                    >
                      ⧉
                    </button>
                    {copyMenuId === d.id && (
                      <div class="discussions-copy-menu">
                        <button type="button" class="discussions-copy-menu-item" onClick={() => { void handleCopyPath(d); }}>
                          {t('p2p.discussions.copy_path')}
                        </button>
                        <button type="button" class="discussions-copy-menu-item" onClick={() => { void handleCopyContent(d); }}>
                          {t('p2p.discussions.copy_content')}
                        </button>
                      </div>
                    )}
                  </div>
                  <span class="discussions-list-time">{formatTime(d.mtime)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div class={`discussions-detail${selected ? ' discussions-detail-fullscreen' : ''}`}>
          {selected && (
            <div class="discussions-nav-row">
              <button
                class="discussions-back-btn"
                onClick={() => { setSelected(null); setContent(null); setAutoFollow(true); }}
              >
                ← {t('p2p.picker.back')}
              </button>
              <label class="discussions-follow-toggle">
                <input
                  type="checkbox"
                  checked={autoFollow}
                  onChange={(e) => setAutoFollow((e.target as HTMLInputElement).checked)}
                />
                <span>{t('p2p.discussions.auto_follow_latest')}</span>
              </label>
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
          {selected && (
            <div class="discussions-scroll-dock">
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
          )}
        </div>
      </div>
    </div>
  );
}
