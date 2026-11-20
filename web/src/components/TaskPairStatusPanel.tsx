import { TaskPairDecisionPanel } from './TaskPairDecisionPanel.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { readPairScheduling, TASK_PAIR_WAIT_KINDS, type TaskPairScheduling } from '@shared/task-pair-suspension.js';
import { taskPairDisplayTitle, taskPairResolveDisplaySessionLabel, collectTaskPairTitlesFromSnapshot, formatTaskPairDependencyTasks } from '@shared/task-pair-display.js';
import { isMobileLayout, subscribeDeviceLayoutChange } from '../mobile-device.js';
import { applyTaskPairPanelFit, bindTaskPairPanelFit, TASK_PAIR_PANEL_MAX_HEIGHT_VAR } from '../task-pair-panel-fit.js';
import { useTaskPairPanelWidth } from '../task-pair-panel-width.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { TASK_PAIR_TERMINAL_STATUSES, TASK_PAIR_TIMELINE_EVENT, type TaskPairStatus } from '@shared/task-pair.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { formatTaskDuration } from '../util/tool-duration.js';
import { watchProjectionStore } from '../watch-projection.js';
import { TaskPairBrief } from './TaskPairBrief.js';
import { closeServerTaskPair } from '../api.js';
import type { TaskPairCloseAction } from '@shared/task-pair-close.js';
import {
  clampContextMenuPosition,
  formatTaskPairCloseError,
  TaskPairCloseConfirmDialog,
  TaskPairContextMenu,
  type TaskPairCloseConfirmTarget,
  type TaskPairContextMenuItem,
} from './TaskPairActionMenus.js';
import {
  DEFAULT_TASK_PAIR_SPLIT_MODIFIERS,
  KEYBOARD_SHORTCUTS_PREF_KEY,
  formatShortcutModifierKeycaps,
  isMacPlatform,
  resolveTaskPairSplitModifiers,
  type KeyboardShortcutOverrides,
  type ShortcutModifierKey,
} from '../keyboard-shortcuts.js';
import {
  getTaskPairWaitKind,
  groupAndOrderTaskPairRows,
  isAcceptedPanelSnapshot,
  isTaskPairSplittable,
  mergeSnapshotRows,
  normalizeTaskPairSnapshot,
  type TaskPairConsoleSnapshotDetail,
  type TaskPairPanelRow,
} from '../task-pair-panel-order.js';
import {
  cleanLegacyTaskPairPanelKeysOnce,
  isPhoneScreen,
  readServerWideChoice,
  resolveTaskPairPanelCollapsed,
  serverWideStorageKey,
  usesVisitScopedChoice,
  writeServerWideChoice,
} from '../task-pair-panel-state.js';

/** Kept for callers and tests: the server-wide flag's key (see task-pair-panel-state.ts). */
export const collapsedStorageKey = serverWideStorageKey;

type SnapshotScopeMeta = {
  authorityScopeKey?: string;
  scopeKey?: string;
  serverId?: string;
};

function readTaskPairSplitModifiers(): ShortcutModifierKey[] {
  const win = window as Window & { __imcodesTaskPairSplitModifiers?: ShortcutModifierKey[] };
  if (Array.isArray(win.__imcodesTaskPairSplitModifiers) && win.__imcodesTaskPairSplitModifiers.length > 0) {
    return win.__imcodesTaskPairSplitModifiers;
  }
  try {
    const raw = localStorage.getItem(`rcc_sync_${KEYBOARD_SHORTCUTS_PREF_KEY}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { v?: KeyboardShortcutOverrides } | KeyboardShortcutOverrides;
      const overrides = (parsed && typeof parsed === 'object' && 'v' in parsed ? parsed.v : parsed) as KeyboardShortcutOverrides | undefined;
      return resolveTaskPairSplitModifiers(overrides);
    }
  } catch {}
  return [...DEFAULT_TASK_PAIR_SPLIT_MODIFIERS];
}

function formatTaskPairSplitHint(modifiers: readonly ShortcutModifierKey[], sequenceNumber: number): string {
  const isMac = isMacPlatform();
  const caps = formatShortcutModifierKeycaps(modifiers, isMac, DEFAULT_TASK_PAIR_SPLIT_MODIFIERS);
  return isMac ? `${caps.join('')}${sequenceNumber}` : `${caps.join('+')}+${sequenceNumber}`;
}

function readSnapshotScope(detail: unknown): SnapshotScopeMeta {
  if (!detail || typeof detail !== 'object') return {};
  const raw = detail as Record<string, unknown>;
  return {
    ...(typeof raw.authorityScopeKey === 'string' && raw.authorityScopeKey ? { authorityScopeKey: raw.authorityScopeKey } : {}),
    ...(typeof raw.scopeKey === 'string' && raw.scopeKey ? { scopeKey: raw.scopeKey } : {}),
    ...(typeof raw.serverId === 'string' && raw.serverId ? { serverId: raw.serverId } : {}),
  };
}

function isCrossScopeSnapshot(prev: SnapshotScopeMeta | undefined, next: SnapshotScopeMeta): boolean {
  if (!prev) return false;
  if (prev.authorityScopeKey && next.authorityScopeKey) {
    return prev.authorityScopeKey !== next.authorityScopeKey;
  }
  if (prev.scopeKey && next.scopeKey) {
    return prev.scopeKey !== next.scopeKey;
  }
  if (!prev.authorityScopeKey && next.authorityScopeKey) {
    return true;
  }
  return Boolean(prev.serverId && next.serverId && prev.serverId !== next.serverId);
}

type SessionLabelEntry = { name: string; label?: string | null; activeModel?: string | null; requestedModel?: string | null; effort?: string | null };

function resolveSessionModel(
  id: string,
  payloadModel: unknown,
  sessions: readonly SessionLabelEntry[] | undefined,
  projectionSessions: readonly { sessionName: string; title: string; activeModel?: string | null; requestedModel?: string | null }[],
): string | undefined {
  if (typeof payloadModel === 'string' && payloadModel.trim()) return payloadModel.trim();
  const session = sessions?.find((entry) => entry.name === id);
  if (session?.activeModel?.trim() || session?.requestedModel?.trim()) return session.activeModel?.trim() || session.requestedModel?.trim() || undefined;
  const projected = projectionSessions.find((entry) => entry.sessionName === id);
  return projected?.activeModel?.trim() || projected?.requestedModel?.trim() || undefined;
}

function hasPairActivity(events: readonly TimelineEvent[], serverId?: string | null): boolean {
  if (events.some((event) => event.type === TASK_PAIR_TIMELINE_EVENT)) return true;
  const snapshot = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
  if (!isAcceptedPanelSnapshot(snapshot, serverId)) return false;
  return Boolean(snapshot?.authorityUnavailable) || (Array.isArray(snapshot?.tasks) && snapshot.tasks.length > 0);
}

function resetScrollPosition(node: Element | EventTarget | null | undefined): void {
  if (!node || !('scrollTop' in node) || !('scrollLeft' in node)) return;
  const el = node as HTMLElement;
  if (el.scrollTop !== 0) el.scrollTop = 0;
  if (el.scrollLeft !== 0) el.scrollLeft = 0;
}

function resetPanelChromeScroll(panel: HTMLElement | null, toggleEl: HTMLElement | null): void {
  resetScrollPosition(panel);
  resetScrollPosition(toggleEl);
  if (panel?.parentElement?.classList.contains('chat-titlebar')) resetScrollPosition(panel.parentElement);
  if (!panel) return;
  for (const el of panel.querySelectorAll('.task-pair-status-toggle, .task-pair-status-compact, .task-pair-status-icons, .task-pair-status-mobile-content')) {
    resetScrollPosition(el);
  }
}

function clampElementScroll(event: { currentTarget: EventTarget | null }): void {
  resetScrollPosition(event.currentTarget);
}

export function TaskPairStatusPanel({ events, sessions, serverId, scopeSessionId, collapsedVisitKey, mobileAnchor, visible = true, canCloseTasks = true }: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null; scopeSessionId?: string | null; collapsedVisitKey?: string | null; mobileAnchor?: Element | null; visible?: boolean; canCloseTasks?: boolean }) {
  const { t } = useTranslation();
  const [isMobile, setIsMobile] = useState(isMobileLayout);
  // A phone sub-session or split-executor visit shows its panel CLOSED every time it is opened and keeps the user's own choice in this component's memory only
  // (it lives while the view stays mounted, through resizes, and is gone when the user leaves): nothing is stored. The main chat and
  // other desktop windows keep the stored server-wide flag. See task-pair-panel-state.ts.
  const phoneNow = () => isPhoneScreen({ mobile: isMobileLayout(), screenWidth: window.screen?.width, screenHeight: window.screen?.height, innerWidth: window.innerWidth });
  const [phone, setPhone] = useState(phoneNow);
  const visitScoped = usesVisitScopedChoice({ phone, scopeSessionId, collapsedVisitKey });
  const [choice, setChoice] = useState<boolean | undefined>(() => (usesVisitScopedChoice({ phone: phoneNow(), scopeSessionId, collapsedVisitKey }) ? undefined : readServerWideChoice({ serverId, mobile: isMobileLayout() })));
  cleanLegacyTaskPairPanelKeysOnce();
  // The mobile panel is measured against the visible chat area; when too little
  // room is left (landscape phone, keyboard open) the collapsed strip is shown
  // instead, without touching the user's choice.
  const [cramped, setCramped] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLElement | null>(null);
  const setToggleNode = useCallback((el: HTMLElement | null) => { toggleRef.current = el; }, []);
  const persistCollapsed = useCallback((next: boolean) => {
    setChoice(next);
    if (!visitScoped) writeServerWideChoice({ serverId, mobile: isMobile, collapsed: next });
  }, [serverId, isMobile, visitScoped]);
  useEffect(() => {
    // Only the layout class is tracked here; the choice is re-read by the effect below when the layout (or the panel's scope) changes.
    const onChange = () => { setIsMobile(isMobileLayout()); setPhone(phoneNow()); };
    onChange();
    return subscribeDeviceLayoutChange(onChange);
  }, []);
  // The choice is re-resolved only when what it belongs to changes: another server or sub-session, or the layout class. A phone
  // sub-session starts closed again for a different session; a resize within the same view never reaches this.
  // A split visit survives responsive layout changes, but not another task/session/server or exit/re-entry.
  const scopeKey = JSON.stringify([serverId, scopeSessionId, collapsedVisitKey, visitScoped ? 'visit' : isMobile ? 'mobile' : 'desktop']);
  const lastScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeKey.current === scopeKey) return;
    lastScopeKey.current = scopeKey;
    setChoice(visitScoped ? undefined : readServerWideChoice({ serverId, mobile: isMobile }));
  }, [scopeKey, serverId, isMobile, visitScoped]);
  const lastSnapshotScopeRef = useRef<SnapshotScopeMeta | undefined>((() => {
    const detail = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
    if (!isAcceptedPanelSnapshot(detail, serverId)) return undefined;
    const scope = readSnapshotScope(detail);
    return scope.authorityScopeKey || scope.scopeKey || scope.serverId ? scope : undefined;
  })());
  const [snapshotRows, setSnapshotRows] = useState<readonly Record<string, unknown>[] | null>(() => {
    const detail = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
    return detail && isAcceptedPanelSnapshot(detail, serverId) ? normalizeTaskPairSnapshot(detail) : null;
  });
  const [snapshotTitles, setSnapshotTitles] = useState<Map<string, string>>(() => {
    const detail = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
    return isAcceptedPanelSnapshot(detail, serverId) ? collectTaskPairTitlesFromSnapshot(detail) : new Map();
  });
  const [activeSplitTaskId, setActiveSplitTaskId] = useState<string | null>(() => {
    return (window as Window & { __imcodesActiveSplitTaskId?: string | null }).__imcodesActiveSplitTaskId ?? null;
  });
  const [splitShortcutModifiers, setSplitShortcutModifiers] = useState<ShortcutModifierKey[]>(readTaskPairSplitModifiers);
  const [optimisticClosedRows, setOptimisticClosedRows] = useState<Map<string, { toStatus: string; updatedAt: number; endedAt?: number }>>(() => new Map());
  const [rowContextMenu, setRowContextMenu] = useState<{
    taskId: string;
    title: string;
    status: string;
    terminal: boolean;
    payload: Record<string, unknown>;
    x: number;
    y: number;
  } | null>(null);
  const [closeConfirmTarget, setCloseConfirmTarget] = useState<TaskPairCloseConfirmTarget | null>(null);
  const [closeSending, setCloseSending] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => {
    setOptimisticClosedRows(new Map());
    setRowContextMenu(null);
    setCloseConfirmTarget(null);
    setCloseError(null);
  }, [serverId]);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setActiveSplitTaskId(detail?.activeTaskId ?? null);
    };
    const onModifiersChange = () => setSplitShortcutModifiers(readTaskPairSplitModifiers());
    window.addEventListener('deck:pair-split-state', handler);
    window.addEventListener('deck:task-pair-split-modifiers', onModifiersChange);
    return () => {
      window.removeEventListener('deck:pair-split-state', handler);
      window.removeEventListener('deck:task-pair-split-modifiers', onModifiersChange);
    };
  }, []);
  useEffect(() => {
    const applyPanelSnapshot = (detail: TaskPairConsoleSnapshotDetail | undefined) => {
      if (!detail || !isAcceptedPanelSnapshot(detail, serverId)) return;
      if (detail.scopeReset) {
        (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = undefined;
        lastSnapshotScopeRef.current = undefined;
        setSnapshotRows(null);
        setSnapshotTitles(new Map());
        return;
      }
      if (detail.authorityUnavailable) {
        setSnapshotTitles(new Map());
      } else if (Array.isArray(detail.tasks) || detail.taskTitles) {
        setSnapshotTitles(collectTaskPairTitlesFromSnapshot(detail));
      }
      if (Array.isArray(detail.tasks)) {
        const normalized = normalizeTaskPairSnapshot(detail);
        if (normalized) {
          const nextScope = readSnapshotScope(detail);
          const crossScope = isCrossScopeSnapshot(lastSnapshotScopeRef.current, nextScope);
          if (nextScope.authorityScopeKey || nextScope.scopeKey || nextScope.serverId) {
            lastSnapshotScopeRef.current = nextScope;
          }
          setSnapshotRows((current) => mergeSnapshotRows(crossScope ? null : current, normalized));
        }
      }
    };
    const current = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
    if (current && !current.scopeReset) {
      applyPanelSnapshot(current);
    } else if (!current && lastSnapshotScopeRef.current?.serverId && serverId && lastSnapshotScopeRef.current.serverId !== serverId) {
      lastSnapshotScopeRef.current = undefined;
      setSnapshotRows(null);
      setSnapshotTitles(new Map());
    }
    const onSnapshot = (event: Event) => {
      applyPanelSnapshot((event as CustomEvent).detail as TaskPairConsoleSnapshotDetail | undefined);
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, [serverId]);
  const {
    reworkCounts,
    taskTitles,
    groups,
    scopedDefaultTaskId,
    counts,
    hasRows,
    hasActiveDurationRow,
  } = useMemo(() => {
    const latest = new Map<string, TaskPairPanelRow>();
    const nextReworkCounts = new Map<string, number>();
    const nextTaskTitles = new Map<string, string>();
    for (const event of events) {
      if (event.type !== TASK_PAIR_TIMELINE_EVENT) continue;
      const eventPayload = event.payload as Record<string, unknown>;
      if (typeof eventPayload.taskId === 'string') {
        const eventTitle = taskPairDisplayTitle(eventPayload.title, eventPayload.taskId, eventPayload.brief);
        if (eventTitle) nextTaskTitles.set(eventPayload.taskId, eventTitle);
        if (eventPayload.verb === 'REWORK') {
          nextReworkCounts.set(eventPayload.taskId, (nextReworkCounts.get(eventPayload.taskId) ?? 0) + 1);
        }
      }
    }
    for (const [id, resolved] of snapshotTitles) nextTaskTitles.set(id, resolved);
    if (snapshotRows) {
      for (const payload of snapshotRows) {
        if (typeof payload.taskId === 'string') {
          latest.set(payload.taskId, { payload, startedAt: Number(payload.startedAt), updatedAt: Number(payload.updatedAt) });
        }
      }
    }
    for (const event of events) {
      if (snapshotRows) break;
      if (event.type !== TASK_PAIR_TIMELINE_EVENT) continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.taskId === 'string') {
        const old = latest.get(payload.taskId);
        latest.set(payload.taskId, { payload, startedAt: old?.startedAt ?? event.ts, updatedAt: event.ts });
      }
    }
    for (const [id, row] of latest.entries()) {
      const override = optimisticClosedRows.get(id);
      if (override) {
        const existingUpdatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
        if (!TASK_PAIR_TERMINAL_STATUSES.includes(row.payload.toStatus as TaskPairStatus) || override.updatedAt >= existingUpdatedAt) {
          const nextPayload: Record<string, unknown> = {
            ...row.payload,
            toStatus: override.toStatus,
            updatedAt: override.updatedAt,
            ...(override.endedAt !== undefined ? { endedAt: override.endedAt } : {}),
          };
          latest.set(id, { ...row, payload: nextPayload, updatedAt: override.updatedAt });
        }
      }
      const effectiveRow = latest.get(id) ?? row;
      const resolved = taskPairDisplayTitle(effectiveRow.payload.title, id, effectiveRow.payload.brief);
      if (resolved) nextTaskTitles.set(id, resolved);
    }
    const grouped = groupAndOrderTaskPairRows(latest.values(), scopeSessionId);
    const nextScopedDefaultTaskId = scopeSessionId
      ? (grouped.allRows.find((row) => ['working', 'in_audit', 'awaiting_audit', 'rework'].includes(String(row.payload.toStatus)))?.payload.taskId ?? grouped.allRows[0]?.payload.taskId)
      : undefined;
    const nextCounts = grouped.allRows.reduce<{ working: number; audit: number; queued: number; awaitingBrain: number; waiting: number }>((result, row) => {
      if (getTaskPairWaitKind(row.payload)) { result.waiting += 1; return result; }
      const value = row.payload.toStatus;
      if (value === 'working' || value === 'rework') result.working += 1;
      else if (value === 'in_audit' || value === 'awaiting_audit') result.audit += 1;
      else if (value === 'awaiting_brain_decision') result.awaitingBrain += 1;
      else if (value === 'queued') result.queued += 1;
      return result;
    }, { working: 0, audit: 0, queued: 0, awaitingBrain: 0, waiting: 0 });
    const nextHasActiveDurationRow = grouped.allRows.some(
      (row) => !TASK_PAIR_TERMINAL_STATUSES.includes(row.payload.toStatus as TaskPairStatus),
    );
    return {
      reworkCounts: nextReworkCounts,
      taskTitles: nextTaskTitles,
      groups: grouped.groups,
      scopedDefaultTaskId: nextScopedDefaultTaskId,
      counts: nextCounts,
      hasRows: latest.size > 0 && grouped.allRows.length > 0,
      hasActiveDurationRow: nextHasActiveDurationRow,
    };
  }, [events, snapshotRows, snapshotTitles, scopeSessionId, optimisticClosedRows]);
  // What is shown: the user's own choice if there is one, else the default (a phone sub-session: closed); too little room on a phone
  // inline sub-window shows the strip without touching the choice. On mobile main chat (no scopeSessionId), expanding uses fullscreen
  // overlay so inline cramped measurement / --task-pair-panel-max-h must not collapse or clip it.
  const usesInlineMobileFit = isMobile && Boolean(scopeSessionId);
  const collapsed = resolveTaskPairPanelCollapsed({ choice, mobile: isMobile, phone, scopeSessionId, collapsedVisitKey }) || (usesInlineMobileFit && cramped);
  const now = useNowTicker(visible && !collapsed && hasRows && hasActiveDurationRow);
  const isFullscreen = isMobile && !scopeSessionId && !collapsed;
  const shouldPortalToAnchor = Boolean(mobileAnchor && (isMobile || collapsed));
  const panelWidth = useTaskPairPanelWidth(panelRef, !isMobile && !collapsed && hasRows, Boolean(scopeSessionId || collapsedVisitKey));
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (isMobile || collapsed || !hasRows || !panel || !mobileAnchor) {
      panel?.style.removeProperty('top');
      return undefined;
    }
    const syncDesktopTop = () => {
      const mainEl = panel.closest('.chat-main');
      if (!mainEl) return;
      const mainRect = mainEl.getBoundingClientRect();
      const anchorRect = mobileAnchor.getBoundingClientRect();
      if (mainRect.height <= 0 || anchorRect.height <= 0) {
        panel.style.removeProperty('top');
        return;
      }
      const offsetTop = Math.max(40, Math.ceil(anchorRect.bottom - mainRect.top));
      if (offsetTop > 40) panel.style.top = `${offsetTop}px`;
      else panel.style.removeProperty('top');
    };
    syncDesktopTop();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncDesktopTop);
    const mainEl = panel.closest('.chat-main');
    if (observer) {
      observer.observe(mobileAnchor);
      if (mainEl && mainEl !== mobileAnchor) observer.observe(mainEl);
    }
    window.addEventListener('resize', syncDesktopTop);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncDesktopTop);
      panel.style.removeProperty('top');
    };
  }, [isMobile, collapsed, hasRows, mobileAnchor]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!usesInlineMobileFit || !hasRows || !panel) {
      panel?.style.removeProperty(TASK_PAIR_PANEL_MAX_HEIGHT_VAR);
      setCramped(false);
      return undefined;
    }
    return bindTaskPairPanelFit(panel, setCramped);
  }, [usesInlineMobileFit, hasRows, mobileAnchor]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    resetPanelChromeScroll(panel, toggleRef.current);
    if (!usesInlineMobileFit || !hasRows || !panel) {
      panel?.style.removeProperty(TASK_PAIR_PANEL_MAX_HEIGHT_VAR);
      return;
    }
    applyTaskPairPanelFit(panel, setCramped);
  }, [usesInlineMobileFit, hasRows, collapsed, mobileAnchor]);
  if (!hasRows) return null;
  const toggle = () => persistCollapsed(!collapsed);
  const toggleWithKeyboard = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  };
  const projectionSessions = watchProjectionStore.getSnapshot().sessions;
  const session = (id: unknown, label: unknown, model: unknown, _thinking: unknown, role: 'executor' | 'auditor') => {
    // 'none' is a real, deliberate value (auditor=none): there is no session
    // to open, so it must not render as a dangling clickable placeholder.
    if (typeof id !== 'string' || !id || id === 'none') return null;
    const text = taskPairResolveDisplaySessionLabel(id, label, sessions?.find((entry) => entry.name === id), projectionSessions.find((entry) => entry.sessionName === id)?.title) || t(`taskPair.panel_${role}`);
    const resolvedModel = resolveSessionModel(id, model, sessions, projectionSessions);
    return <button type="button" class="task-pair-status-session" data-session-name={id} onClick={() => {
      if (isFullscreen) persistCollapsed(true);
      window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: id } }));
    }}>
      <span class="task-pair-status-session-main">
        <span class="task-pair-status-session-label">{text}</span>
        {resolvedModel && <small class="task-pair-status-session-model">{resolvedModel}</small>}
      </span>
    </button>;
  };
  const unassigned = (model: unknown, _thinking: unknown) => {
    const modelText = typeof model === 'string' && model.trim() ? model.trim() : '';
    return <small class="task-pair-role-unassigned">{t('taskPair.panel_unassigned')}{modelText ? `${t('taskPair.panel_model_separator')}${modelText}` : ''}</small>;
  };
  const durationUnits = {
    hour: t('taskPair.panel_duration_hour'),
    day: t('taskPair.panel_duration_day'),
    minute: t('taskPair.panel_duration_minute'),
    second: t('taskPair.panel_duration_second'),
    separator: t('taskPair.panel_duration_separator'),
  };
  const toggleLabel = `${t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} — ${t('taskPair.panel_title')}`;
  const toggleContent = collapsed ? <span class={`task-pair-status-icons${isMobile ? ' task-pair-status-mobile-content' : ''}`} role="group" aria-label={t('taskPair.panel_title')}>
    {counts.waiting > 0 && <span class="task-pair-status-icon" title={t('taskPair.status.paused')} aria-label={t('taskPair.status.paused')}><span aria-hidden="true">⏸</span><b>{counts.waiting}</b></span>}
    {isMobile && <span class="task-pair-status-mobile-label">{t('taskPair.panel_title')}</span>}
    <span class={`task-pair-status-icon task-pair-status-icon--working${counts.working === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_working')} aria-label={t('taskPair.panel_icon_working')}><span aria-hidden="true">▶</span><b>{counts.working}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--audit${counts.audit === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_audit')} aria-label={t('taskPair.panel_icon_audit')}><span aria-hidden="true">◉</span><b>{counts.audit}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--queued${counts.queued === 0 ? ' is-zero' : ''}`} title={t('taskPair.panel_icon_queued')} aria-label={t('taskPair.panel_icon_queued')}><span aria-hidden="true">⏳</span><b>{counts.queued}</b></span>
    <span class={`task-pair-status-icon task-pair-status-icon--awaiting${counts.awaitingBrain === 0 ? ' is-zero' : ' is-highlighted'}`} title={t('taskPair.panel_icon_awaiting_brain')} aria-label={t('taskPair.panel_icon_awaiting_brain')}><span aria-hidden="true">🧠</span><b>{counts.awaitingBrain}</b></span>
    {!isMobile && <span class="task-pair-status-collapse-icon" aria-hidden="true">⌄</span>}
  </span> : <><strong>{t('taskPair.panel_title')}</strong>
    <span class="task-pair-status-summary">
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--working">{t('taskPair.panel_count_working', { count: counts.working })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--in_audit">{t('taskPair.panel_count_audit', { count: counts.audit })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--queued">{t('taskPair.panel_count_queued', { count: counts.queued })}</span>
      <span class="task-pair-status-badge task-pair-status-badge--sm task-pair-chip--awaiting_brain_decision">{t('taskPair.status.awaiting_brain_decision')} ({counts.awaitingBrain})</span>
    </span><span class="task-pair-status-collapse-icon" aria-hidden="true">⌃</span></>;
  const panelEl = <aside ref={panelRef} class={`task-pair-status-panel${collapsed ? ' is-collapsed' : ''}${isMobile ? ' is-mobile' : ' is-desktop'}${isFullscreen ? ' is-fullscreen' : ''}`} data-testid="task-pair-status-panel" onScroll={clampElementScroll}>
    {!isMobile && !collapsed && <div class="task-pair-status-resize" role="separator" tabIndex={0}
      aria-label={t('taskPair.panel_resize')} title={t('taskPair.panel_resize')} aria-orientation="vertical"
      aria-valuemin={panelWidth.min} aria-valuemax={panelWidth.max} aria-valuenow={panelWidth.width}
      onPointerDown={panelWidth.onPointerDown} onKeyDown={panelWidth.onKeyDown} />}
    {isMobile && collapsed ? <div key="compact-toggle" ref={setToggleNode} class="task-pair-status-toggle task-pair-status-compact" role="button" tabIndex={0} aria-expanded={false} aria-label={toggleLabel} title={t('taskPair.panel_expand')} onClick={toggle} onKeyDown={toggleWithKeyboard} onScroll={clampElementScroll}>
      {toggleContent}
    </div> : <button key={collapsed ? 'collapsed-toggle' : 'expanded-toggle'} ref={setToggleNode} type="button" class="task-pair-status-toggle" aria-expanded={!collapsed} aria-label={toggleLabel} title={t(collapsed ? 'taskPair.panel_expand' : 'taskPair.panel_collapse')} onClick={toggle} onScroll={clampElementScroll}>
      {toggleContent}
    </button>}
    {!collapsed && <div key="expanded-body" class="task-pair-status-body"><div class="task-pair-status-rows" data-testid="task-pair-status-rows">
      {(() => { let sequence = 0; return groups.map((group) => {
        const heading = <h4>{TASK_PAIR_WAIT_KINDS.includes(group.key as typeof TASK_PAIR_WAIT_KINDS[number]) ? t(`taskPair.status.${group.key}`) : group.key === 'awaiting_brain_decision' ? t('taskPair.status.awaiting_brain_decision') : t(`taskPair.panel_group_${group.key}`)} <small>({group.rows.length})</small></h4>;
        const content = group.rows.map((row, index) => { const payload = row.payload; const taskIdStr = String(payload.taskId); const sequenceNumber = ++sequence; const queued = group.key === 'queued'; const terminal = TASK_PAIR_TERMINAL_STATUSES.includes(payload.toStatus as TaskPairStatus); const duration = formatTaskDuration({ startedAt: row.startedAt, finishedAt: payload.finishedAt, endedAt: payload.endedAt, updatedAt: row.updatedAt, now, durationMs: payload.durationMs, terminal }, durationUnits); const title = taskPairDisplayTitle(payload.title, taskIdStr, payload.brief) ?? t('taskPair.panel_untitled'); const taskStatus = String(payload.toStatus); const reworkCount = Math.max(1, reworkCounts.get(taskIdStr) ?? 0); const auditRound = Number(payload.round ?? 0); const deliveryRound = Math.max(1, Number(payload.deliveryRound ?? 1)); const canOpenMenu = (canCloseTasks && Boolean(serverId)) || (!isMobile && isTaskPairSplittable(payload) && activeSplitTaskId !== taskIdStr); return <div class={`task-pair-status-row task-pair-chip--${taskStatus}`} data-status={taskStatus} data-task-id={taskIdStr} key={taskIdStr} onContextMenu={(e) => { if (!canOpenMenu) return; e.preventDefault(); e.stopPropagation(); const pos = clampContextMenuPosition(e.clientX, e.clientY, 210, 130); setRowContextMenu({ taskId: taskIdStr, title, status: taskStatus, terminal, payload, x: pos.x, y: pos.y }); }}>
          <span class="task-pair-status-sequence" aria-label={`#${sequenceNumber}`}>{sequenceNumber}</span>
          <div class="task-pair-status-row-head">
            <span class={`task-pair-status-badge task-pair-chip--${taskStatus}`}>
              <span class="task-pair-status-badge-dot" aria-hidden="true" />
              {getTaskPairWaitKind(payload) ? t(`taskPair.status.${getTaskPairWaitKind(payload)}`) : taskStatus === 'rework' ? t('taskPair.panel_rework_count', { count: reworkCount }) : taskStatus === 'working' && deliveryRound > 1 ? t('taskPair.panel_round_in_progress', { round: deliveryRound }) : t(`taskPair.status.${taskStatus}`)}
            </span>
            {!queued && auditRound > 0 && <span class="task-pair-status-round-badge">{deliveryRound > 1 ? t('taskPair.panel_round_of', { delivery: deliveryRound, audit: auditRound }) : t('taskPair.panel_round', { round: auditRound })}</span>}
            {!queued && <span class="task-pair-status-round-badge task-pair-status-blocking-badge">{t('taskPair.blocking', { levels: Array.isArray(payload.blocking) ? payload.blocking.join(',') : 'P0' })}</span>}
            {queued && payload.urgent === true && <span class="task-pair-status-urgent">!</span>}
          </div>
          <strong class="task-pair-status-row-title">{queued && <em>#{Number(payload.queuePosition ?? index + 1)} </em>}{title}</strong>
          {(() => {
            const rowWaitKind = getTaskPairWaitKind(payload);
            if (!rowWaitKind || rowWaitKind === 'resuming') return null;
            const rowScheduling = readPairScheduling(payload.scheduling as TaskPairScheduling | undefined);
            const deps = rowScheduling?.dependsOn ?? [];
            if (!rowScheduling?.note && deps.length === 0) return null;
            return <small class="task-pair-status-row-meta">{rowScheduling?.note}{deps.length > 0 && t('taskPair.waiting_for_tasks', { tasks: formatTaskPairDependencyTasks(deps, taskTitles, rowScheduling?.dependencyTitles) })}</small>;
          })()}
          <TaskPairDecisionPanel taskId={String(payload.taskId)} pair={{ ...payload,
            status: payload.toStatus, flags: payload.flags ?? [], round: payload.round ?? 0,
          } as SupervisionConsolePairInfo} taskTitles={taskTitles} />
          <TaskPairBrief key={JSON.stringify([serverId, scopeSessionId, String(payload.taskId)])} brief={typeof payload.brief === 'string' ? payload.brief : undefined} briefRevision={typeof payload.briefRevision === 'string' ? payload.briefRevision : undefined} checklist={payload.checklist as { total: number; implemented: number; audited: number } | undefined} taskId={String(payload.taskId)} defaultOpen={String(payload.taskId) === String(scopedDefaultTaskId)} />
          {duration !== undefined && <small class="task-pair-status-row-meta"><span class="task-pair-status-row-meta-icon" aria-hidden="true">⏱</span>{Number.isFinite(row.startedAt) && <>{t('taskPair.panel_started', { time: new Date(row.startedAt).toLocaleTimeString() })} · </>}{queued ? t('taskPair.panel_queued', { duration }) : t('taskPair.panel_elapsed', { duration })}</small>}
          <div class="task-pair-status-row-roles">
            <span class="task-pair-role-chip" role="group" aria-label={t('taskPair.panel_executor')}><span class={`task-pair-status-dot ${payload.executorState === 'running' ? 'is-running' : ''}`} />{session(payload.executor, payload.executorLabel, payload.executorModel, payload.executorThinking, 'executor') ?? unassigned(payload.executorModel, payload.executorThinking)}</span>
            {payload.auditor === 'none'
              ? <span class="task-pair-role-chip task-pair-role-chip--muted">{t('taskPair.panel_no_audit')}</span>
              : <span class="task-pair-role-chip" role="group" aria-label={t('taskPair.panel_auditor')}><span class={`task-pair-status-dot ${payload.auditorState === 'running' ? 'is-running' : ''}`} />{session(payload.auditor, payload.auditorLabel, payload.auditorModel, payload.auditorThinking, 'auditor') ?? unassigned(payload.auditorModel, payload.auditorThinking)}</span>}
            {!isMobile && isTaskPairSplittable(payload) && (() => {
              const taskIdStr = String(payload.taskId);
              // The active pair exits from either window's titlebar.
              if (activeSplitTaskId === taskIdStr) return null;
              const splitLabel = t('taskPair.panel_open_split');
              const splitHint = sequenceNumber <= 9 ? `${splitLabel} (${formatTaskPairSplitHint(splitShortcutModifiers, sequenceNumber)})` : splitLabel;
              return (
                <button
                  type="button"
                  class="task-pair-split-btn"
                  title={splitHint}
                  aria-label={splitLabel}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent('deck:pair-split', {
                      detail: {
                        taskId: taskIdStr,
                        title,
                        executor: payload.executor,
                        auditor: payload.auditor,
                        action: 'open',
                      },
                    }));
                  }}
                >
                  <span class="task-pair-split-icon" aria-hidden="true">◫</span>
                  <span class="task-pair-split-text">{t('taskPair.panel_open_split')}</span>
                </button>
              );
            })()}
          </div>
        </div>; });
        return group.key === 'recent'
          ? <details class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}><summary>{heading}</summary>{content}</details>
          : <section class={`task-pair-status-group task-pair-status-group-${group.key}`} key={group.key}>{heading}{content}</section>;
      }); })()}
    </div></div>}
  </aside>;
  const handleConfirmCloseTask = useCallback(async () => {
    const target = closeConfirmTarget;
    if (!target || closeSending || !target.serverId) return;
    setCloseSending(true);
    setCloseError(null);
    try {
      const result = await closeServerTaskPair(target.serverId, target.taskId, {
        action: target.action,
        ...(target.action === 'done' ? { force: true } : {}),
      });
      if (!result.ok) {
        setCloseError(formatTaskPairCloseError(result.error, (k, d) => t(k, d ?? k)));
        return;
      }
      const nextStatus = result.status ?? (target.action === 'done' ? 'done' : 'cancelled');
      const nextUpdatedAt = typeof result.updatedAt === 'number' && Number.isFinite(result.updatedAt)
        ? result.updatedAt
        : Date.now();
      const nextEndedAt = typeof result.endedAt === 'number' && Number.isFinite(result.endedAt)
        ? result.endedAt
        : nextUpdatedAt;
      setOptimisticClosedRows((prev) => {
        const next = new Map(prev);
        next.set(target.taskId, { toStatus: nextStatus, updatedAt: nextUpdatedAt, endedAt: nextEndedAt });
        return next;
      });
      setSnapshotRows((prev) => {
        if (!prev) return prev;
        return prev.map((row) => (
          String(row.taskId) === target.taskId
            ? { ...row, toStatus: nextStatus, updatedAt: nextUpdatedAt, endedAt: nextEndedAt }
            : row
        ));
      });
      setCloseConfirmTarget(null);
      setCloseError(null);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : t('taskMode.cancel_failed', 'Failed to cancel task'));
    } finally {
      setCloseSending(false);
    }
  }, [closeConfirmTarget, closeSending, t]);

  const portalOrPanel = shouldPortalToAnchor && mobileAnchor ? createPortal(panelEl, mobileAnchor) : panelEl;
  const openCloseDialog = (menu: NonNullable<typeof rowContextMenu>, action: TaskPairCloseAction) => {
    if (!serverId) return;
    setCloseError(null);
    setCloseConfirmTarget({
      serverId,
      taskId: menu.taskId,
      title: menu.title,
      action,
      status: menu.status,
    });
  };
  const contextItems: TaskPairContextMenuItem[] = rowContextMenu ? (() => {
    const items: TaskPairContextMenuItem[] = [];
    if (canCloseTasks && serverId) {
      items.push({
        id: 'cancel',
        label: t('taskMode.cancel_task', 'Cancel task'),
        danger: true,
        disabled: rowContextMenu.terminal,
        testId: `task-pair-panel-ctx-cancel-${rowContextMenu.taskId}`,
        onSelect: () => openCloseDialog(rowContextMenu, 'cancel'),
      });
      if (!rowContextMenu.terminal && (rowContextMenu.status === 'passed' || rowContextMenu.status === 'awaiting_brain_decision')) {
        items.push({
          id: 'done',
          label: t('taskMode.close_task_done', 'Close as done'),
          testId: `task-pair-panel-ctx-done-${rowContextMenu.taskId}`,
          onSelect: () => openCloseDialog(rowContextMenu, 'done'),
        });
      }
    }
    if (!isMobile && isTaskPairSplittable(rowContextMenu.payload) && activeSplitTaskId !== rowContextMenu.taskId) {
      items.push({
        id: 'split',
        label: t('taskPair.panel_open_split'),
        testId: `task-pair-panel-ctx-split-${rowContextMenu.taskId}`,
        onSelect: () => {
          window.dispatchEvent(new CustomEvent('deck:pair-split', {
            detail: {
              taskId: rowContextMenu.taskId,
              title: rowContextMenu.title,
              executor: rowContextMenu.payload.executor,
              auditor: rowContextMenu.payload.auditor,
              action: 'open',
            },
          }));
        },
      });
    }
    return items;
  })() : [];

  return <>
    {portalOrPanel}
    {rowContextMenu && (
      <TaskPairContextMenu
        x={rowContextMenu.x}
        y={rowContextMenu.y}
        ariaLabel={rowContextMenu.title}
        items={contextItems}
        onClose={() => setRowContextMenu(null)}
      />
    )}
    <TaskPairCloseConfirmDialog
      target={closeConfirmTarget}
      busy={closeSending}
      error={closeError}
      onCancel={() => {
        if (!closeSending) {
          setCloseConfirmTarget(null);
          setCloseError(null);
        }
      }}
      onConfirm={() => void handleConfirmCloseTask()}
    />
  </>;
}

/** Avoid mounting responsive panel effects in ordinary chats until pair data exists. */
export function TaskPairStatusPanelHost(props: { events: readonly TimelineEvent[]; sessions?: readonly SessionLabelEntry[]; serverId?: string | null; scopeSessionId?: string | null; collapsedVisitKey?: string | null; mobileAnchor?: Element | null; mobileAnchorRef?: { current: Element | null }; visible?: boolean; canCloseTasks?: boolean }) {
  const initialSnapshot = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
  const [active, setActive] = useState(() => hasPairActivity(props.events, props.serverId));
  const [authorityUnavailable, setAuthorityUnavailable] = useState(() => (
    isAcceptedPanelSnapshot(initialSnapshot, props.serverId) && Boolean(initialSnapshot?.authorityUnavailable)
  ));
  const [resolvedMobileAnchor, setResolvedMobileAnchor] = useState<Element | null>(() => props.mobileAnchor ?? props.mobileAnchorRef?.current ?? null);
  useLayoutEffect(() => {
    const anchor = props.mobileAnchor ?? props.mobileAnchorRef?.current ?? null;
    if (anchor !== resolvedMobileAnchor) setResolvedMobileAnchor(anchor);
  });
  useEffect(() => {
    if (!active && hasPairActivity(props.events, props.serverId)) {
      setActive(true);
    }
  }, [active, props.events, props.serverId]);
  useEffect(() => {
    const applySnapshot = (detail: TaskPairConsoleSnapshotDetail | undefined) => {
      if (!detail || !isAcceptedPanelSnapshot(detail, props.serverId)) return;
      if (detail.scopeReset) {
        setActive(true);
        setAuthorityUnavailable(true);
        return;
      }
      if ((Array.isArray(detail.tasks) && detail.tasks.length > 0) || detail.op === 'task_upsert' || detail.task) {
        if (Array.isArray(detail.tasks)) (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = detail;
        setActive(true);
      } else if (Array.isArray(detail.tasks)) {
        (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = detail;
      }
      if ('authorityUnavailable' in detail) {
        setAuthorityUnavailable(Boolean(detail.authorityUnavailable));
        setActive(true);
      } else if (Array.isArray(detail.tasks)) {
        setAuthorityUnavailable(false);
      }
    };
    const current = (window as Window & { __imcodesTaskPairSnapshot?: TaskPairConsoleSnapshotDetail }).__imcodesTaskPairSnapshot;
    if (current && !current.scopeReset) applySnapshot(current);
    const onSnapshot = (event: Event) => {
      applySnapshot((event as CustomEvent).detail as TaskPairConsoleSnapshotDetail | undefined);
    };
    window.addEventListener('supervision:task-pairs', onSnapshot);
    return () => window.removeEventListener('supervision:task-pairs', onSnapshot);
  }, [props.serverId]);
  if (!active) return null;
  // Owner rule: load silently, never cover the chat. While the authoritative
  // snapshot for a new scope is pending (or unavailable), render nothing: stale
  // rows from the previous scope must not show, and no full-size placeholder
  // box may cover the conversation. The panel reappears with fresh data.
  if (authorityUnavailable) return null;
  const { mobileAnchor, mobileAnchorRef, ...panelProps } = props;
  // Portal only when mobile or collapsed (so collapsed strips sit in .chat-titlebar
  // flex flow and mobile inline/fullscreen anchors against .chat-titlebar). Desktop
  // expanded panels render directly inside .chat-main so bottom: 0 fills full height.
  return <TaskPairStatusPanel {...panelProps} mobileAnchor={resolvedMobileAnchor} />;
}
