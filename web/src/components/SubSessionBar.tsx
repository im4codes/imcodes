/**
 * SubSessionBar — bottom panel showing sub-session preview cards.
 * Cards show live chat/terminal previews. Single or double row layout.
 */
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { SubSessionCard } from './SubSessionCard.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import { isVisuallyBusy } from '../thinking-utils.js';
import { reorderSubSessions } from '../api.js';
import { formatLabel } from '../format-label.js';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';

interface DaemonStats {
  daemonVersion?: string | null;
  cpu: number;
  memUsed: number;
  memTotal: number;
  load1: number;
  load5: number;
  load15: number;
  uptime: number;
}

interface P2pNode {
  label: string;
  agentType: string;
  status: 'done' | 'active' | 'pending' | 'skipped';
}

interface DiscussionSummary {
  id: string;
  topic: string;
  state: string;
  currentRound: number;
  maxRounds: number;
  currentSpeaker?: string;
  conclusion?: string;
  filePath?: string;
  fileId?: string;
  nodes?: P2pNode[];
}

interface Props {
  subSessions: SubSession[];
  openIds: Set<string>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onViewDiscussions?: () => void;
  onViewDiscussion?: (fileId: string) => void;
  onViewRepo?: () => void;
  onViewCron?: () => void;

  discussions?: DiscussionSummary[];
  onStopDiscussion?: (id: string) => void;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  serverId?: string;
  /** Per-sub-session usage data (ctx tokens, model) collected from timeline events. */
  subUsages?: Map<string, { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string }>;
  /** ID of the currently focused (topmost) sub-session window. */
  focusedSubId?: string | null;
}

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const TYPE_ABBR: Record<string, string> = {
  'claude-code': 'cc',
  'codex': 'cx',
  'opencode': 'oc',
  'openclaw': 'oc',
  'gemini': 'gm',
  'shell': 'sh',
  'script': 'sc',
};

type Layout = 'single' | 'double';

interface CardSize { w: number; h: number }

const DEFAULT_SIZE: CardSize = { w: 350, h: 250 };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v) return JSON.parse(v) as T;
  } catch { /* ignore */ }
  return fallback;
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)}G` : `${(bytes / (1024 ** 2)).toFixed(0)}M`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function SubSessionBar({ subSessions, openIds, onOpen, onNew, onViewDiscussions, onViewDiscussion, onViewRepo, onViewCron, discussions = [], onStopDiscussion, ws, connected, onDiff, onHistory, serverId, subUsages, focusedSubId }: Props) {
  const [layout, setLayout] = useState<Layout>(() => load('rcc_subcard_layout', 'single'));
  const [collapsed, setCollapsed] = useState(isMobile);
  const [showSizePanel, setShowSizePanel] = useState(false);
  const [cardSize, setCardSize] = useState<CardSize>(() => load('rcc_subcard_size', DEFAULT_SIZE));
  const [draftW, setDraftW] = useState(String(cardSize.w));
  const [draftH, setDraftH] = useState(String(cardSize.h));
  const [stats, setStats] = useState<DaemonStats | null>(null);
  const orderKey = serverId ? `rcc_subcard_order_${serverId}` : 'rcc_subcard_order';
  const [orderedIds, setOrderedIds] = useState<string[]>(() => load(orderKey, []));
  const dragIdRef = useRef<string | null>(null);
  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;
  const reorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset orderedIds when server changes
  const prevServerIdRef = useRef(serverId);
  if (prevServerIdRef.current !== serverId) {
    prevServerIdRef.current = serverId;
    const saved = load<string[]>(orderKey, []);
    setOrderedIds(saved);
    orderedIdsRef.current = saved;
  }

  // Debounced server sync for sub-session order
  const syncOrderToServer = (ids: string[]) => {
    // Always save to localStorage as fallback
    save(orderKey, ids);
    // Debounce server sync
    if (reorderTimerRef.current) clearTimeout(reorderTimerRef.current);
    reorderTimerRef.current = setTimeout(() => {
      if (serverId) reorderSubSessions(serverId, ids).catch(() => {});
    }, 500);
  };
  const prevSubIdsRef = useRef<string[]>([]);
  const removedPositionsRef = useRef<Map<string, number>>(new Map());

  // Preserve ordering across restart: track removed session positions, place new sessions there
  useEffect(() => {
    const prevIds = prevSubIdsRef.current;
    const currIds = subSessions.map((s) => s.id);

    // Save positions of sessions that disappeared
    const disappeared = prevIds.filter((id) => !currIds.includes(id));
    for (const id of disappeared) {
      const pos = orderedIdsRef.current.indexOf(id);
      if (pos !== -1) removedPositionsRef.current.set(id, pos);
    }

    // Place newly appeared sessions at saved positions (restart case)
    const appeared = currIds.filter((id) => !prevIds.includes(id));
    if (appeared.length > 0 && removedPositionsRef.current.size > 0) {
      setOrderedIds((prev) => {
        const next = [...prev];
        for (const newId of appeared) {
          const entries = [...removedPositionsRef.current.entries()];
          if (entries.length > 0) {
            const [oldId, pos] = entries[0];
            removedPositionsRef.current.delete(oldId);
            const idx = next.indexOf(oldId);
            if (idx !== -1) {
              next[idx] = newId;
            } else {
              next.splice(Math.min(pos, next.length), 0, newId);
            }
          }
        }
        syncOrderToServer(next);
        return next;
      });
    }

    prevSubIdsRef.current = currIds;
  }, [subSessions]); // orderedIds deliberately omitted to avoid loops

  // Auto-initialize orderedIds from server order when empty or incomplete
  useEffect(() => {
    if (subSessions.length === 0) return;
    const currentIds = subSessions.map((s) => s.id);
    const hasAll = currentIds.every((id) => orderedIdsRef.current.includes(id));
    if (!hasAll) {
      setOrderedIds((prev) => {
        const known = prev.filter((id) => currentIds.includes(id));
        const newOnes = currentIds.filter((id) => !known.includes(id));
        const merged = [...known, ...newOnes];
        syncOrderToServer(merged);
        return merged;
      });
    }
  }, [subSessions]);

  // Merge server order with persisted order: keep known positions, append new sessions at end.
  // Uses Set for O(n) membership checks instead of O(n²) .some()/.includes().
  const orderedSessions = useMemo(() => {
    const sessionMap = new Map(subSessions.map((s) => [s.id, s]));
    const sessionIdSet = new Set(sessionMap.keys());
    const known = orderedIds.filter((id) => sessionIdSet.has(id));
    const knownSet = new Set(known);
    const newOnes = subSessions.filter((s) => !knownSet.has(s.id)).map((s) => s.id);
    return [...known, ...newOnes].map((id) => sessionMap.get(id)!).filter(Boolean);
  }, [subSessions, orderedIds]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      if (msg.type === 'daemon.stats') {
        setStats({ daemonVersion: msg.daemonVersion, cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal, load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime });
      }
    });
  }, [ws]);

  const toggleLayout = () => {
    const next: Layout = layout === 'single' ? 'double' : 'single';
    setLayout(next);
    save('rcc_subcard_layout', next);
  };

  const applySize = () => {
    const w = Math.max(200, Math.min(800, parseInt(draftW) || DEFAULT_SIZE.w));
    const h = Math.max(150, Math.min(600, parseInt(draftH) || DEFAULT_SIZE.h));
    const next = { w, h };
    setCardSize(next);
    save('rcc_subcard_size', next);
    setDraftW(String(w));
    setDraftH(String(h));
    setShowSizePanel(false);
  };

  const resetSize = () => {
    setCardSize(DEFAULT_SIZE);
    save('rcc_subcard_size', DEFAULT_SIZE);
    setDraftW(String(DEFAULT_SIZE.w));
    setDraftH(String(DEFAULT_SIZE.h));
    setShowSizePanel(false);
  };

  return (
    <div class="subcard-bar">
      {/* Toolbar */}
      <div class="subcard-toolbar">
        <button class="subcard-toolbar-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Show' : 'Hide'}>
          {collapsed ? '▲' : '▼'}
        </button>
        {!collapsed && (
          <>
            <button class="subcard-toolbar-btn" onClick={toggleLayout} title={layout === 'single' ? 'Double row' : 'Single row'}>
              {layout === 'single' ? '⊞' : '☰'}
            </button>
            <button
              class={`subcard-toolbar-btn${showSizePanel ? ' subcard-toolbar-btn-active' : ''}`}
              onClick={() => { setShowSizePanel(!showSizePanel); setDraftW(String(cardSize.w)); setDraftH(String(cardSize.h)); }}
              title="Card size"
            >
              ⚙
            </button>
            <span class="subcard-toolbar-label">Subs ({subSessions.length})</span>
            {stats && (
              <span class="daemon-stats-inline" title={`${stats.daemonVersion ? `Daemon ${stats.daemonVersion} | ` : ''}Load: ${stats.load1} / ${stats.load5} / ${stats.load15} | Uptime: ${formatUptime(stats.uptime)}`}>
                {stats.daemonVersion && (
                  <>
                    <span style={{ color: '#94a3b8' }}>v{stats.daemonVersion}</span>
                    <span style={{ color: '#94a3b8' }}> · </span>
                  </>
                )}
                <span style={{ color: stats.cpu > 80 ? '#f87171' : stats.cpu > 50 ? '#fbbf24' : '#4ade80' }}>
                  CPU {stats.cpu}%
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#60a5fa' }}>
                  Mem {formatBytes(stats.memUsed)}/{formatBytes(stats.memTotal)}
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#a78bfa' }}>
                  Load {stats.load1}
                </span>
                <span style={{ color: '#94a3b8' }}> · </span>
                <span style={{ color: '#94a3b8' }}>
                  {formatUptime(stats.uptime)}
                </span>
              </span>
            )}
          </>
        )}
        <button class="subcard-toolbar-add" onClick={onNew} title="New sub-session">+</button>
        {onViewDiscussions && (
          <button class="subcard-toolbar-btn" onClick={onViewDiscussions} title="P2P discussions" style={{ marginLeft: 4, fontSize: 11 }}>
            📋
          </button>
        )}
        {onViewRepo && (
          <button
            class="subcard-toolbar-btn"
            onClick={() => onViewRepo()}
            title="Repository"
            style={{
              marginLeft: 4,
              fontSize: 11,
            }}
          >
            🔀
          </button>
        )}
        {onViewCron && (
          <button class="subcard-toolbar-btn" onClick={onViewCron} title="Scheduled Tasks" style={{ marginLeft: 4, fontSize: 11 }}>
            ⏰
          </button>
        )}
      </div>

      {/* Size settings panel */}
      {!collapsed && showSizePanel && (
        <div class="subcard-size-panel">
          <span class="subcard-size-label">Card size</span>
          <label class="subcard-size-field">
            W
            <input
              type="number"
              class="subcard-size-input"
              value={draftW}
              min={200} max={800}
              onInput={(e) => setDraftW((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <label class="subcard-size-field">
            H
            <input
              type="number"
              class="subcard-size-input"
              value={draftH}
              min={150} max={600}
              onInput={(e) => setDraftH((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && applySize()}
            />
          </label>
          <button class="subcard-toolbar-btn" onClick={applySize}>Apply</button>
          <button class="subcard-toolbar-btn" onClick={resetSize}>Reset</button>
        </div>
      )}

      {/* Empty state: no sub-sessions and expanded */}
      {!collapsed && subSessions.length === 0 && discussions.length === 0 && (
        <div class="subcard-empty-state">
          No sub-sessions — click <strong>+</strong> to add one
        </div>
      )}

      {/* Discussions panel — above sub-session buttons */}
      {discussions.length > 0 && (
        <div class="discussion-panel">
          {discussions.map((d) => {
            const isActive = d.state !== 'done' && d.state !== 'failed';
            const nodes = d.nodes ?? [];
            const doneCount = nodes.filter(n => n.status === 'done').length;
            const totalNodes = nodes.length || d.maxRounds;
            const progressPct = totalNodes > 0 ? Math.round((doneCount / totalNodes) * 100) : 0;

            return (
              <div key={d.id} class={`discussion-card ${d.state}`} style={{ cursor: d.fileId ? 'pointer' : undefined }} onClick={() => { if (d.fileId && onViewDiscussion) onViewDiscussion(d.fileId); }}>
                {/* Segmented progress bar on TOP of card */}
                {nodes.length > 0 && (
                  <div style={{ display: 'flex', gap: 1, height: 3, borderRadius: 2, overflow: 'hidden' }}>
                    {nodes.map((n, i) => (
                      <div key={i} style={{
                        flex: 1,
                        background: n.status === 'done' ? '#22c55e' : n.status === 'active' ? '#3b82f6' : n.status === 'skipped' ? '#ef4444' : '#334155',
                        transition: 'background 0.3s',
                      }} title={`${n.label} (${n.agentType}) — ${n.status}`} />
                    ))}
                  </div>
                )}
                {nodes.length === 0 && isActive && (
                  <div class="discussion-progress-bar" style={{ height: 3, borderRadius: 2 }}>
                    <div class="discussion-progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                )}

                <div class="discussion-card-header" style={{ padding: '6px 10px' }}>
                  <div class="discussion-card-title" style={{ fontSize: 12 }}>⚖️ {d.topic || 'Discussion'}</div>
                  <div class="discussion-card-actions">
                    {isActive && onStopDiscussion && (
                      <button class="btn btn-sm btn-danger" style={{ fontSize: 10, padding: '1px 6px' }} onClick={(e: Event) => { e.stopPropagation(); onStopDiscussion(d.id); }}>Stop</button>
                    )}
                  </div>
                </div>

                {/* Node list — shows each participant with type and status */}
                {nodes.length > 0 && isActive && (
                  <div style={{ padding: '2px 10px 6px', display: 'flex', flexWrap: 'wrap', gap: '3px 8px', fontSize: 10, color: '#94a3b8' }}>
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

                <div class="discussion-card-body" style={{ padding: nodes.length > 0 ? '0 10px 6px' : undefined }}>
                  {d.state === 'done' && (
                    <>
                      <div class="discussion-status done">✓ Complete</div>
                      {d.conclusion && (
                        <div class="discussion-conclusion">{d.conclusion}</div>
                      )}
                    </>
                  )}
                  {d.state === 'failed' && (
                    <div class="discussion-status failed">✕ Failed</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Collapsed: compact buttons (all platforms) */}
      {collapsed && subSessions.length > 0 && (
        <div class="subsession-bar" style={{ borderTop: 'none' }}>
          {orderedSessions.map((sub) => {
            const agentTag = sub.type === 'shell' ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type;
            const label = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;
            const abbr = TYPE_ABBR[sub.type] ?? agentTag.slice(0, 2);
            const isOpen = openIds.has(sub.id);
            const usage = subUsages?.get(`deck_sub_${sub.id}`);
            const model = usage ? shortModelLabel(usage.model) : null;
            // Compute ctx percentage for mini bar
            let ctxPct = 0;
            if (usage) {
              const ctx = resolveContextWindow(usage.contextWindow, usage.model);
              ctxPct = Math.min(100, (usage.inputTokens + usage.cacheTokens) / ctx * 100);
            }
            return (
              <button
                key={sub.id}
                class={`subsession-card${isOpen ? ' open' : ''} mobile${isVisuallyBusy(sub.state, false) ? ' subcard-running-pulse' : ''}`}
                onClick={() => onOpen(sub.id)}
                title={label + (model ? ` · ${model}` : '') + (ctxPct > 0 ? ` · ctx ${ctxPct.toFixed(0)}%` : '')}
              >
                <span class="subsession-card-icon">{abbr}</span>
                <span class="subsession-card-label">{sub.label ? formatLabel(sub.label).slice(0, 12) : agentTag.slice(0, 6)}</span>
                {model && <span class="subsession-card-model">{model}</span>}
                {sub.state === 'starting' && <span class="subsession-card-badge">…</span>}
                {ctxPct > 0 && (
                  <span class="subsession-card-ctx" style={{ width: '100%' }}>
                    <span class="subsession-card-ctx-fill" style={{ width: `${ctxPct}%` }} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Expanded: preview cards (all platforms) */}
      {!collapsed && orderedSessions.length > 0 && (
        <div
          class={`subcard-scroll ${layout === 'double' ? 'subcard-double' : 'subcard-single'}`}
          style={layout === 'double' ? { gridAutoColumns: 'max-content' } : undefined}
        >
          {orderedSessions.map((sub) => (
            <div
              key={sub.id}
              class="subcard-drag-wrap"
              draggable
              onDragStart={(e) => {
                dragIdRef.current = sub.id;
                e.dataTransfer!.effectAllowed = 'move';
                (e.currentTarget as HTMLElement).style.opacity = '0.5';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer!.dropEffect = 'move';
                if (!dragIdRef.current || dragIdRef.current === sub.id) return;
                setOrderedIds((prev) => {
                  // Always build a complete list: persisted order + any new sessions appended
                  const allIds = orderedSessions.map((s) => s.id);
                  const known = prev.filter((id) => allIds.includes(id));
                  const newOnes = allIds.filter((id) => !known.includes(id));
                  const ids = [...known, ...newOnes];
                  const from = ids.indexOf(dragIdRef.current!);
                  const to = ids.indexOf(sub.id);
                  if (from === -1 || to === -1) return prev;
                  const next = [...ids];
                  next.splice(from, 1);
                  next.splice(to, 0, dragIdRef.current!);
                  return next;
                });
              }}
              onDragEnd={(e) => {
                dragIdRef.current = null;
                (e.currentTarget as HTMLElement).style.opacity = '';
                setOrderedIds((current) => {
                  syncOrderToServer(current);
                  return current;
                });
              }}
            >
              <SubSessionCard
                sub={sub}
                ws={ws}
                connected={connected}
                isOpen={openIds.has(sub.id)}
                isFocused={focusedSubId === sub.id}
                onOpen={() => onOpen(sub.id)}
                onDiff={onDiff}
                onHistory={onHistory}
                cardW={cardSize.w}
                cardH={cardSize.h}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
