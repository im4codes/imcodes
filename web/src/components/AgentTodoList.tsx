/**
 * AgentTodoList — a compact, live checklist of the agent's current task list.
 *
 * Reads the session's timeline events and renders the LATEST TodoWrite /
 * todo_write / update_plan / plan list (see ../timeline/agent-todos.ts) as a
 * pinned, auto-updating checklist. It:
 *   - hides once every item is completed,
 *   - auto-expires when the list goes stale (turn ended a while ago, or a hard
 *     cap) so an abandoned list never lingers forever,
 *   - can be collapsed to just its header (preference persisted), so it never
 *     gets in the way when the user doesn't want to see it.
 */
import { useMemo, useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent } from '../ws-client.js';
import { isRunningSessionState } from '../thinking-utils.js';
import {
  deriveLatestTodoList,
  countCompleted,
  TODO_LIST_IDLE_GRACE_MS,
  TODO_LIST_HARD_MAX_MS,
  type AgentTodoStatus,
} from '../timeline/agent-todos.js';

const STATUS_ICON: Record<AgentTodoStatus, string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
};

const COLLAPSE_KEY = 'imcodes:todosCollapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

interface Props {
  events: readonly TimelineEvent[];
  sessionState?: string;
}

export function AgentTodoList({ events, sessionState }: Props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [, setTick] = useState(0);
  const list = useMemo(() => deriveLatestTodoList(events), [events]);

  // Re-evaluate staleness on a slow tick so an abandoned list auto-expires even
  // when no new events arrive.
  useEffect(() => {
    if (!list) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [list]);

  if (!list) return null;

  const total = list.items.length;
  const done = countCompleted(list.items);
  if (total > 0 && done === total) return null; // every task done → hide

  const age = Date.now() - list.ts;
  if (age > TODO_LIST_HARD_MAX_MS) return null; // wedged turn safety cap
  if (!isRunningSessionState(sessionState) && age > TODO_LIST_IDLE_GRACE_MS) return null; // idle + stale → expire

  const toggle = (): void => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div class={`agent-todos${collapsed ? ' agent-todos-collapsed' : ''}`}>
      <button
        type="button"
        class="agent-todos-header"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={collapsed ? t('todos.expand') : t('todos.collapse')}
      >
        <span class="agent-todos-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span class="agent-todos-title">{t('todos.title')}</span>
        <span class="agent-todos-count">{t('todos.progress', { done, total })}</span>
      </button>
      {!collapsed && (
        <ul class="agent-todos-list">
          {list.items.map((item, idx) => (
            <li key={`${list.eventId}:${idx}`} class={`agent-todos-item agent-todos-item-${item.status}`}>
              <span class="agent-todos-icon" aria-hidden="true">{STATUS_ICON[item.status]}</span>
              <span class="agent-todos-text">{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
