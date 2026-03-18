import { useState, useEffect, useCallback } from 'preact/hooks';
import { apiFetch } from '../api.js';
import type { WsClient, ServerMessage } from '../ws-client.js';

interface Discussion {
  id: string;
  topic: string;
  state: string;
  max_rounds: number;
  current_round: number;
  current_speaker: string | null;
  participants: string | null;
  file_path: string | null;
  conclusion: string | null;
  file_content: string | null;
  started_at: number;
  finished_at: number | null;
}

interface Round {
  id: string;
  discussion_id: string;
  round: number;
  speaker_role: string;
  speaker_agent: string;
  speaker_model: string | null;
  response: string;
  created_at: number;
}

interface Props {
  serverId: string;
  ws: WsClient | null;
  onBack: () => void;
}

export function DiscussionsPage({ serverId, ws, onBack }: Props) {
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);

  // Load discussion list from DB
  const loadDiscussions = useCallback(async () => {
    try {
      const data = await apiFetch<{ discussions: Discussion[] }>(`/api/server/${serverId}/discussions`);
      setDiscussions(data.discussions);
    } catch { /* ignore */ }
    setLoading(false);
  }, [serverId]);

  useEffect(() => { void loadDiscussions(); }, [loadDiscussions]);

  // Listen for live WS updates
  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg: ServerMessage) => {
      if (msg.type === 'discussion.started') {
        setDiscussions((prev) => [{
          id: msg.discussionId, topic: msg.topic, state: 'setup',
          max_rounds: msg.maxRounds, current_round: 0, current_speaker: null,
          participants: null, file_path: null, conclusion: null, file_content: null,
          started_at: Date.now(), finished_at: null,
        }, ...prev]);
      }
      if (msg.type === 'discussion.update') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: msg.state as string, current_round: msg.currentRound as number, current_speaker: (msg.currentSpeaker as string) ?? null }
            : d,
        ));
        // Update rounds live if viewing this discussion
        if (msg.lastResponse && msg.discussionId === selected) {
          setRounds((prev) => [...prev, {
            id: crypto.randomUUID(),
            discussion_id: msg.discussionId as string,
            round: msg.currentRound as number,
            speaker_role: (msg.currentSpeaker as string) ?? '',
            speaker_agent: '',
            speaker_model: null,
            response: msg.lastResponse as string,
            created_at: Date.now(),
          }]);
        }
      }
      if (msg.type === 'discussion.done') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: 'done', conclusion: msg.conclusion, file_path: msg.filePath }
            : d,
        ));
        // Reload full rounds from DB if viewing this discussion
        if (msg.discussionId === selected) {
          void loadDetail(msg.discussionId);
        }
      }
      if (msg.type === 'discussion.error') {
        if (msg.discussionId) {
          setDiscussions((prev) => prev.map((d) =>
            d.id === msg.discussionId ? { ...d, state: 'failed' } : d,
          ));
        }
      }
    });
    return unsub;
  }, [ws, selected]);

  // Load discussion detail
  const loadDetail = useCallback(async (id: string) => {
    setSelected(id);
    setRounds([]);
    try {
      const data = await apiFetch<{ discussion: Discussion; rounds: Round[] }>(`/api/server/${serverId}/discussions/${id}`);
      setRounds(data.rounds);
      // Update discussion with full data
      setDiscussions((prev) => prev.map((d) => d.id === id ? { ...d, ...data.discussion } : d));
    } catch { /* ignore */ }
  }, [serverId]);

  const selectedDiscussion = discussions.find((d) => d.id === selected);

  const stateLabel = (state: string) => {
    switch (state) {
      case 'setup': return 'Setting up...';
      case 'running': return 'Running';
      case 'verdict': return 'Verdict...';
      case 'done': return 'Complete';
      case 'failed': return 'Failed';
      default: return state;
    }
  };

  const stateColor = (state: string) => {
    switch (state) {
      case 'running': case 'verdict': return '#4ecdc4';
      case 'done': return '#27ae60';
      case 'failed': return '#e74c3c';
      default: return '#888';
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  return (
    <div class="discussions-page">
      <div class="discussions-header">
        <button class="btn btn-sm" onClick={onBack}>← Back</button>
        <h2>Discussions</h2>
        <button class="btn btn-sm" onClick={() => void loadDiscussions()}>Refresh</button>
      </div>

      <div class="discussions-layout">
        {/* List */}
        <div class="discussions-list">
          {loading && <div class="discussions-empty">Loading...</div>}
          {!loading && discussions.length === 0 && <div class="discussions-empty">No discussions yet</div>}
          {discussions.map((d) => {
            const isActive = d.state === 'running' || d.state === 'setup' || d.state === 'verdict';
            return (
              <div
                key={d.id}
                class={`discussions-list-item${selected === d.id ? ' active' : ''}${isActive ? ' live' : ''}`}
                onClick={() => void loadDetail(d.id)}
              >
                <div class="discussions-list-topic">{d.topic || 'Untitled'}</div>
                <div class="discussions-list-meta">
                  <span class="discussions-list-state" style={{ color: stateColor(d.state) }}>
                    {isActive && <span class="discussions-pulse" />}
                    {stateLabel(d.state)}
                  </span>
                  {d.current_round > 0 && d.state === 'running' && (
                    <span> — Round {d.current_round}/{d.max_rounds}</span>
                  )}
                  <span class="discussions-list-time">{formatTime(d.started_at)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Detail */}
        <div class="discussions-detail">
          {!selectedDiscussion && (
            <div class="discussions-empty">Select a discussion to view details</div>
          )}
          {selectedDiscussion && (
            <>
              <div class="discussions-detail-header">
                <h3>{selectedDiscussion.topic}</h3>
                <div class="discussions-detail-meta">
                  <span style={{ color: stateColor(selectedDiscussion.state) }}>
                    {stateLabel(selectedDiscussion.state)}
                  </span>
                  {selectedDiscussion.current_speaker && selectedDiscussion.state === 'running' && (
                    <span> — <strong>{selectedDiscussion.current_speaker}</strong> speaking...</span>
                  )}
                  <span> — {formatTime(selectedDiscussion.started_at)}</span>
                  {selectedDiscussion.participants && (
                    <span class="discussions-detail-participants">
                      {(JSON.parse(selectedDiscussion.participants) as Array<{ roleLabel: string; agentType: string; model?: string }>).map((p) => (
                        <span key={p.roleLabel} class="discussions-participant-tag">
                          {p.roleLabel} ({p.agentType}{p.model ? `/${p.model}` : ''})
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                {(selectedDiscussion.state === 'running' || selectedDiscussion.state === 'setup' || selectedDiscussion.state === 'verdict') && (
                  <div class="discussions-progress-bar">
                    <div
                      class="discussions-progress-fill"
                      style={{ width: `${selectedDiscussion.max_rounds > 0 ? Math.round((selectedDiscussion.current_round / selectedDiscussion.max_rounds) * 100) : 0}%` }}
                    />
                  </div>
                )}
              </div>

              <div class="discussions-rounds">
                {rounds.length === 0 && selectedDiscussion.state !== 'done' && (
                  <div class="discussions-empty">
                    {selectedDiscussion.state === 'setup' ? 'Setting up agents...' : 'Waiting for responses...'}
                  </div>
                )}
                {rounds.map((r) => (
                  <div key={r.id} class="discussions-round">
                    <div class="discussions-round-header">
                      <strong>{r.speaker_role}</strong>
                      {r.speaker_agent && <span class="discussions-round-agent">{r.speaker_agent}{r.speaker_model ? `/${r.speaker_model}` : ''}</span>}
                      <span class="discussions-round-num">Round {r.round}</span>
                    </div>
                    <div class="discussions-round-body">{r.response}</div>
                  </div>
                ))}
              </div>

              {selectedDiscussion.conclusion && (
                <div class="discussions-conclusion">
                  <div class="discussions-conclusion-label">Verdict</div>
                  <div class="discussions-conclusion-text">{selectedDiscussion.conclusion}</div>
                </div>
              )}

              {selectedDiscussion.file_content && (
                <details class="discussions-file-content">
                  <summary>Full Document</summary>
                  <pre>{selectedDiscussion.file_content}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
