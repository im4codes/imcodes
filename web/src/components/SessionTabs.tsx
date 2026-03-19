import { useState, useRef, useEffect, useMemo, useCallback } from 'preact/hooks';
import type { SessionInfo } from '../types.js';

interface Props {
  sessions: SessionInfo[];
  activeSession: string | null;
  connected?: boolean;
  latencyMs?: number | null;
  /** Set of session names that just went idle — shows pulse alert on that tab */
  idleAlerts?: Set<string>;
  onAlertDismiss?: (sessionName: string) => void;
  /** Map of session name → currently running tool name */
  activeTools?: Map<string, string>;
  onSelect: (name: string) => void;
  onNewSession: () => void;
  onStopProject: (project: string) => void;
  onRestartProject: (project: string, fresh?: boolean) => void;
  /** When set to a session name, triggers inline rename */
  renameRequest?: string | null;
  onRenameHandled?: () => void;
  /** Called when user commits a rename — updates project_name in D1 */
  onRenameSession?: (sessionName: string, newProjectName: string) => void;
  /** True once sessions have been loaded (from API or WS) */
  sessionsLoaded?: boolean;
}

interface CtxMenu { x: number; y: number; session: SessionInfo }

const AGENT_BADGE: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'cc', color: '#7c3aed' },
  'codex':       { label: 'cx', color: '#d97706' },
  'opencode':    { label: 'oc', color: '#059669' },
};

const LS_ORDER = 'rcc_tab_order';
const LS_PINNED = 'rcc_tab_pinned';

function loadOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_ORDER) ?? '[]'); } catch { return []; }
}
function saveOrder(order: string[]) {
  localStorage.setItem(LS_ORDER, JSON.stringify(order));
}
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_PINNED) ?? '[]')); } catch { return new Set(); }
}
function savePinned(pinned: Set<string>) {
  localStorage.setItem(LS_PINNED, JSON.stringify([...pinned]));
}

export function SessionTabs({ sessions, activeSession, connected, latencyMs, idleAlerts, onAlertDismiss, activeTools, onSelect, onNewSession, onStopProject, onRestartProject, renameRequest, onRenameHandled, onRenameSession, sessionsLoaded }: Props) {
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [stopConfirmProject, setStopConfirmProject] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Persisted order & pinned state
  const [tabOrder, setTabOrder] = useState<string[]>(loadOrder);
  const [pinned, setPinned] = useState<Set<string>>(loadPinned);

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Merge sessions with persisted order: keep known positions, append new ones
  const orderedSessions = useMemo(() => {
    const nameSet = new Set(sessions.map((s) => s.name));
    // Remove stale entries from order
    const validOrder = tabOrder.filter((n) => nameSet.has(n));
    // Find new sessions not in order
    const newNames = sessions.filter((s) => !validOrder.includes(s.name)).map((s) => s.name);
    const fullOrder = [...validOrder, ...newNames];

    const byName = new Map(sessions.map((s) => [s.name, s]));
    const ordered = fullOrder.map((n) => byName.get(n)).filter(Boolean) as SessionInfo[];

    // Pinned first, then unpinned — stable within each group
    const pinnedArr = ordered.filter((s) => pinned.has(s.name));
    const unpinnedArr = ordered.filter((s) => !pinned.has(s.name));
    return [...pinnedArr, ...unpinnedArr];
  }, [sessions, tabOrder, pinned]);

  // Persist order when it changes
  useEffect(() => {
    const newOrder = orderedSessions.map((s) => s.name);
    if (JSON.stringify(newOrder) !== JSON.stringify(tabOrder)) {
      setTabOrder(newOrder);
      saveOrder(newOrder);
    }
  }, [orderedSessions]);

  useEffect(() => {
    if (!ctx) { setStopConfirmProject(null); return; }
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctx]);

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.select(), 0);
  }, [renaming]);

  // External rename trigger (from ⋯ menu in SessionControls)
  useEffect(() => {
    if (!renameRequest) return;
    const session = sessions.find((s) => s.name === renameRequest);
    if (session) startRename(session);
    onRenameHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);

  const getLabel = (s: SessionInfo) =>
    s.role === 'brain' ? `🧠 ${s.project}` : `W${s.name.split('_w')[1] ?? '?'}`;

  const agentBadge = (agentType: string) => {
    const b = AGENT_BADGE[agentType];
    if (!b) return null;
    return <span class="agent-badge" style={{ background: b.color }}>{b.label}</span>;
  };

  const openCtx = (e: MouseEvent, session: SessionInfo) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, session });
  };

  const startRename = (s: SessionInfo) => {
    setCtx(null);
    setRenameVal(s.project);
    setRenaming(s.name);
  };

  const commitRename = () => {
    if (!renaming) return;
    const trimmed = renameVal.trim();
    if (trimmed) onRenameSession?.(renaming, trimmed);
    setRenaming(null);
  };

  const togglePin = useCallback((name: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      savePinned(next);
      return next;
    });
    setCtx(null);
  }, []);

  // Drag handlers
  const onDragStart = useCallback((e: DragEvent, idx: number) => {
    dragIdx.current = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
    (e.currentTarget as HTMLElement).classList.add('tab-dragging');
  }, []);

  const onDragEnd = useCallback((e: DragEvent) => {
    dragIdx.current = null;
    setDragOverIdx(null);
    (e.currentTarget as HTMLElement).classList.remove('tab-dragging');
  }, []);

  const onDragOver = useCallback((e: DragEvent, idx: number) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const onDrop = useCallback((e: DragEvent, dropIdx: number) => {
    e.preventDefault();
    const fromIdx = dragIdx.current;
    if (fromIdx === null || fromIdx === dropIdx) { setDragOverIdx(null); return; }

    const names = orderedSessions.map((s) => s.name);
    const [moved] = names.splice(fromIdx, 1);
    names.splice(dropIdx, 0, moved);
    setTabOrder(names);
    saveOrder(names);
    setDragOverIdx(null);
    dragIdx.current = null;
  }, [orderedSessions]);

  const menuX = ctx ? Math.min(ctx.x, window.innerWidth - 160) : 0;
  const menuY = ctx ? Math.min(ctx.y, window.innerHeight - 200) : 0;

  return (
    <div class="tab-bar" role="tablist">
      {sessions.length === 0 && sessionsLoaded && (
        <span class="tab-empty">No active sessions</span>
      )}

      {orderedSessions.map((s, idx) => {
        const isActive = s.name === activeSession;
        const isBrain = s.role === 'brain';
        const isPinned = pinned.has(s.name);
        const hasAlert = idleAlerts?.has(s.name) ?? false;
        const activeTool = activeTools?.get(s.name) ?? null;
        const stateClass = s.state === 'running' ? 'busy' : s.state === 'idle' ? 'idle' : '';
        const classes = ['tab', isBrain ? 'brain' : '', isActive ? 'active' : '', stateClass, hasAlert ? 'alert' : '', isPinned ? 'pinned' : ''].filter(Boolean).join(' ');
        const isDragOver = dragOverIdx === idx;

        // WS latency shown inline on the active tab
        const latencyColor = latencyMs == null ? '#4ade80' : latencyMs < 150 ? '#4ade80' : latencyMs < 400 ? '#f59e0b' : '#ef4444';

        return (
          <div
            key={s.name}
            class={`tab-wrap${isDragOver ? ' tab-drop-target' : ''}`}
            draggable
            onDragStart={(e) => onDragStart(e as DragEvent, idx)}
            onDragEnd={(e) => onDragEnd(e as DragEvent)}
            onDragOver={(e) => onDragOver(e as DragEvent, idx)}
            onDrop={(e) => onDrop(e as DragEvent, idx)}
          >
            {renaming === s.name ? (
              <input
                ref={renameRef}
                class="tab-rename-input"
                value={renameVal}
                onInput={(e) => setRenameVal((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                class={classes}
                role="tab"
                aria-selected={isActive}
                onClick={() => { onSelect(s.name); if (hasAlert) onAlertDismiss?.(s.name); }}
                onContextMenu={(e) => openCtx(e, s)}
                title={`${s.agentType}${s.agentVersion ? ` ${s.agentVersion}` : ''} — ${s.state}${isPinned ? ' (pinned)' : ''}`}
              >
                {isPinned && <span class="tab-pin">📌</span>}
                {agentBadge(s.agentType)}
                {getLabel(s)}
                {activeTool && (
                  <span class="tab-tool" title={`Running: ${activeTool}`}>⚙ {activeTool}</span>
                )}
                {isActive && (
                  <span class="tab-ws-dot" style={{ color: connected ? latencyColor : '#ef4444' }} title={connected ? (latencyMs != null ? `${latencyMs}ms` : 'Connected') : 'Disconnected'}>
                    ●{connected && latencyMs != null && <span class="tab-latency">{latencyMs}ms</span>}
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })}

      <button class="tab-add-btn" onClick={onNewSession} title="New session">＋</button>

      {ctx && (
        <div ref={menuRef} class="tab-context-menu" style={{ left: menuX, top: menuY }}>
          <button class="menu-item" onClick={() => togglePin(ctx.session.name)}>
            {pinned.has(ctx.session.name) ? '📌 Unpin' : '📌 Pin'}
          </button>
          <div class="menu-divider" />
          <button class="menu-item" onClick={() => { onRestartProject(ctx.session.project); setCtx(null); }}>↺ Restart</button>
          <button class="menu-item" onClick={() => { onRestartProject(ctx.session.project, true); setCtx(null); }}>＋ New</button>
          <button class="menu-item" onClick={() => startRename(ctx.session)}>✎ Rename</button>
          <div class="menu-divider" />
          <button class="menu-item menu-item-danger" onClick={() => { setStopConfirmProject(ctx.session.project); setCtx(null); }}>✕ Stop</button>
        </div>
      )}
      {stopConfirmProject && (
        <div class="ask-dialog-overlay" onClick={() => setStopConfirmProject(null)}>
          <div class="ask-dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="stop-session-dialog-icon">⚠</div>
            <div class="stop-session-dialog-title">Stop main session?</div>
            <div class="stop-session-dialog-body">
              <strong>{stopConfirmProject}</strong> is a main session. Stopping it will terminate all its tmux processes. This cannot be undone.
            </div>
            <div class="ask-actions">
              <button class="ask-btn-cancel" onClick={() => setStopConfirmProject(null)}>Cancel</button>
              <button class="ask-btn-submit stop-session-confirm-btn" onClick={() => { onStopProject(stopConfirmProject); setStopConfirmProject(null); }}>Stop session</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
