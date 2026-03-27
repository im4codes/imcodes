import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { WsClient, ServerMessage } from '../ws-client.js';

interface P2pNode {
  label: string;
  agentType: string;
  status: 'done' | 'active' | 'pending' | 'skipped';
}

interface LiveDiscussion {
  id: string;
  topic: string;
  state: string;
  currentRound: number;
  maxRounds: number;
  nodes?: P2pNode[];
}

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
  liveDiscussions?: LiveDiscussion[];
  onStopDiscussion?: (id: string) => void;
}

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

export function DiscussionsPage({ ws, initialSelectedId, liveDiscussions = [], onStopDiscussion }: Props) {
  const [discussions, setDiscussions] = useState<P2pDiscussion[]>([]);
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(() => {
    if (!ws) return;
    setLoading(true);
    ws.send({ type: 'p2p.list_discussions' });
  }, [ws]);

  useEffect(() => { loadList(); }, [loadList]);

  // Auto-select initialSelectedId once list is loaded
  const initialAppliedRef = useRef(false);
  useEffect(() => {
    if (initialAppliedRef.current || !initialSelectedId || discussions.length === 0) return;
    const match = discussions.find((d) => d.id === initialSelectedId || d.id.includes(initialSelectedId));
    if (match && selected !== match.id) {
      initialAppliedRef.current = true;
      selectDiscussion(match.id);
    }
  }, [discussions, initialSelectedId]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg: ServerMessage) => {
      if (msg.type === 'p2p.list_discussions_response') {
        setDiscussions((msg.discussions ?? []) as P2pDiscussion[]);
        setLoading(false);
      }
      if (msg.type === 'p2p.read_discussion_response') {
        if (msg.error) {
          setContent('(Failed to load)');
        } else {
          setContent(msg.content as string);
        }
      }
    });
  }, [ws]);

  const selectDiscussion = (id: string) => {
    setSelected(id);
    setContent(null);
    ws?.send({ type: 'p2p.read_discussion', id });
  };

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
      <div class="discussions-header">
        <h2>P2P Discussions</h2>
      </div>

      {/* Active P2P progress cards at top */}
      {activeLive.length > 0 && (
        <div class="discussions-progress-strip">
          {activeLive.map((d) => {
            const nodes = d.nodes ?? [];
            return (
              <div key={d.id} class="discussions-progress-card">
                {nodes.length > 0 && (
                  <div style={{ display: 'flex', gap: 1, height: 4, borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}>
                    {nodes.map((n, i) => (
                      <div key={i} style={{
                        flex: 1,
                        background: n.status === 'done' ? '#22c55e' : n.status === 'active' ? '#3b82f6' : n.status === 'skipped' ? '#ef4444' : '#334155',
                        transition: 'background 0.3s',
                      }} title={`${n.label} (${n.agentType}) — ${n.status}`} />
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#e2e8f0' }}>⚖️ {d.topic || 'Discussion'}</span>
                  {onStopDiscussion && (
                    <button class="btn btn-sm btn-danger" style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => onStopDiscussion(d.id)}>Stop</button>
                  )}
                </div>
                {nodes.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px', fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                    {nodes.map((n, i) => (
                      <span key={i} style={{
                        color: n.status === 'done' ? '#22c55e' : n.status === 'active' ? '#60a5fa' : n.status === 'skipped' ? '#f87171' : '#475569',
                        fontWeight: n.status === 'active' ? 600 : 400,
                      }}>
                        {n.status === 'done' ? '✓' : n.status === 'active' ? '▸' : n.status === 'skipped' ? '✕' : '○'}{' '}
                        {n.label} <span style={{ opacity: 0.6 }}>({n.agentType})</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div class="discussions-layout">
        <div class="discussions-list" style={initialSelectedId && selected ? { display: window.innerWidth < 768 ? 'none' : undefined } : undefined}>
          {loading && <div class="discussions-empty">Loading...</div>}
          {!loading && discussions.length === 0 && <div class="discussions-empty">No P2P discussions yet. Use @@all(discuss) or @agent to start one.</div>}
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

        <div class="discussions-detail">
          {!selected && (
            <div class="discussions-empty">Select a discussion to view</div>
          )}
          {selected && content === null && (
            <div class="discussions-empty">Loading...</div>
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
