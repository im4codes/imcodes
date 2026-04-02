import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';
import type { WsClient, ServerMessage } from '../ws-client.js';
import { P2pProgressCard } from '../components/P2pProgressCard.js';
import type { P2pProgressDiscussion } from '../components/P2pProgressCard.js';

interface P2pDiscussion {
  id: string;
  fileName: string;
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
  const [loading, setLoading] = useState(true);
  // Track which id we last requested, to prevent stale response overwriting current selection
  const pendingReadIdRef = useRef<string | null>(null);

  const loadList = useCallback(() => {
    if (!ws) return;
    setLoading(true);
    ws.send({ type: 'p2p.list_discussions' });
  }, [ws]);

  useEffect(() => { loadList(); }, [loadList]);

  const selectDiscussion = useCallback((id: string) => {
    setSelected(id);
    setContent(null);
    pendingReadIdRef.current = id;
    ws?.send({ type: 'p2p.read_discussion', id });
  }, [ws]);

  // Auto-refresh selected discussion content every 5s (like file browser preview)
  useEffect(() => {
    if (!selected || !ws) return;
    const timer = setInterval(() => {
      if (!pendingReadIdRef.current) {
        pendingReadIdRef.current = selected;
        ws.send({ type: 'p2p.read_discussion', id: selected });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [selected, ws]);

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
      ws?.send({ type: 'p2p.read_discussion', id: initialSelectedId });
    }
  }, [discussions, initialSelectedId, selected, content, ws, selectDiscussion]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === 'p2p.list_discussions_response') {
        setDiscussions((msg.discussions ?? []) as P2pDiscussion[]);
        setLoading(false);
      }
      if (msg.type === 'p2p.read_discussion_response') {
        // Only accept response matching the most recent request (prevent stale overwrite)
        const responseId = (msg as any).id as string | undefined;
        if (responseId && pendingReadIdRef.current && responseId !== pendingReadIdRef.current) return;
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
            ws?.send({ type: 'p2p.read_discussion', id: selected });
          }
        }
      }
    });
  }, [ws, selected, loadList]);

  const formatTime = (ts: number) => new Date(ts).toLocaleString();

  // Find matching live discussion for progress display
  const activeLive = liveDiscussions.filter((d) => d.state !== 'done' && d.state !== 'failed');

  // Render markdown content safely
  const renderMarkdown = (md: string): string => {
    try {
      return DOMPurify.sanitize(marked(md) as string);
    } catch {
      return DOMPurify.sanitize(md);
    }
  };

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
              {activeLive.map((d) => (
                <P2pProgressCard
                  key={d.id}
                  discussion={d}
                  onStopDiscussion={onStopDiscussion}
                />
              ))}
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
                <span class="discussions-list-time">{formatTime(d.mtime)}</span>
              </div>
            </div>
          ))}
        </div>

        <div class={`discussions-detail${selected ? ' discussions-detail-fullscreen' : ''}`}>
          {!selected && (
            <div class="discussions-empty">{t('p2p.discussions.select')}</div>
          )}
          {selected && (
            <button
              class="discussions-back-btn"
              onClick={() => { setSelected(null); setContent(null); }}
            >
              ← {t('p2p.picker.back')}
            </button>
          )}
          {selected && content === null && (
            <div class="discussions-empty">{t('common.loading')}</div>
          )}
          {selected && content !== null && (
            <div
              class="discussions-markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
