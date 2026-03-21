import { useState, useEffect, useCallback } from 'preact/hooks';
import type { WsClient, ServerMessage } from '../ws-client.js';

interface P2pDiscussion {
  id: string;
  fileName: string;
  preview: string;
  mtime: number;
}

interface Props {
  ws: WsClient | null;
  onBack: () => void;
  /** Pre-select a discussion file by ID on open (e.g. from clicking a P2P progress card). */
  initialSelectedId?: string | null;
}

export function DiscussionsPage({ ws, onBack, initialSelectedId }: Props) {
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
  const initialAppliedRef = { current: false };
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

  return (
    <div class="discussions-page">
      <div class="discussions-header">
        <button class="btn btn-sm" onClick={onBack}>← Back</button>
        <h2>P2P Discussions</h2>
        <button class="btn btn-sm" onClick={loadList}>Refresh</button>
      </div>

      <div class="discussions-layout">
        <div class="discussions-list">
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
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: 16, fontSize: 13, lineHeight: 1.6, color: '#cbd5e1' }}>
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
