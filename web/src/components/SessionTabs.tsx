import { useState, useRef, useEffect, useMemo, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '../types.js';
import { useSyncedPreference } from '../hooks/useSyncedPreference.js';
import { formatLabel } from '../format-label.js';
import { getAgentBadgeConfig } from '../agent-display.js';
import { SessionActionMenuIcon } from './SessionActionMenuIcon.js';

interface Props {
  sessions: SessionInfo[];
  activeSession: string | null;
  connected?: boolean;
  latencyMs?: number | null;
  /** Set of session names that just went idle — shows pulse alert on that tab */
  idleAlerts?: Set<string>;
  /** Set of sub-session labels participating in active P2P discussions. */
  p2pSessionLabels?: Set<string>;
  onAlertDismiss?: (sessionName: string) => void;
  onSelect: (name: string) => void;
  onNewSession: () => void;
  onStopProject: (project: string) => void;
  onRestartProject: (project: string, fresh?: boolean) => void;
  onCloneSession?: (session: SessionInfo) => void;
  onOpenSessionSettings?: (session: SessionInfo) => void;
  /** When set to a session name, triggers inline rename */
  renameRequest?: string | null;
  onRenameHandled?: () => void;
  /** Called when user commits a rename — updates session label in D1 */
  onRenameSession?: (sessionName: string, nextLabel: string | null) => void;
  /** True once sessions have been loaded (from API or WS) */
  sessionsLoaded?: boolean;
  /** Pinned session names (lifted to app.tsx so Stop guards can read it) */
  pinned: Set<string>;
  /** Setter for the pinned array (server-synced via useSyncedPreference) */
  setPinnedArr: (value: string[] | ((prev: string[]) => string[])) => void;
}

interface CtxMenu { x: number; y: number; session: SessionInfo }

/** Legacy localStorage key — read once on first load for migration. */
const LEGACY_LS_ORDER = 'rcc_tab_order';
const TAB_LONG_PRESS_MS = 520;
const TAB_LONG_PRESS_MOVE_CANCEL_PX = 10;
const TAB_MOUSE_CLICK_MOVE_CANCEL_PX = 6;

interface LongPressState {
  timer: number;
  pointerId: number;
  startX: number;
  startY: number;
}

interface TouchPressState {
  sessionName: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  longPressTriggered: boolean;
}

interface MousePressState {
  sessionName: string;
  startX: number;
  startY: number;
}

function readLegacyOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(LEGACY_LS_ORDER) ?? '[]'); } catch { return []; }
}

export function SessionTabs({ sessions, activeSession, connected, latencyMs, idleAlerts, p2pSessionLabels, onAlertDismiss, onSelect, onNewSession, onStopProject, onRestartProject, onCloneSession, onOpenSessionSettings, renameRequest, onRenameHandled, onRenameSession, sessionsLoaded, pinned, setPinnedArr }: Props) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [stopConfirmProject, setStopConfirmProject] = useState<string | null>(null);
  const [stopConfirmLevel, setStopConfirmLevel] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<LongPressState | null>(null);
  const touchPressRef = useRef<TouchPressState | null>(null);
  const mousePressRef = useRef<MousePressState | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextClickResetRef = useRef<number | null>(null);

  // Persisted order via server-synced preferences. (Pinned state is lifted to
  // app.tsx so handleStopProject can guard against stopping pinned sessions.)
  // Default to legacy localStorage value so existing users don't lose their arrangement.
  const [tabOrder, setTabOrder] = useSyncedPreference<string[]>(
    'tab_order',
    readLegacyOrder(),
    500,
  );

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Merge sessions with persisted order: keep known positions, prune destroyed,
  // append unknown sessions to the end.
  const orderedSessions = useMemo(() => {
    const nameSet = new Set(sessions.map((s) => s.name));
    // Remove stale entries from order (destroyed sessions).
    const validOrder = tabOrder.filter((n) => nameSet.has(n));
    // Find new sessions not yet in order — append to end.
    const newNames = sessions.filter((s) => !validOrder.includes(s.name)).map((s) => s.name);
    const fullOrder = [...validOrder, ...newNames];

    const byName = new Map(sessions.map((s) => [s.name, s]));
    const ordered = fullOrder.map((n) => byName.get(n)).filter(Boolean) as SessionInfo[];

    // Pinned first, then unpinned — stable within each group.
    const pinnedArr = ordered.filter((s) => pinned.has(s.name));
    const unpinnedArr = ordered.filter((s) => !pinned.has(s.name));
    return [...pinnedArr, ...unpinnedArr];
  }, [sessions, tabOrder, pinned]);

  // Sync back: when orderedSessions changes (e.g. new session arrives), update
  // the persisted order so the next render is stable.
  useEffect(() => {
    const newOrder = orderedSessions.map((s) => s.name);
    if (JSON.stringify(newOrder) !== JSON.stringify(tabOrder)) {
      setTabOrder(newOrder);
    }
  // We intentionally omit tabOrder from deps to avoid a render loop — the
  // comparison inside guards against infinite updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedSessions]);

  useEffect(() => {
    if (!ctx) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctx]);

  useEffect(() => {
    if (renaming) setTimeout(() => renameRef.current?.select(), 0);
  }, [renaming]);

  const clearLongPress = useCallback(() => {
    const state = longPressRef.current;
    if (!state) return;
    window.clearTimeout(state.timer);
    longPressRef.current = null;
  }, []);

  const suppressNextSyntheticClick = useCallback((resetAfterMs = 800) => {
    suppressNextClickRef.current = true;
    if (suppressNextClickResetRef.current !== null) {
      window.clearTimeout(suppressNextClickResetRef.current);
    }
    suppressNextClickResetRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = false;
      suppressNextClickResetRef.current = null;
    }, resetAfterMs);
  }, []);

  useEffect(() => () => {
    clearLongPress();
    touchPressRef.current = null;
    mousePressRef.current = null;
    if (suppressNextClickResetRef.current !== null) {
      window.clearTimeout(suppressNextClickResetRef.current);
      suppressNextClickResetRef.current = null;
    }
  }, [clearLongPress]);

  useEffect(() => {
    if (!activeSession) return;
    const frame = requestAnimationFrame(() => {
      const tabBar = tabBarRef.current;
      const activeTab = tabBar?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (!tabBar || !activeTab) return;
      // User report (image: ce683be95d350b6cda6852eae74bb320.png — "怎么往左偏这么多!"):
      // Element.scrollIntoView() walks the entire ancestor scroll chain and
      // scrolls EVERY scrollable ancestor — which on mobile included
      // `.chat-main` / the document, dragging the whole chat layout left.
      // Roll our own: only mutate this tab-bar's scrollLeft, never anything
      // outside it.
      const tabRect = activeTab.getBoundingClientRect();
      const barRect = tabBar.getBoundingClientRect();
      const desiredCenter = tabBar.scrollLeft + (tabRect.left - barRect.left)
        - (barRect.width / 2 - tabRect.width / 2);
      const maxScroll = Math.max(0, tabBar.scrollWidth - tabBar.clientWidth);
      const target = Math.max(0, Math.min(desiredCenter, maxScroll));
      if (Math.abs(target - tabBar.scrollLeft) > 0.5) {
        tabBar.scrollLeft = target;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSession, orderedSessions]);

  // External rename trigger (from ⋯ menu in SessionControls)
  useEffect(() => {
    if (!renameRequest) return;
    const session = sessions.find((s) => s.name === renameRequest);
    if (session) startRename(session);
    onRenameHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);

  const getLabel = (s: SessionInfo) => {
    if (s.label) return formatLabel(s.label);
    return s.role === 'brain' ? s.project : `W${s.name.split('_w')[1] ?? '?'}`;
  };

  const agentBadge = (agentType: string) => {
    const badge = getAgentBadgeConfig(agentType);
    if (!badge) return null;
    return <span class="agent-badge" style={{ background: badge.color }}>{badge.label}</span>;
  };

  const openCtxAt = useCallback((x: number, y: number, session: SessionInfo) => {
    setCtx({ x, y, session });
  }, []);

  const openCtx = useCallback((e: MouseEvent, session: SessionInfo) => {
    e.preventDefault();
    openCtxAt(e.clientX, e.clientY, session);
  }, [openCtxAt]);

  const selectTab = useCallback((name: string) => {
    onSelect(name);
    if (idleAlerts?.has(name)) onAlertDismiss?.(name);
  }, [idleAlerts, onAlertDismiss, onSelect]);

  const onTabPointerDown = useCallback((e: PointerEvent, session: SessionInfo) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (e.pointerType === 'mouse') return;
    clearLongPress();

    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    try { target.setPointerCapture?.(pointerId); } catch { /* best-effort on older WebViews */ }

    touchPressRef.current = {
      sessionName: session.name,
      pointerId,
      startX,
      startY,
      moved: false,
      longPressTriggered: false,
    };
    longPressRef.current = {
      pointerId,
      startX,
      startY,
      timer: window.setTimeout(() => {
        if (touchPressRef.current?.pointerId === pointerId) {
          touchPressRef.current.longPressTriggered = true;
        }
        longPressRef.current = null;
        suppressNextSyntheticClick();
        try { target.releasePointerCapture?.(pointerId); } catch { /* best-effort on older WebViews */ }
        openCtxAt(startX, startY, session);
      }, TAB_LONG_PRESS_MS),
    };
  }, [clearLongPress, openCtxAt, suppressNextSyntheticClick]);

  const onTabPointerMove = useCallback((e: PointerEvent) => {
    const touchState = touchPressRef.current;
    if (touchState && touchState.pointerId === e.pointerId) {
      const dx = e.clientX - touchState.startX;
      const dy = e.clientY - touchState.startY;
      if (Math.hypot(dx, dy) > TAB_LONG_PRESS_MOVE_CANCEL_PX) touchState.moved = true;
    }
    const state = longPressRef.current;
    if (state && state.pointerId === e.pointerId) {
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (Math.hypot(dx, dy) > TAB_LONG_PRESS_MOVE_CANCEL_PX) clearLongPress();
    }
  }, [clearLongPress]);

  const onTabPointerUp = useCallback((e: PointerEvent) => {
    const state = longPressRef.current;
    if (state && state.pointerId === e.pointerId) clearLongPress();
    const touchState = touchPressRef.current;
    if (!touchState || touchState.pointerId !== e.pointerId) return;
    touchPressRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* best-effort on older WebViews */ }

    const dx = e.clientX - touchState.startX;
    const dy = e.clientY - touchState.startY;
    const movedOnRelease = Math.hypot(dx, dy) > TAB_LONG_PRESS_MOVE_CANCEL_PX;
    if (touchState.moved || movedOnRelease || touchState.longPressTriggered) return;

    suppressNextSyntheticClick(180);
    selectTab(touchState.sessionName);
  }, [clearLongPress, selectTab, suppressNextSyntheticClick]);

  const onTabPointerCancel = useCallback((e: PointerEvent) => {
    const state = longPressRef.current;
    if (state && state.pointerId === e.pointerId) clearLongPress();
    const touchState = touchPressRef.current;
    if (touchState?.pointerId === e.pointerId) touchPressRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* best-effort on older WebViews */ }
  }, [clearLongPress]);

  const onTabMouseDown = useCallback((e: MouseEvent, session: SessionInfo) => {
    if (e.button !== 0) return;
    mousePressRef.current = {
      sessionName: session.name,
      startX: e.clientX,
      startY: e.clientY,
    };
  }, []);

  const onTabMouseMove = useCallback((e: MouseEvent) => {
    const mouseState = mousePressRef.current;
    if (!mouseState) return;
    const dx = e.clientX - mouseState.startX;
    const dy = e.clientY - mouseState.startY;
    if (Math.hypot(dx, dy) > TAB_MOUSE_CLICK_MOVE_CANCEL_PX) {
      mousePressRef.current = null;
    }
  }, []);

  const onTabMouseEnd = useCallback((e: MouseEvent) => {
    const mouseState = mousePressRef.current;
    if (!mouseState) return;
    mousePressRef.current = null;
    if (suppressNextClickRef.current) return;
    const dx = e.clientX - mouseState.startX;
    const dy = e.clientY - mouseState.startY;
    if (Math.hypot(dx, dy) > TAB_MOUSE_CLICK_MOVE_CANCEL_PX) return;
    suppressNextSyntheticClick(180);
    selectTab(mouseState.sessionName);
  }, [selectTab, suppressNextSyntheticClick]);

  const startRename = (s: SessionInfo) => {
    setCtx(null);
    setRenameVal(s.label ?? '');
    setRenaming(s.name);
  };

  const commitRename = () => {
    if (!renaming) return;
    const trimmed = (renameRef.current?.value ?? renameVal).trim();
    onRenameSession?.(renaming, trimmed || null);
    setRenaming(null);
  };

  const togglePin = useCallback((name: string) => {
    setPinnedArr((prev) => {
      const set = new Set(prev);
      if (set.has(name)) set.delete(name); else set.add(name);
      return [...set];
    });
    setCtx(null);
  }, [setPinnedArr]);

  // Drag handlers — reorder only within the same group (pinned or unpinned).
  const onDragStart = useCallback((e: DragEvent, idx: number) => {
    mousePressRef.current = null;
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
    const fromIdx = dragIdx.current;
    if (fromIdx === null) return;
    // Only allow drag within the same group.
    const fromPinned = pinned.has(orderedSessions[fromIdx]?.name ?? '');
    const toPinned = pinned.has(orderedSessions[idx]?.name ?? '');
    if (fromPinned !== toPinned) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, [pinned, orderedSessions]);

  const onDrop = useCallback((e: DragEvent, dropIdx: number) => {
    e.preventDefault();
    const fromIdx = dragIdx.current;
    if (fromIdx === null || fromIdx === dropIdx) { setDragOverIdx(null); return; }

    // Enforce same-group constraint.
    const fromPinned = pinned.has(orderedSessions[fromIdx]?.name ?? '');
    const toPinned = pinned.has(orderedSessions[dropIdx]?.name ?? '');
    if (fromPinned !== toPinned) { setDragOverIdx(null); return; }

    const names = orderedSessions.map((s) => s.name);
    const [moved] = names.splice(fromIdx, 1);
    names.splice(dropIdx, 0, moved);
    setTabOrder(names);
    setDragOverIdx(null);
    dragIdx.current = null;
  }, [orderedSessions, pinned, setTabOrder]);

  const menuX = ctx ? Math.min(ctx.x, window.innerWidth - 160) : 0;
  const menuY = ctx ? Math.min(ctx.y, window.innerHeight - 260) : 0;

  return (
    <div ref={tabBarRef} class="tab-bar" role="tablist">
      {sessions.length === 0 && sessionsLoaded && (
        <span class="tab-empty">No active sessions</span>
      )}

      {orderedSessions.map((s, idx) => {
        const isActive = s.name === activeSession;
        const isBrain = s.role === 'brain';
        const isPinned = pinned.has(s.name);
        const hasAlert = idleAlerts?.has(s.name) ?? false;
        const stateClass = s.state === 'running' || s.state === 'queued' ? 'busy' : s.state === 'idle' ? 'idle' : '';
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
                autoFocus
                value={renameVal}
                onInput={(e) => setRenameVal((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlurCapture={commitRename}
                onBlur={commitRename}
                onFocusOut={commitRename}
              />
            ) : (
              <button
                class={classes}
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (suppressNextClickRef.current) {
                    suppressNextClickRef.current = false;
                    if (suppressNextClickResetRef.current !== null) {
                      window.clearTimeout(suppressNextClickResetRef.current);
                      suppressNextClickResetRef.current = null;
                    }
                    return;
                  }
                  selectTab(s.name);
                }}
                onContextMenu={(e) => openCtx(e, s)}
                onPointerDown={(e) => onTabPointerDown(e as PointerEvent, s)}
                onPointerMove={(e) => onTabPointerMove(e as PointerEvent)}
                onPointerUp={(e) => onTabPointerUp(e as PointerEvent)}
                onPointerCancel={(e) => onTabPointerCancel(e as PointerEvent)}
                onPointerLeave={(e) => onTabPointerCancel(e as PointerEvent)}
                onMouseDown={(e) => onTabMouseDown(e as MouseEvent, s)}
                onMouseMove={(e) => onTabMouseMove(e as MouseEvent)}
                onMouseUp={(e) => onTabMouseEnd(e as MouseEvent)}
                onMouseLeave={(e) => onTabMouseEnd(e as MouseEvent)}
                title={`${s.agentType}${s.agentVersion ? ` ${s.agentVersion}` : ''} — ${s.state}${isPinned ? ' (pinned)' : ''}`}
              >
                {isPinned && <span class="tab-pin">📌</span>}
                {agentBadge(s.agentType)}
                {getLabel(s)}
                {p2pSessionLabels?.has(s.name) && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
                {/* tool call indicator removed — too flashy */}
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

      <button class="tab-add-btn" onClick={onNewSession} title={t('session.new_btn', 'New session')}>＋</button>

      {ctx && (() => {
        // Pinned tabs can't be stopped — user must unpin first. Check both the
        // right-clicked session and any sibling sessions of the same project,
        // since `Stop` terminates the whole project (all its tmux processes).
        const projectHasPinned = sessions.some((s) => s.project === ctx.session.project && pinned.has(s.name));
        const canCloneSession = ctx.session.role === 'brain'
          && !ctx.session.name.startsWith('deck_sub_')
          && ctx.session.userCreated !== false;
        return (
        <div ref={menuRef} class="tab-context-menu" style={{ left: menuX, top: menuY }}>
          <button class="menu-item session-action-menu-item" onClick={() => togglePin(ctx.session.name)}>
            <SessionActionMenuIcon kind={pinned.has(ctx.session.name) ? 'unpin' : 'pin'} />
            <span class="session-action-menu-label">{pinned.has(ctx.session.name) ? t('session.unpin_plain', 'Unpin') : t('session.pin_plain', 'Pin')}</span>
          </button>
          <div class="menu-divider" />
          <button class="menu-item session-action-menu-item" onClick={() => { onRestartProject(ctx.session.project); setCtx(null); }}>
            <SessionActionMenuIcon kind="restart" />
            <span class="session-action-menu-label">{t('session.restart_plain', 'Restart')}</span>
          </button>
          <button class="menu-item session-action-menu-item" onClick={() => { onRestartProject(ctx.session.project, true); setCtx(null); }}>
            <SessionActionMenuIcon kind="new" />
            <span class="session-action-menu-label">{t('session.start_fresh', 'Start fresh')}</span>
          </button>
          <button class="menu-item session-action-menu-item" onClick={() => startRename(ctx.session)}>
            <SessionActionMenuIcon kind="rename" />
            <span class="session-action-menu-label">{t('session.rename_plain', 'Rename')}</span>
          </button>
          {onOpenSessionSettings && (
            <button class="menu-item session-action-menu-item" onClick={() => { onOpenSessionSettings(ctx.session); setCtx(null); }}>
              <SessionActionMenuIcon kind="settings" />
              <span class="session-action-menu-label">{t('session.settings', 'Settings')}</span>
            </button>
          )}
          {onCloneSession && canCloneSession && (
            <button class="menu-item session-action-menu-item" onClick={() => { onCloneSession(ctx.session); setCtx(null); }}>
              <SessionActionMenuIcon kind="clone" />
              <span class="session-action-menu-label">{t('session.clone.menu', 'Copy session')}</span>
            </button>
          )}
          <div class="menu-divider" />
          <button
            class="menu-item session-action-menu-item menu-item-danger"
            disabled={projectHasPinned}
            title={projectHasPinned ? t('session.unpin_to_stop') : undefined}
            onClick={() => {
              if (projectHasPinned) return;
              setStopConfirmProject(ctx.session.project);
              setStopConfirmLevel(0);
              setCtx(null);
            }}
          >
            <SessionActionMenuIcon kind={projectHasPinned ? 'unpin' : 'stop'} />
            <span class="session-action-menu-label">{projectHasPinned ? t('session.unpin_to_stop') : t('session.stop_plain', 'Stop')}</span>
          </button>
        </div>
        );
      })()}
      {stopConfirmProject && (
        <div class="ask-dialog-overlay" onClick={() => { setStopConfirmProject(null); setStopConfirmLevel(0); }}>
          <div class="ask-dialog stop-session-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="stop-session-dialog-icon">⚠</div>
            <div class="stop-session-dialog-title">{t('session.stop_main_title', 'Stop main session?')}</div>
            <div class="stop-session-dialog-body">
              {t(
                'session.stop_main_body',
                '{{project}} is a main session. Stopping it will terminate all its tmux processes. This cannot be undone.',
                { project: stopConfirmProject },
              )}
            </div>
            <div class="ask-actions">
              <button class="ask-btn-cancel" onClick={() => { setStopConfirmProject(null); setStopConfirmLevel(0); }}>{t('common.cancel', 'Cancel')}</button>
              <button
                class={`ask-btn-submit stop-session-confirm-btn${stopConfirmLevel >= 1 ? ' menu-item-danger' : ''}`}
                onClick={() => {
                  if (stopConfirmLevel < 2) {
                    setStopConfirmLevel((n) => n + 1);
                    return;
                  }
                  onStopProject(stopConfirmProject);
                  setStopConfirmProject(null);
                  setStopConfirmLevel(0);
                }}
              >
                {stopConfirmLevel >= 2 ? t('session.really_stop_project', '⚠ REALLY stop {{project}}?', { project: stopConfirmProject })
                  : stopConfirmLevel === 1 ? t('session.confirm_stop', 'Confirm stop?')
                  : t('session.stop_session', 'Stop session')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
