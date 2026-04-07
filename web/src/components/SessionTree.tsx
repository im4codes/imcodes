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

import { useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { formatLabel } from '../format-label.js';

// ── Agent badge config (matches SessionTabs.tsx AGENT_BADGE) ─────────────────
const AGENT_BADGE: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'cc', color: '#7c3aed' },
  'codex':       { label: 'cx', color: '#d97706' },
  'opencode':    { label: 'oc', color: '#059669' },
  'openclaw':    { label: 'oc', color: '#f97316' },
  'qwen':        { label: 'qw', color: '#0f766e' },
  'gemini':      { label: 'gm', color: '#1d4ed8' },
  'shell':       { label: 'sh', color: '#475569' },
  'script':      { label: 'sc', color: '#64748b' },
};

// ── Sub-session type icons ────────────────────────────────────────────────────
const SUB_TYPE_BADGE: Record<string, { label: string; color: string }> = {
  'claude-code': { label: 'cc', color: '#7c3aed' },
  'codex':       { label: 'cx', color: '#d97706' },
  'opencode':    { label: 'oc', color: '#059669' },
  'openclaw':    { label: 'oc', color: '#f97316' },
  'qwen':        { label: 'qw', color: '#0f766e' },
  'gemini':      { label: 'gm', color: '#1d4ed8' },
  'shell':       { label: 'sh', color: '#475569' },
  'script':      { label: 'sc', color: '#64748b' },
};

interface Props {
  sessions: SessionInfo[];
  subSessions: SubSession[];
  activeSession: string | null;
  /** Map<sessionName, unreadCount> — supplied by useUnreadCounts */
  unreadCounts: Map<string, number>;
  /** Sessions that should currently show an idle flash animation. */
  idleFlashes?: Set<string>;
  /** Set of sub-session labels participating in active P2P discussions. */
  p2pSessionLabels?: Set<string>;
  onSelectSession: (sessionName: string) => void;
  onSelectSubSession: (sub: SubSession) => void;
  /** Open new session dialog. */
  onNewSession?: () => void;
  /** Open new sub-session dialog. */
  onNewSubSession?: () => void;
}

// ── Helper: compute label for a main session ─────────────────────────────────
function getSessionLabel(s: SessionInfo): string {
  if (s.label) return formatLabel(s.label);
  return s.role === 'brain' ? s.project : `W${s.name.split('_w')[1] ?? '?'}`;
}

// ── State dot ────────────────────────────────────────────────────────────────
function StateDot({ state }: { state: string }) {
  let color: string;
  if (state === 'running') color = '#4ade80';
  else if (state === 'idle') color = '#64748b';
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
  idleFlash: boolean;
  inP2p?: boolean;
  onClick: () => void;
}

function SessionNode({
  label, agentType, state, isActive, isTransport, isSub, unread, idleFlash, inP2p, onClick,
}: NodeProps) {
  const { t } = useTranslation();
  const badge = isSub
    ? (SUB_TYPE_BADGE[agentType] ?? null)
    : (AGENT_BADGE[agentType] ?? null);

  const classes = [
    'session-tree-node',
    isSub ? 'session-tree-node--sub' : 'session-tree-node--main',
    isActive ? 'session-tree-node--active' : '',
    idleFlash ? 'sidebar-idle-flash' : '',
  ].filter(Boolean).join(' ');

  return (
    <button class={classes} onClick={onClick} title={`${agentType} — ${state}`}>
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
function loadCollapsed(): Set<string> {
  try { const raw = localStorage.getItem(LS_COLLAPSED_KEY); return raw ? new Set(JSON.parse(raw)) : new Set(); } catch { return new Set(); }
}
function saveCollapsed(set: Set<string>) {
  try { localStorage.setItem(LS_COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

// ── Main component ────────────────────────────────────────────────────────────
function SessionTreeInner({
  sessions,
  subSessions,
  activeSession,
  unreadCounts,
  idleFlashes,
  p2pSessionLabels,
  onSelectSession,
  onSelectSubSession,
  onNewSession,
  onNewSubSession,
}: Props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const toggleCollapse = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      saveCollapsed(next);
      return next;
    });
  };

  const collapseAll = () => {
    const all = new Set(sessions.map(s => s.name));
    setCollapsed(all);
    saveCollapsed(all);
  };

  const expandAll = () => {
    setCollapsed(new Set());
    saveCollapsed(new Set());
  };

  const allCollapsed = sessions.length > 0 && sessions.every(s => collapsed.has(s.name));

  if (sessions.length === 0) {
    return (
      <div class="session-tree-empty">
        {t('sidebar.noSessions', 'No sessions')}
      </div>
    );
  }

  // Check if any session has subs
  const hasSubs = subSessions.length > 0;

  return (
    <div class="session-tree" role="tree" aria-label={t('sidebar.sessionTree', 'Session tree')}>
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

      {sessions.map((session) => {
        const sessionLabel = getSessionLabel(session);
        const isActive = session.name === activeSession;
        const isTransport = session.runtimeType === 'transport';
        const unread = unreadCounts.get(session.name) ?? 0;
        const idleFlash = idleFlashes?.has(session.name) ?? false;

        // Sub-sessions belonging to this main session
        const children = subSessions.filter(
          (s) => !s.parentSession || s.parentSession === session.name,
        );
        const isCollapsed = collapsed.has(session.name);

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
                idleFlash={idleFlash}
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

            {/* Sub-session nodes (indented) — hidden when collapsed */}
            {!isCollapsed && children.map((sub) => {
              const subLabel = sub.label ? formatLabel(sub.label) : sub.type;
              const subUnread = unreadCounts.get(sub.sessionName) ?? 0;
              const subIdleFlash = idleFlashes?.has(sub.sessionName) ?? false;
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
                  idleFlash={subIdleFlash}
                  inP2p={!!p2pSessionLabels?.has(sub.sessionName)}
                  onClick={() => onSelectSubSession(sub)}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Memoized export — stable keys + memoized item list avoid O(n) re-renders on WS events. */
export const SessionTree = memo(SessionTreeInner);
