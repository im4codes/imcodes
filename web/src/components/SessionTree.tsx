/**
 * SessionTree — flat list rendering of main sessions and sub-sessions.
 *
 * Main sessions render at indent 0. Sub-sessions render at indent 1
 * (paddingLeft). Each node shows: agent type badge, label/name, and a state
 * indicator dot (running = green, idle = dim, stopped = red).
 *
 * Transport sessions (runtimeType === 'transport') show a cloud icon instead
 * of the default terminal icon.
 *
 * Task 2.4: Unread badge shown next to session name when count > 0.
 * Task 2.5: Idle flash applied for new realtime session.idle events.
 * Task 2.6: Main click → onSelectSession; sub-session click → onSelectSubSession.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '../types.js';
import { isTransportRuntime } from '../runtime-type.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { isExecutionCloneSubSession } from '../hooks/useSubSessions.js';
import { formatLabel } from '../format-label.js';
import { getAgentBadgeConfig } from '../agent-display.js';
import { IdleFlashLayer } from './IdleFlashLayer.js';
import { useIdleFlashPlayback } from '../hooks/useIdleFlashPlayback.js';
import type { SharedStateSummary } from '../tab-sharing-ui.js';
import { SharedStateIndicator } from './SharedStateIndicator.js';
import { useVerticalResize } from '../hooks/useVerticalResize.js';
import { isWorkingSessionState } from '@shared/session-activity-types.js';

interface Props {
  serverId?: string | null;
  sessions: SessionInfo[];
  subSessions: SubSession[];
  activeSession: string | null;
  /** Map<sessionName, unreadCount> — supplied by useUnreadCounts */
  unreadCounts: Map<string, number>;
  /** Per-session idle flash replay token. */
  idleFlashTokens?: Map<string, number>;
  sharedSubSessionStates?: ReadonlyMap<string, SharedStateSummary>;
  /** Set of sub-session labels participating in active P2P discussions. */
  p2pSessionLabels?: Set<string>;
  onSelectSession: (sessionName: string) => void;
  onSelectSubSession: (sub: SubSession) => void;
  /** Open new session dialog. */
  onNewSession?: () => void;
  /** Open new sub-session dialog. */
  onNewSubSession?: () => void;
  /** When set (together with onResizeHeight), the tree renders as a fixed-height,
   *  bottom-resizable popup — the same drag-to-resize as the sidebar pinned panels. */
  height?: number;
  /** Persist a new height after a resize drag completes. */
  onResizeHeight?: (height: number) => void;
}

// ── Helper: compute label for a main session ─────────────────────────────────
function getSessionLabel(s: SessionInfo): string {
  if (s.label) return formatLabel(s.label);
  return s.role === 'brain' ? s.project : `W${s.name.split('_w')[1] ?? '?'}`;
}

/** Collapse-state key for an execution-clone group under a given parent run. */
function cloneGroupKey(parentSession: string, parentRunId: string): string {
  return `clonegroup:${parentSession}:${parentRunId}`;
}

/**
 * Split a main session's children into ordinary sub-sessions (rendered flat)
 * and execution-clone groups keyed by `parentRunId` (rendered collapsed under a
 * per-run group section). Execution clones must NEVER appear as flat top-level
 * peers — they are always nested inside their run group.
 */
function splitChildren(children: SubSession[]): {
  normalSubs: SubSession[];
  cloneGroups: Array<{ parentRunId: string; clones: SubSession[] }>;
} {
  const normalSubs: SubSession[] = [];
  const groupsByRun = new Map<string, SubSession[]>();
  const order: string[] = [];
  for (const sub of children) {
    if (isExecutionCloneSubSession(sub)) {
      // `parentRunId` may be absent on a clone identified only by kind; bucket
      // those under a stable sentinel so they still group rather than going flat.
      const runId = sub.parentRunId || 'unknown';
      const existing = groupsByRun.get(runId);
      if (existing) existing.push(sub);
      else { groupsByRun.set(runId, [sub]); order.push(runId); }
    } else {
      normalSubs.push(sub);
    }
  }
  return {
    normalSubs,
    cloneGroups: order.map((parentRunId) => ({ parentRunId, clones: groupsByRun.get(parentRunId)! })),
  };
}

// ── State dot ────────────────────────────────────────────────────────────────
function StateDot({ state }: { state: string }) {
  let color: string;
  if (isWorkingSessionState(state)) color = '#4ade80';
  else if (state === 'idle') color = '#64748b';
  else if (state === 'stopping') color = '#f59e0b';
  else if (state === 'stopped' || state === 'error') color = '#ef4444';
  else color = '#64748b';
  return (
    <span
      class="session-tree-state-dot"
      style={{ background: color }}
      title={state}
    />
  );
}

// ── Unread badge ──────────────────────────────────────────────────────────────
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span class="sidebar-unread-badge" aria-label={String(count)}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ── Single session node (main or sub-session) ─────────────────────────────────
interface NodeProps {
  label: string;
  agentType: string;
  state: string;
  isActive: boolean;
  isTransport?: boolean;
  isSub?: boolean;
  unread: number;
  idleFlashToken: number;
  sharedState?: SharedStateSummary | null;
  inP2p?: boolean;
  onClick: () => void;
}

function SessionNode({
  label, agentType, state, isActive, isTransport, isSub, unread, idleFlashToken, sharedState, inP2p, onClick,
}: NodeProps) {
  const { t } = useTranslation();
  const activeIdleFlashToken = useIdleFlashPlayback(idleFlashToken);
  const badge = getAgentBadgeConfig(agentType);

  const classes = [
    'session-tree-node',
    isSub ? 'session-tree-node--sub' : 'session-tree-node--main',
    isActive ? 'session-tree-node--active' : '',
  ].filter(Boolean).join(' ');

  return (
    <button class={classes} onClick={onClick} title={`${agentType} — ${state}`}>
      {activeIdleFlashToken ? <IdleFlashLayer key={`tree-idle-${activeIdleFlashToken}`} variant="fill" /> : null}
      {/* Icon: only for sub-sessions (main sessions use the tree toggle arrow) */}
      {isSub && (
        <span class="session-tree-icon" aria-hidden="true">
          {isTransport ? '☁' : '·'}
        </span>
      )}
      {!isSub && isTransport && (
        <span class="session-tree-icon" aria-hidden="true">☁</span>
      )}

      {/* Agent type badge */}
      {badge && (
        <span class="agent-badge" style={{ background: badge.color }}>
          {badge.label}
        </span>
      )}

      {/* Label */}
      <span class="session-tree-label">{label}</span>

      {/* P2P badge */}
      {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
      <SharedStateIndicator state={sharedState} iconOnly />

      {/* Spacer */}
      <span class="session-tree-spacer" />

      {/* Unread count badge */}
      <UnreadBadge count={unread} />

      {/* State dot */}
      <StateDot state={state} />
    </button>
  );
}

// ── Collapse state persistence ────────────────────────────────────────────────
const LS_COLLAPSED_KEY = 'rcc_tree_collapsed';
function collapsedStorageKey(serverId?: string | null): string {
  return serverId ? `${LS_COLLAPSED_KEY}:${serverId}` : LS_COLLAPSED_KEY;
}
function loadCollapsed(serverId?: string | null): Set<string> {
  try {
    const scopedRaw = localStorage.getItem(collapsedStorageKey(serverId));
    if (scopedRaw) return new Set(JSON.parse(scopedRaw));
    const legacyRaw = localStorage.getItem(LS_COLLAPSED_KEY);
    return legacyRaw ? new Set(JSON.parse(legacyRaw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveCollapsed(serverId: string | null | undefined, set: Set<string>) {
  try {
    localStorage.setItem(collapsedStorageKey(serverId), JSON.stringify([...set]));
  } catch { /* ignore */ }
}

// ── Main component ────────────────────────────────────────────────────────────
function SessionTreeInner({
  serverId,
  sessions,
  subSessions,
  activeSession,
  unreadCounts,
  idleFlashTokens,
  sharedSubSessionStates,
  p2pSessionLabels,
  onSelectSession,
  onSelectSubSession,
  onNewSession,
  onNewSubSession,
  height,
  onResizeHeight,
}: Props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(serverId));
  // Execution-clone groups default to COLLAPSED; this set tracks the ones the
  // user has explicitly EXPANDED (ephemeral — not persisted across reloads,
  // since clones are short-lived).
  const [openCloneGroups, setOpenCloneGroups] = useState<Set<string>>(() => new Set());
  const resizable = typeof height === 'number' && !!onResizeHeight;
  const { height: liveHeight, onMouseDown: onResizeMouseDown, onTouchStart: onResizeTouchStart } = useVerticalResize({
    height: height ?? 0,
    minHeight: 140,
    onResize: onResizeHeight,
  });

  useEffect(() => {
    setCollapsed(loadCollapsed(serverId));
  }, [serverId]);

  useEffect(() => {
    const validNames = new Set(sessions.map((session) => session.name));
    setCollapsed((prev) => {
      const next = new Set([...prev].filter((name) => validNames.has(name)));
      if (next.size === prev.size) return prev;
      saveCollapsed(serverId, next);
      return next;
    });
  }, [serverId, sessions]);

  const toggleCloneGroup = (key: string) => {
    setOpenCloneGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleCollapse = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      saveCollapsed(serverId, next);
      return next;
    });
  };

  const collapseAll = () => {
    const all = new Set(sessions.map(s => s.name));
    setCollapsed(all);
    saveCollapsed(serverId, all);
  };

  const expandAll = () => {
    setCollapsed(new Set());
    saveCollapsed(serverId, new Set());
  };

  const allCollapsed = sessions.length > 0 && sessions.every(s => collapsed.has(s.name));
  const subSessionsByParent = useMemo(() => {
    const byParent = new Map<string, SubSession[]>();
    const unparented: SubSession[] = [];
    for (const sub of subSessions) {
      if (!sub.parentSession) {
        unparented.push(sub);
        continue;
      }
      const existing = byParent.get(sub.parentSession);
      if (existing) existing.push(sub);
      else byParent.set(sub.parentSession, [sub]);
    }
    return { byParent, unparented };
  }, [subSessions]);
  // Check if any session has subs
  const hasSubs = subSessions.length > 0;

  if (sessions.length === 0) {
    return (
      <div class="session-tree-empty">
        {t('sidebar.noSessions', 'No sessions')}
      </div>
    );
  }

  return (
    <div
      class={resizable ? 'session-tree is-resizable' : 'session-tree'}
      role="tree"
      aria-label={t('sidebar.sessionTree', 'Session tree')}
      style={resizable ? { height: liveHeight } : undefined}
    >
      {/* Header: collapse toggle + new session button */}
      <div class="session-tree-header">
        {hasSubs && (
          <button
            class="session-tree-collapse-all"
            onClick={allCollapsed ? expandAll : collapseAll}
            title={allCollapsed ? t('sidebar.expand_all', 'Expand all') : t('sidebar.collapse_all', 'Collapse all')}
          >
            {allCollapsed ? '▸' : '▾'} {allCollapsed ? t('sidebar.expand_all', 'Expand all') : t('sidebar.collapse_all', 'Collapse all')}
          </button>
        )}
        {onNewSession && (
          <button class="session-tree-add-btn" data-onboarding="new-main-session" onClick={onNewSession} title={t('session.new_session', 'New session')}>+</button>
        )}
      </div>

      <div class="session-tree-scroll">
      {sessions.map((session) => {
        const sessionLabel = getSessionLabel(session);
        const isActive = session.name === activeSession;
        const isTransport = isTransportRuntime(session);
        const unread = unreadCounts.get(session.name) ?? 0;
        const idleFlashToken = idleFlashTokens?.get(session.name) ?? 0;

        // Sub-sessions belonging to this main session. Unparented legacy
        // entries remain visible under every main session, matching the old
        // `filter(!parentSession || parentSession === session.name)` behavior
        // without doing an O(main sessions * sub-sessions) scan each render.
        const parentedChildren = subSessionsByParent.byParent.get(session.name) ?? [];
        const children = subSessionsByParent.unparented.length > 0
          ? [...parentedChildren, ...subSessionsByParent.unparented]
          : parentedChildren;
        // Execution clones never render as flat peers — split them into per-run
        // groups; ordinary sub-sessions still render flat as before.
        const { normalSubs, cloneGroups } = splitChildren(children);
        const isCollapsed = collapsed.has(session.name);

        // Render a single sub-session node (shared by the flat list and the
        // execution-clone groups).
        const renderSubNode = (sub: SubSession) => {
          const subLabel = sub.label ? formatLabel(sub.label) : sub.type;
          const subUnread = unreadCounts.get(sub.sessionName) ?? 0;
          const subIdleFlashToken = idleFlashTokens?.get(sub.sessionName) ?? 0;
          return (
            <SessionNode
              key={sub.id}
              label={subLabel}
              agentType={sub.type}
              state={sub.state}
              isActive={false}
              isTransport={false}
              isSub={true}
              unread={subUnread}
              idleFlashToken={subIdleFlashToken}
              sharedState={sharedSubSessionStates?.get(sub.id) ?? sharedSubSessionStates?.get(sub.sessionName)}
              inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
              onClick={() => onSelectSubSession(sub)}
            />
          );
        };

        return (
          <div key={session.name} role="treeitem" aria-expanded={!isCollapsed && children.length > 0}>
            {/* Main session node with collapse toggle */}
            <div class="session-tree-main-row">
              {children.length > 0 && (
                <button
                  class="session-tree-toggle"
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(session.name); }}
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              )}
              <SessionNode
                label={sessionLabel}
                agentType={session.agentType}
                state={session.state}
                isActive={isActive}
                isTransport={isTransport}
                isSub={false}
                unread={unread}
                idleFlashToken={idleFlashToken}
                sharedState={session.sharedState}
                inP2p={!!p2pSessionLabels?.has(session.name)}
                onClick={() => onSelectSession(session.name)}
              />
              {onNewSubSession && (
                <button
                  class="session-tree-add-sub-btn"
                  onClick={(e) => { e.stopPropagation(); onSelectSession(session.name); onNewSubSession(); }}
                  title={t('session.new_sub', 'New sub-session')}
                >+</button>
              )}
            </div>

            {/* Ordinary sub-session nodes (indented) — hidden when collapsed */}
            {!isCollapsed && normalSubs.map((sub) => renderSubNode(sub))}

            {/* Execution-clone groups: collapsed per-parent-run sections. Never
                flat peers. Each group toggles independently of the main row. */}
            {!isCollapsed && cloneGroups.map((group) => {
              const groupKey = cloneGroupKey(session.name, group.parentRunId);
              // Default state for clone groups is COLLAPSED. We track EXPANDED
              // groups in a separate set so the default (no entry) reads as
              // collapsed without seeding the shared `collapsed` set.
              const isGroupCollapsed = !openCloneGroups.has(groupKey);
              return (
                <div key={groupKey} class="session-tree-clone-group" role="group">
                  <button
                    class="session-tree-toggle session-tree-clone-group-toggle"
                    onClick={(e) => { e.stopPropagation(); toggleCloneGroup(groupKey); }}
                    title={isGroupCollapsed ? t('sidebar.expand_all', 'Expand all') : t('sidebar.collapse_all', 'Collapse all')}
                    aria-expanded={!isGroupCollapsed}
                  >
                    <span aria-hidden="true">{isGroupCollapsed ? '▸' : '▾'}</span>
                    <span class="session-tree-clone-group-label">
                      {t('session.executionGroup.title', 'Execution workers (run {{run}})', {
                        run: group.parentRunId === 'unknown'
                          ? t('session.executionGroup.unknownRun', 'pending')
                          : group.parentRunId.slice(0, 8),
                      })}
                    </span>
                    <span class="session-tree-clone-group-count">{group.clones.length}</span>
                  </button>
                  {!isGroupCollapsed && group.clones.map((sub) => renderSubNode(sub))}
                </div>
              );
            })}
          </div>
        );
      })}
      </div>
      {resizable && (
        <div
          class="sidebar-pinned-resize-handle"
          onMouseDown={onResizeMouseDown}
          onTouchStart={onResizeTouchStart}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** Memoized export — stable keys + memoized item list avoid O(n) re-renders on WS events. */
export const SessionTree = memo(SessionTreeInner);
